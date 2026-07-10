#!/usr/bin/env node
// Render an HTML slide deck to a .pptx with headless Chromium (Playwright) —
// no Electron/desktop runtime required. Two modes:
//
//   default      screenshot mode — one pixel-perfect PNG per slide, assembled
//                with PptxGenJS ("exactly what you see", not editable).
//   --editable   editable mode — inject the vendored dom-to-pptx browser
//                engine (ships with this skill under assets/) and emit native
//                PowerPoint shapes/text instead of images.
//
// Slide detection, presenter-chrome hiding, stage measurement/pinning, the
// show-slide/restack paging semantics, and the editable dom-to-pptx handoff
// are ported from the desktop export path
// (apps/desktop/src/main/deck-capture.ts) so this produces the same deck the
// desktop app would.
//
// usage: node render-pptx.mjs [--editable] <input.html> [output.pptx]
// env:   OD_PPTX_SCALE  device scale factor for capture (default 1; 2 = crisper, slower)
//
// Exit codes: 0 ok, 2 usage, 3 input not found, 4 no slide surfaces (not a
// deck), 5 editable engine missing or failed (retry without --editable for
// the screenshot fallback).

import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

// pptxgenjs 4.x points its ESM `exports` entry at a .js file that is not
// marked as a module — `import` breaks on Node < 22 (no syntax detection),
// which is what sandbox images ship. The CJS entry loads everywhere.
const require = createRequire(import.meta.url);
const PptxGenJS = require('pptxgenjs');

// Mirrors deck-capture.ts: the slide-surface family across deck conventions.
const SLIDE_SELECTOR = '.slide, [data-screen-label], .deck-slide, .ppt-slide';
// Presenter clones that must never count as real slides.
const CLONE_ANCESTORS = '.mini-slide, .overview, .notes-overlay, .thumb';
// Live-deck chrome (progress bar, nav hints, speaker notes) hidden before capture.
const HIDE_CHROME_SELECTOR =
  '.progress-bar, .notes-overlay, aside.notes, .speaker-notes, .deck-nav, .deck-hint, .deck-counter';
const SLIDE_W = 1920;
const SLIDE_H = 1080;
const SLIDE_MIN_PX = 320;
const SLIDE_MAX_PX = 8192;
const PX_PER_INCH = 96;

const argv = process.argv.slice(2);
const editable = argv.includes('--editable');
const [inputArg, outputArg] = argv.filter((a) => a !== '--editable');
if (!inputArg) {
  console.error('usage: node render-pptx.mjs [--editable] <input.html> [output.pptx]');
  process.exit(2);
}
// Accept a served URL too (see SKILL.md troubleshooting: decks whose relative
// assets fail from file:// can be exported through a local static server).
const isUrl = /^https?:\/\//i.test(inputArg);
const input = isUrl ? inputArg : path.resolve(inputArg);
if (!isUrl && !fs.existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(3);
}
if (isUrl && !outputArg) {
  console.error('an explicit output .pptx path is required when the input is a URL');
  process.exit(2);
}
const output = path.resolve(outputArg || input.replace(/\.html?$/i, '') + '.pptx');
const scale = Number(process.env.OD_PPTX_SCALE) >= 2 ? 2 : 1;

// Editable mode: the vendored dom-to-pptx browser UMD ships with this skill
// (assets/dom-to-pptx.bundle.js.gz). Resolve it next to this script (the
// workspace copy) or in the sibling assets/ directory (running in place from
// the staged skill root).
function loadDomToPptxEngine() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'dom-to-pptx.bundle.js.gz'),
    path.join(here, 'dom-to-pptx.bundle.js'),
    path.join(here, '..', 'assets', 'dom-to-pptx.bundle.js.gz'),
    path.join(here, '..', 'assets', 'dom-to-pptx.bundle.js'),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const bytes = fs.readFileSync(candidate);
    return candidate.endsWith('.gz') ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8');
  }
  return null;
}

// Prefer a system-installed Chromium (sandbox images bake a musl build in —
// the Playwright-downloaded browser is glibc-only and cannot run on Alpine).
const systemChromium =
  process.env.OD_PPTX_CHROMIUM ||
  ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ||
  null;

// Forward the sandbox's egress proxy (if any) so decks that reference remote
// webfonts/images still load them; file:// navigation is unaffected.
const proxyServer =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  null;
const proxyBypass = process.env.NO_PROXY || process.env.no_proxy || undefined;

const t0 = Date.now();
const browser = await chromium.launch({
  ...(systemChromium ? { executablePath: systemChromium } : {}),
  ...(proxyServer ? { proxy: { server: proxyServer, bypass: proxyBypass } } : {}),
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--force-color-profile=srgb',
    '--hide-scrollbars',
    '--font-render-hinting=none',
    // Sandbox runtimes cap the whole container (opencode + this script +
    // Chromium) at ~1GiB; without these the OOM killer takes the run down.
    '--disable-gpu',
    '--no-zygote',
    '--renderer-process-limit=1',
    '--disable-extensions',
    '--disable-background-networking',
    '--aggressive-cache-discard',
    '--js-flags=--max-old-space-size=256',
  ],
});
let shotsDir = null;
try {
  const context = await browser.newContext({
    viewport: { width: SLIDE_W, height: SLIDE_H },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  await page.goto(isUrl ? input : pathToFileURL(input).href, { waitUntil: 'load', timeout: 60_000 });

  // Fonts, <img>s, and CSS background images must settle before any capture
  // (ported from pdf-export.ts waitForPrintableContent).
  await page.evaluate(async () => {
    const waitImages = Promise.all(
      Array.from(document.images || []).map((img) =>
        img.complete
          ? Promise.resolve()
          : new Promise((r) => {
              img.addEventListener('load', r, { once: true });
              img.addEventListener('error', r, { once: true });
            }),
      ),
    );
    const cssUrls = new Set();
    for (const el of document.querySelectorAll('*')) {
      const style = getComputedStyle(el);
      for (const value of [style.backgroundImage, style.borderImageSource, style.listStyleImage]) {
        if (!value || value === 'none') continue;
        value.replace(/url\((['"]?)(.*?)\1\)/g, (_, _q, url) => {
          if (url && !/^data:/i.test(url)) cssUrls.add(url);
          return '';
        });
      }
    }
    const waitCss = Promise.all(
      Array.from(cssUrls).map(
        (url) =>
          new Promise((r) => {
            const img = new Image();
            img.onload = r;
            img.onerror = r;
            img.src = url;
          }),
      ),
    );
    const fonts = document.fonts?.ready?.catch(() => {}) ?? Promise.resolve();
    await Promise.all([fonts, waitImages, waitCss]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const tLoad = Date.now();

  const count = await page.evaluate(
    ([selector, cloneAncestors]) =>
      Array.from(document.querySelectorAll(selector)).filter((el) => !el.closest(cloneAncestors))
        .length,
    [SLIDE_SELECTOR, CLONE_ANCESTORS],
  );
  if (!Number.isInteger(count) || count < 1) {
    console.error('no slide surfaces found — this file does not render as a deck');
    process.exit(4);
  }

  // Deck prep: hide presenter chrome, stop <deck-stage> fit-to-viewport scaling
  // (`noscale`), freeze animations/transitions at their final state.
  await page.evaluate((hideSelector) => {
    document.querySelectorAll(hideSelector).forEach((el) => {
      el.style.setProperty('display', 'none', 'important');
    });
    document.querySelectorAll('deck-stage').forEach((el) => el.setAttribute('noscale', ''));
    const s = document.createElement('style');
    s.textContent =
      '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}';
    (document.head || document.documentElement).appendChild(s);
  }, HIDE_CHROME_SELECTOR);

  // Measure the authored slide box (decks are not always 16:9) and pin the
  // stage to it so every slide captures deterministically at 1:1.
  const measured = await page.evaluate(
    ([selector, cloneAncestors]) => {
      const positive = (value) => {
        if (typeof value === 'number') return Number.isFinite(value) && value > 1 ? value : null;
        if (typeof value !== 'string') return null;
        const m = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(value.trim());
        const n = m ? Number(m[1]) : NaN;
        return Number.isFinite(n) && n > 1 ? n : null;
      };
      const pair = (w, h) => {
        const width = positive(w);
        const height = positive(h);
        return width != null && height != null ? { w: width, h: height } : null;
      };
      const authored = (el) => {
        const stage = el.closest('deck-stage');
        if (stage) {
          const byProp = pair(stage.designWidth, stage.designHeight);
          if (byProp) return byProp;
          const byAttr = pair(stage.getAttribute('width'), stage.getAttribute('height'));
          if (byAttr) return byAttr;
        }
        return (
          pair(el.getAttribute('width'), el.getAttribute('height')) ||
          pair(el.style?.width, el.style?.height) ||
          pair(getComputedStyle(el).width, getComputedStyle(el).height) ||
          pair(el.offsetWidth, el.offsetHeight)
        );
      };
      const slides = Array.from(document.querySelectorAll(selector)).filter(
        (el) => !el.closest(cloneAncestors),
      );
      for (const el of slides) {
        const size = authored(el);
        if (size) return size;
        const r = el.getBoundingClientRect();
        if (r.width > 1 && r.height > 1) return { w: r.width, h: r.height };
      }
      return null;
    },
    [SLIDE_SELECTOR, CLONE_ANCESTORS],
  );
  const stage =
    measured &&
    measured.w >= SLIDE_MIN_PX &&
    measured.w <= SLIDE_MAX_PX &&
    measured.h >= SLIDE_MIN_PX &&
    measured.h <= SLIDE_MAX_PX
      ? { w: Math.round(measured.w), h: Math.round(measured.h) }
      : { w: SLIDE_W, h: SLIDE_H };
  await page.setViewportSize({ width: stage.w, height: stage.h });
  await page.evaluate((s) => {
    const style = document.createElement('style');
    style.textContent =
      `html,body{margin:0!important;padding:0!important;width:${s.w}px!important;height:${s.h}px!important;overflow:hidden!important}` +
      `.deck,deck-stage{width:${s.w}px!important;height:${s.h}px!important}`;
    document.head.appendChild(style);
  }, stage);
  const tPrepare = Date.now();

  // Editable mode: hand the live, laid-out slides to the vendored dom-to-pptx
  // engine (native shapes/text) instead of capturing images. Ported from the
  // desktop path (deck-capture.ts showAllSlides + runDomToPptx).
  if (editable) {
    const engine = loadDomToPptxEngine();
    if (!engine) {
      console.error(
        'dom-to-pptx engine bundle not found — copy assets/dom-to-pptx.bundle.js.gz from the skill root next to this script',
      );
      process.exit(5);
    }
    // dom-to-pptx measures each element's live layout, so every real slide
    // must be laid out simultaneously (stacked at the origin, opacity 1) —
    // decks normally render only the active one, which would give the others
    // no layout box.
    await page.evaluate(
      ([selector, cloneAncestors]) => {
        const slides = Array.from(document.querySelectorAll(selector)).filter(
          (el) => !el.closest(cloneAncestors),
        );
        for (const el of slides) {
          el.style.setProperty('opacity', '1', 'important');
          el.style.setProperty('visibility', 'visible', 'important');
          el.style.setProperty('position', 'absolute', 'important');
          el.style.setProperty('left', '0', 'important');
          el.style.setProperty('top', '0', 'important');
          ['active', 'visible', 'is-active', 'current'].forEach((c) => el.classList.add(c));
        }
        return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      },
      [SLIDE_SELECTOR, CLONE_ANCESTORS],
    );
    await page.addScriptTag({ content: engine });
    const out = await page.evaluate(
      async ([selector, cloneAncestors]) => {
        function isTransparentColor(input) {
          const value = input.trim().toLowerCase();
          return value === '' || value === 'transparent' || value === 'rgba(0, 0, 0, 0)';
        }
        function firstCssColor(input) {
          const rgb = input.match(/rgba?\([^)]*\)/i);
          if (rgb) return rgb[0];
          const hex = input.match(/#[0-9a-f]{3,8}\b/i);
          return hex ? hex[0] : null;
        }
        // The slide's effective background often lives on an ancestor (body,
        // .deck). dom-to-pptx only sees the slide subtree, so materialize that
        // background INTO each slide as an explicit backdrop layer.
        function effectiveBackgroundStyle(slide) {
          const candidates = [];
          for (let el = slide; el; el = el.parentElement) candidates.push(el);
          if (document.body && !candidates.includes(document.body)) candidates.push(document.body);
          if (document.documentElement && !candidates.includes(document.documentElement)) {
            candidates.push(document.documentElement);
          }
          for (const el of candidates) {
            const style = getComputedStyle(el);
            const bgColor = style.backgroundColor;
            const bgImage = style.backgroundImage;
            const hasImage = bgImage && bgImage !== 'none';
            const hasColor = bgColor && !isTransparentColor(bgColor);
            const fallbackColor = hasColor ? bgColor : firstCssColor(bgImage);
            if (!hasImage && !hasColor) continue;
            if (!fallbackColor) continue;
            return {
              color: fallbackColor,
              image: bgImage,
              position: style.backgroundPosition,
              size: style.backgroundSize,
              repeat: style.backgroundRepeat,
              origin: style.backgroundOrigin,
              clip: style.backgroundClip,
            };
          }
          return null;
        }
        function ensureExplicitSlideBackgrounds(slides) {
          for (const slide of slides) {
            slide.querySelectorAll(':scope > [data-od-pptx-bg]').forEach((el) => el.remove());
            const background = effectiveBackgroundStyle(slide);
            if (!background) continue;
            const bg = document.createElement('div');
            bg.setAttribute('data-od-pptx-bg', 'true');
            bg.setAttribute('aria-hidden', 'true');
            bg.style.setProperty('position', 'absolute', 'important');
            bg.style.setProperty('inset', '0', 'important');
            bg.style.setProperty('z-index', '0', 'important');
            bg.style.setProperty('pointer-events', 'none', 'important');
            bg.style.setProperty('background-color', background.color, 'important');
            bg.style.setProperty('background-image', background.image, 'important');
            bg.style.setProperty('background-position', background.position, 'important');
            bg.style.setProperty('background-size', background.size, 'important');
            bg.style.setProperty('background-repeat', background.repeat, 'important');
            bg.style.setProperty('background-origin', background.origin, 'important');
            bg.style.setProperty('background-clip', background.clip, 'important');
            const style = getComputedStyle(slide);
            if (style.position === 'static') slide.style.setProperty('position', 'relative', 'important');
            if (style.overflow === 'visible') slide.style.setProperty('overflow', 'hidden', 'important');
            slide.style.setProperty('background-color', background.color, 'important');
            Array.from(slide.children).forEach((child) => {
              if (child.getAttribute('data-od-pptx-bg') === 'true') return;
              const childStyle = getComputedStyle(child);
              if (childStyle.position === 'static') {
                child.style.setProperty('position', 'relative', 'important');
              }
              if (childStyle.zIndex === 'auto') {
                child.style.setProperty('z-index', '1', 'important');
              }
            });
            slide.prepend(bg);
          }
        }
        // Hero/display text set at line-height:1 measures ambiguously; pin its
        // box and center via flex so dom-to-pptx places it like the browser did.
        function stabilizeLargeSingleLineText(slides) {
          for (const slide of slides) {
            slide.querySelectorAll('*').forEach((el) => {
              const rawText = el.innerText || el.textContent || '';
              const text = rawText.replace(/\s+/g, ' ').trim();
              if (!text || rawText.includes('\n')) return;
              const style = getComputedStyle(el);
              const fontSizePx = Number.parseFloat(style.fontSize);
              if (!Number.isFinite(fontSizePx) || fontSizePx < 96) return;
              const lineHeightPx = Number.parseFloat(style.lineHeight);
              if (!Number.isFinite(lineHeightPx) || lineHeightPx <= 0 || lineHeightPx > fontSizePx * 1.05) return;
              const rect = el.getBoundingClientRect();
              if (rect.width <= 1 || rect.height <= 1) return;
              const justify =
                style.textAlign === 'center' || style.textAlign === '-webkit-center'
                  ? 'center'
                  : style.textAlign === 'right' || style.textAlign === 'end'
                    ? 'flex-end'
                    : 'flex-start';
              el.style.setProperty('display', 'flex', 'important');
              el.style.setProperty('align-items', 'center', 'important');
              el.style.setProperty('justify-content', justify, 'important');
              el.style.setProperty('width', `${rect.width}px`, 'important');
              el.style.setProperty('height', `${rect.height}px`, 'important');
              el.style.setProperty('line-height', 'normal', 'important');
              el.style.setProperty('white-space', 'nowrap', 'important');
              el.style.setProperty('overflow', 'visible', 'important');
            });
          }
        }
        try {
          if (!window.domToPptx || typeof window.domToPptx.exportToPptx !== 'function') {
            return { error: 'dom-to-pptx engine did not load' };
          }
          const slides = Array.from(document.querySelectorAll(selector)).filter(
            (el) => !el.closest(cloneAncestors),
          );
          if (slides.length === 0) return { error: 'no slides to export' };
          ensureExplicitSlideBackgrounds(slides);
          stabilizeLargeSingleLineText(slides);
          // dom-to-pptx assumes `node.className` is a string, but SVG elements
          // expose an SVGAnimatedString, so its DOM walk throws on decks
          // containing inline SVG. Normalize those to a plain string.
          document.querySelectorAll('*').forEach((el) => {
            const cn = el.className;
            if (cn != null && typeof cn !== 'string') {
              try {
                Object.defineProperty(el, 'className', {
                  value: cn.baseVal ?? '',
                  configurable: true,
                  writable: true,
                });
              } catch {
                // Leave it; dom-to-pptx may still handle this node.
              }
            }
          });
          const blob = await window.domToPptx.exportToPptx(slides, {
            fileName: 'deck.pptx',
            skipDownload: true,
            autoEmbedFonts: true,
            svgAsVector: true,
          });
          if (!blob || typeof blob.arrayBuffer !== 'function') {
            return { error: 'dom-to-pptx returned no blob' };
          }
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          const CHUNK = 0x8000;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
          }
          return { b64: btoa(binary) };
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) };
        }
      },
      [SLIDE_SELECTOR, CLONE_ANCESTORS],
    );
    if (!out || out.error || !out.b64) {
      console.error(`editable export failed: ${(out && out.error) || 'engine returned no output'}`);
      process.exit(5);
    }
    await browser.close();
    fs.writeFileSync(output, Buffer.from(out.b64, 'base64'));
    const end = Date.now();
    console.log(
      `ok: ${output} (${count} slides, ${stage.w}x${stage.h}, editable) ` +
        `load=${tLoad - t0}ms prepare=${tPrepare - tLoad}ms convert=${end - tPrepare}ms total=${end - t0}ms`,
    );
    // Browser already closed and no shots dir was created — exit directly.
    process.exit(0);
  }

  // Show slide i via the common active-slide conventions, settle two frames,
  // and — when the deck positions the active slide off the capture viewport
  // (translated carousel strips) — overlay a capture-only clone at the origin.
  const showSlide = async (i) => {
    const rect = await page.evaluate(
      ([selector, cloneAncestors, index]) => {
        document.getElementById('__od_export_active_slide_capture')?.remove();
        const slides = Array.from(document.querySelectorAll(selector)).filter(
          (el) => !el.closest(cloneAncestors),
        );
        const activeClasses = ['active', 'visible', 'is-active', 'current'];
        slides.forEach((el, k) => {
          const on = k === index;
          el.style.transition = 'none';
          el.style.animation = 'none';
          el.style.opacity = on ? '1' : '0';
          el.style.visibility = on ? 'visible' : 'hidden';
          el.style.pointerEvents = on ? 'auto' : 'none';
          el.style.zIndex = on ? '999' : '0';
          activeClasses.forEach((c) => el.classList.toggle(c, on));
        });
        return new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              const el = slides[index];
              if (!el) return resolve(null);
              const r = el.getBoundingClientRect();
              resolve({ x: r.x, y: r.y, w: r.width, h: r.height });
            }),
          ),
        );
      },
      [SLIDE_SELECTOR, CLONE_ANCESTORS, i],
    );
    const onStage =
      rect != null &&
      Math.abs(rect.x) <= 2 &&
      Math.abs(rect.y) <= 2 &&
      rect.w >= stage.w * 0.5 &&
      rect.h >= stage.h * 0.5;
    if (!onStage) {
      await page.evaluate(
        ([selector, cloneAncestors, index, w, h]) => {
          document.getElementById('__od_export_active_slide_capture')?.remove();
          const slides = Array.from(document.querySelectorAll(selector)).filter(
            (el) => !el.closest(cloneAncestors),
          );
          const el = slides[index];
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const layer = document.createElement('div');
          layer.id = '__od_export_active_slide_capture';
          layer.setAttribute('aria-hidden', 'true');
          layer.style.cssText =
            ['position:fixed', 'left:0', 'top:0', `width:${w}px`, `height:${h}px`, 'margin:0', 'padding:0', 'overflow:hidden', 'z-index:2147483647', 'pointer-events:none'].join('!important;') + '!important';
          const offset = document.createElement('div');
          offset.style.cssText =
            ['position:absolute', 'left:0', 'top:0', `width:${w}px`, `height:${h}px`, `transform:translate(${-rect.x}px, ${-rect.y}px)`, 'transform-origin:top left'].join('!important;') + '!important';
          const clone = el.cloneNode(true);
          clone.style.setProperty('opacity', '1', 'important');
          clone.style.setProperty('visibility', 'visible', 'important');
          clone.style.setProperty('pointer-events', 'none', 'important');
          clone.style.setProperty('z-index', '2147483647', 'important');
          offset.appendChild(clone);
          layer.appendChild(offset);
          document.body.appendChild(layer);
          return new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        [SLIDE_SELECTOR, CLONE_ANCESTORS, i, stage.w, stage.h],
      );
    }
  };

  // Memory choreography for ~1GiB sandboxes: capture every slide to DISK
  // first, close Chromium, and only then assemble the .pptx — the browser
  // (hundreds of MB) and the zip build never coexist, and no slide bitmap is
  // held in this process's heap while the next slide renders.
  shotsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-pptx-shots-'));
  // Best-effort per-slide cache purge: a critical memory-pressure signal makes
  // Chromium drop decoded images and other reclaimable caches between slides.
  const cdp = await page.context().newCDPSession(page).catch(() => null);
  const shots = [];
  for (let i = 0; i < count; i++) {
    await showSlide(i);
    const shot = path.join(shotsDir, `slide-${i + 1}.png`);
    await page.screenshot({
      clip: { x: 0, y: 0, width: stage.w, height: stage.h },
      type: 'png',
      path: shot,
    });
    shots.push(shot);
    await cdp?.send('Memory.simulatePressureNotification', { level: 'critical' }).catch(() => {});
    console.log(`slide ${i + 1}/${count} captured`);
  }
  const tRender = Date.now();
  await browser.close();

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'OD', width: stage.w / PX_PER_INCH, height: stage.h / PX_PER_INCH });
  pptx.layout = 'OD';
  for (const shot of shots) {
    pptx.addSlide().addImage({
      path: shot,
      x: 0,
      y: 0,
      w: stage.w / PX_PER_INCH,
      h: stage.h / PX_PER_INCH,
    });
  }
  await pptx.writeFile({ fileName: output });
  const end = Date.now();
  console.log(
    `ok: ${output} (${count} slides, ${stage.w}x${stage.h}) ` +
      `load=${tLoad - t0}ms prepare=${tPrepare - tLoad}ms render=${tRender - tPrepare}ms write=${end - tRender}ms total=${end - t0}ms`,
  );
} finally {
  await browser.close(); // no-op when already closed before assembly
  if (shotsDir) fs.rmSync(shotsDir, { recursive: true, force: true });
}
