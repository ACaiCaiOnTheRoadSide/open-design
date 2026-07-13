#!/usr/bin/env node
// Render an HTML artifact to a single full-page image with headless Chromium
// (Playwright) — no Electron/desktop runtime required.
//
//   ordinary page   one full-page screenshot (the whole scrollable document,
//                   top to bottom — NEVER just the visible viewport).
//   slide deck      every slide captured pixel-perfect and stitched vertically
//                   into one long image, matching the built-in desktop export.
//
// Slide detection, presenter-chrome hiding, stage measurement/pinning, and the
// show-slide/restack paging semantics are the same as the html-to-pptx skill's
// render-pptx.mjs (both port apps/desktop/src/main/deck-capture.ts).
//
// usage: node render-image.mjs [--format png|jpeg|webp] [--quality 1-100] <input.html> [output]
// env:   OD_IMAGE_SCALE   device scale factor for capture (default 1; 2 = crisper, slower)
//        OD_IMAGE_WIDTH   viewport width for ordinary pages (default 1440)
//        OD_PPTX_CHROMIUM browser binary (written into env.sh by setup-env.sh —
//                         the workspace is shared with the html-to-pptx skill)
//
// Exit codes: 0 ok, 2 usage, 3 input not found, 6 browser failed to launch
// (environment not prepared — run the skill's scripts/setup-env.sh and source
// the env.sh it writes; do not install a browser by hand), 7 output image
// would exceed encoder limits (page/deck too tall — report it, offer PDF).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

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
// Chromium's software rasterizer and canvas encoder both fall over past
// ~30k device pixels on a side; refuse loudly instead of emitting a clipped
// or blank image that LOOKS like a successful export.
const MAX_OUTPUT_SIDE_PX = 30000;
// WebP itself caps dimensions at 16383 per side (VP8's 14-bit size fields) —
// Chromium's encoder silently falls back to PNG beyond that, so a webp export
// must be refused earlier than the generic side limit.
const WEBP_MAX_SIDE_PX = 16383;
// Per-side checks alone let an 8192-wide deck × 30000 tall through — a ~1GB
// render bitmap that OOM-kills the ~1GiB sandbox. Cap the total area too
// (80M px ≈ 320MB RGBA), which still clears any realistic 1920-wide deck.
const MAX_OUTPUT_AREA_PX = 80_000_000;

const FORMATS = {
  png: { ext: 'png', mime: 'image/png' },
  jpeg: { ext: 'jpg', mime: 'image/jpeg' },
  webp: { ext: 'webp', mime: 'image/webp' },
};

const argv = process.argv.slice(2);
const positional = [];
let format = 'png';
let quality = 92;
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--format') {
    const value = String(argv[++i] ?? '').toLowerCase();
    format = value === 'jpg' ? 'jpeg' : value;
  } else if (arg.startsWith('--format=')) {
    const value = arg.slice('--format='.length).toLowerCase();
    format = value === 'jpg' ? 'jpeg' : value;
  } else if (arg === '--quality') {
    quality = Number(argv[++i]);
  } else if (arg.startsWith('--quality=')) {
    quality = Number(arg.slice('--quality='.length));
  } else {
    positional.push(arg);
  }
}
const spec = FORMATS[format];
const [inputArg, outputArg] = positional;
if (!inputArg || !spec || !(Number.isFinite(quality) && quality >= 1 && quality <= 100)) {
  console.error('usage: node render-image.mjs [--format png|jpeg|webp] [--quality 1-100] <input.html> [output]');
  process.exit(2);
}
// Accept a served URL too (see SKILL.md troubleshooting: pages whose relative
// assets fail from file:// can be exported through a local static server).
const isUrl = /^https?:\/\//i.test(inputArg);
const input = isUrl ? inputArg : path.resolve(inputArg);
if (!isUrl && !fs.existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(3);
}
if (isUrl && !outputArg) {
  console.error('an explicit output path is required when the input is a URL');
  process.exit(2);
}
const output = path.resolve(outputArg || input.replace(/\.html?$/i, '') + `.${spec.ext}`);
const scale = Number(process.env.OD_IMAGE_SCALE) >= 2 ? 2 : 1;
const pageWidth = (() => {
  const w = Number(process.env.OD_IMAGE_WIDTH);
  return Number.isFinite(w) && w >= SLIDE_MIN_PX && w <= SLIDE_MAX_PX ? Math.round(w) : 1440;
})();

// Prefer a system-installed Chromium (sandbox images bake a musl build in —
// the Playwright-downloaded browser is glibc-only and cannot run on Alpine).
const systemChromium =
  process.env.OD_PPTX_CHROMIUM ||
  ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((p) =>
    fs.existsSync(p),
  ) ||
  null;

// Forward the sandbox's egress proxy (if any) so pages that reference remote
// webfonts/images still load them; file:// navigation is unaffected.
const proxyServer =
  process.env.HTTPS_PROXY ||
  process.env.https_proxy ||
  process.env.HTTP_PROXY ||
  process.env.http_proxy ||
  null;
const proxyBypass = process.env.NO_PROXY || process.env.no_proxy || undefined;

const t0 = Date.now();
// Launch failures are an environment problem, not a page problem — the prose
// layers (SKILL.md, export prompt) can be bypassed or fall out of a compacted
// context, so the guidance must also live here, on the only path every export
// executes. Do NOT "fix" a relocation error by installing dependencies: it
// means a glibc browser on a musl system, and only setup-env.sh's bundle can
// resolve that.
async function launchOrExplain(options) {
  try {
    return await chromium.launch(options);
  } catch (err) {
    const msg = String((err && err.message) || err);
    console.error(`chromium failed to launch: ${msg.split('\n')[0]}`);
    if (/Error relocating|error while loading shared libraries/i.test(msg)) {
      console.error(
        'a glibc browser is being run on a musl (Alpine) system — installing dependencies can never fix this. ' +
          "Run: OD_PPTX_FORCE_BUNDLE=1 sh <skill-root>/scripts/setup-env.sh, then source /tmp/od-pptx-export/env.sh and retry.",
      );
    } else {
      console.error(
        "environment not prepared for this system — run the skill's bundled setup script " +
          '(sh <skill-root>/scripts/setup-env.sh), then source /tmp/od-pptx-export/env.sh in the same command and retry. ' +
          'Do not install a browser by hand.',
      );
    }
    process.exit(6);
  }
}
const browser = await launchOrExplain({
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

// Fonts, <img>s, and CSS background images must settle before any capture
// (ported from pdf-export.ts waitForPrintableContent).
async function waitForPrintableContent(page) {
  await page.evaluate(async () => {
    // A no-scroll capture never brings below-fold lazy images into view, so
    // they would stay unloaded (and an incomplete <img> stalls the wait
    // below forever). Force eager so they load and are awaited like the rest.
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
      img.loading = 'eager';
    });
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
}

// Freeze animations/transitions at their final state so the capture is
// deterministic (entrance animations otherwise race the screenshot).
async function freezeAnimations(page) {
  await page.evaluate(() => {
    const s = document.createElement('style');
    s.textContent =
      '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important;transition-delay:0s!important}';
    (document.head || document.documentElement).appendChild(s);
  });
}

// Re-encode a PNG file as webp/jpeg with the page's canvas encoder. Bytes are
// shuttled as data URLs (never file:// reads) so the canvas is never tainted.
async function encodeViaCanvas(page, srcPngPath, outPath, mime, q) {
  const b64 = fs.readFileSync(srcPngPath).toString('base64');
  const result = await page.evaluate(
    async ([data, targetMime, targetQuality]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { error: 'canvas is not available' };
      if (targetMime === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(img, 0, 0);
      const dataUrl = canvas.toDataURL(targetMime, targetQuality);
      if (!dataUrl.startsWith(`data:${targetMime}`)) {
        return { error: `browser encoded ${dataUrl.slice(5, dataUrl.indexOf(';'))} instead of ${targetMime}` };
      }
      return { b64: dataUrl.slice(dataUrl.indexOf(',') + 1) };
    },
    [b64, mime, q / 100],
  );
  if (!result || result.error || !result.b64) {
    throw new Error(`re-encode to ${mime} failed: ${(result && result.error) || 'no output'}`);
  }
  fs.writeFileSync(outPath, Buffer.from(result.b64, 'base64'));
}

// Capture `page` full-page into `outPath` honoring the requested format.
// Playwright screenshots encode png/jpeg natively; webp goes through a PNG
// capture + in-page canvas re-encode.
async function captureFullPage(page, outPath, tmpDir) {
  if (format === 'webp') {
    const tmpPng = path.join(tmpDir, 'full-page.png');
    await page.screenshot({ fullPage: true, type: 'png', path: tmpPng });
    await encodeViaCanvas(page, tmpPng, outPath, spec.mime, quality);
    fs.rmSync(tmpPng, { force: true });
    return;
  }
  await page.screenshot({
    fullPage: true,
    type: format,
    ...(format === 'jpeg' ? { quality } : {}),
    path: outPath,
  });
}

function guardOutputSize(w, h) {
  const dw = Math.round(w * scale);
  const dh = Math.round(h * scale);
  const sideLimit = format === 'webp' ? WEBP_MAX_SIDE_PX : MAX_OUTPUT_SIDE_PX;
  if (dw > sideLimit || dh > sideLimit) {
    if (format === 'webp' && dw <= MAX_OUTPUT_SIDE_PX && dh <= MAX_OUTPUT_SIDE_PX) {
      // png/jpeg could still hold this artifact — say so instead of a generic
      // "too tall", so the agent/user can retry with a format that works.
      console.error(
        `output image would be ${dw}x${dh} device pixels — beyond WebP's hard ` +
          `${WEBP_MAX_SIDE_PX}px format limit (png/jpeg can still export this artifact; ` +
          're-run with --format png or jpeg, or tell the user webp cannot hold this page).',
      );
    } else {
      console.error(
        `output image would be ${dw}x${dh} device pixels — ` +
          `beyond the ${sideLimit}px encoder limit. The page/deck is too tall for a single ` +
          'image; report this to the user and offer PDF export instead.',
      );
    }
    process.exit(7);
  }
  if (dw * dh > MAX_OUTPUT_AREA_PX) {
    console.error(
      `output image would be ${dw}x${dh} = ${Math.round((dw * dh) / 1e6)}M device pixels — ` +
        `beyond the ${MAX_OUTPUT_AREA_PX / 1e6}M-pixel area limit this sandbox can render. ` +
        'Report this to the user and offer PDF export instead.',
    );
    process.exit(7);
  }
}

let tmpDir = null;
try {
  const context = await browser.newContext({
    viewport: { width: pageWidth, height: Math.round((pageWidth * 9) / 16) },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();
  // Generated pages gate below-the-fold sections behind IntersectionObserver
  // reveals (.reveal { opacity:0 } → .is-in on intersect). A full-page capture
  // never scrolls, so those observers would never fire and everything below
  // the first viewport would stay at its hidden initial state — the classic
  // "hero + huge blank body" export. Replace IO before any page script runs:
  // every observed target reports intersecting immediately and never reports
  // leaving, so toggle-off reveal patterns cannot re-hide content either.
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      constructor(callback) {
        this._callback = callback;
        this.root = null;
        this.rootMargin = '0px';
        this.thresholds = [0];
      }
      observe(target) {
        const rect = target.getBoundingClientRect();
        const entry = {
          target,
          isIntersecting: true,
          intersectionRatio: 1,
          boundingClientRect: rect,
          intersectionRect: rect,
          rootBounds: null,
          time: performance.now(),
        };
        Promise.resolve().then(() => this._callback([entry], this));
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    };
  });
  await page.goto(isUrl ? input : pathToFileURL(input).href, { waitUntil: 'load', timeout: 60_000 });
  await waitForPrintableContent(page);
  const tLoad = Date.now();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-image-shots-'));

  // Deck-vs-page mirrors the web viewer's sourceLooksLikeExportableDeck
  // (apps/web/src/runtime/exports.ts — keep the two in sync): a bare `.slide`
  // class is NOT proof of a deck (carousels/testimonials use it too) — it only
  // counts alongside deck structure: a data-title marker, or a `.deck` wrapper
  // whose DIRECT child is the slide (`.deck > .slide`, matching the web
  // signal's adjacency semantics — a deeper `.deck .wrapper .slide` is a page
  // there, so it must be a page here too). Runtime-managed decks
  // (<deck-stage>, [data-screen-label]) and the explicit deck-slide/ppt-slide
  // classes always count.
  const deckInfo = await page.evaluate(
    ([selector, cloneAncestors]) => {
      const strong = document.querySelector(
        'deck-stage, [data-screen-label], .deck-slide, .ppt-slide',
      );
      const titled = document.querySelector('.deck > .slide, .slide[data-title]');
      const count = Array.from(document.querySelectorAll(selector)).filter(
        (el) => !el.closest(cloneAncestors),
      ).length;
      return { isDeck: Boolean(strong || titled) && count >= 1, count };
    },
    [SLIDE_SELECTOR, CLONE_ANCESTORS],
  );

  if (!deckInfo.isDeck) {
    // --- Ordinary page: one full-page screenshot (whole document height). ---
    await freezeAnimations(page);
    // Scroll prewarm (ports deck-capture.ts preparePageForCapture): step
    // through the document once so scroll-event-driven JS (AOS-style libs)
    // and any remaining lazy loading trigger and settle, then return to the
    // top — the full-page capture below renders the document at scroll 0.
    // IO-gated reveals are already handled by the init-script stub above.
    await page.evaluate(async () => {
      const settle = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const docHeight = () =>
        Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
      const vh = window.innerHeight || 800;
      for (let y = 0; y < docHeight(); y += vh) {
        window.scrollTo(0, y);
        await settle();
      }
      window.scrollTo(0, 0);
      await settle();
    });
    await waitForPrintableContent(page);
    const size = await page.evaluate(() => ({
      w: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
      h: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    }));
    guardOutputSize(Math.max(pageWidth, size.w), size.h);
    await captureFullPage(page, output, tmpDir);
    const end = Date.now();
    console.log(
      `ok: ${output} (page ${size.w}x${size.h}@${scale}x, ${format}) ` +
        `load=${tLoad - t0}ms render=${end - tLoad}ms total=${end - t0}ms`,
    );
  } else {
    // --- Deck: capture every slide, then stitch vertically into one image. ---
    const count = deckInfo.count;
    // Deck prep: hide presenter chrome, stop <deck-stage> fit-to-viewport
    // scaling (`noscale`), freeze animations/transitions at their final state.
    await page.evaluate((hideSelector) => {
      document.querySelectorAll(hideSelector).forEach((el) => {
        el.style.setProperty('display', 'none', 'important');
      });
      document.querySelectorAll('deck-stage').forEach((el) => el.setAttribute('noscale', ''));
    }, HIDE_CHROME_SELECTOR);
    await freezeAnimations(page);

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
    guardOutputSize(stage.w, stage.h * count);
    await page.setViewportSize({ width: stage.w, height: stage.h });
    await page.evaluate((s) => {
      const style = document.createElement('style');
      style.textContent =
        `html,body{margin:0!important;padding:0!important;width:${s.w}px!important;height:${s.h}px!important;overflow:hidden!important}` +
        `.deck,deck-stage{width:${s.w}px!important;height:${s.h}px!important}`;
      document.head.appendChild(style);
    }, stage);
    const tPrepare = Date.now();

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
    // first, then stitch through a minimal <img>-stack page — the deck's DOM
    // and the stitch canvas never coexist, and no slide bitmap is held in this
    // process's heap while the next slide renders.
    // Best-effort per-slide cache purge: a critical memory-pressure signal makes
    // Chromium drop decoded images and other reclaimable caches between slides.
    const cdp = await page.context().newCDPSession(page).catch(() => null);
    const shots = [];
    for (let i = 0; i < count; i++) {
      await showSlide(i);
      const shot = path.join(tmpDir, `slide-${i + 1}.png`);
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

    // Stitch: a bare page stacking the slide PNGs (file-relative <img> refs —
    // no bytes through the CDP wire), captured full-page in one shot.
    const stitchHtml = path.join(tmpDir, 'stitch.html');
    fs.writeFileSync(
      stitchHtml,
      '<!doctype html><html><head><meta charset="utf-8"></head>' +
        '<body style="margin:0;padding:0;background:#fff">' +
        shots
          .map(
            (shot) =>
              `<img src="${path.basename(shot)}" style="display:block;width:${stage.w}px;height:${stage.h}px" alt="">`,
          )
          .join('') +
        '</body></html>',
    );
    await page.goto(pathToFileURL(stitchHtml).href, { waitUntil: 'load', timeout: 60_000 });
    await page.evaluate(async () => {
      await Promise.all(
        Array.from(document.images).map((img) =>
          img.complete && img.naturalWidth > 0 ? Promise.resolve() : img.decode().catch(() => {}),
        ),
      );
    });
    const blank = await page.evaluate(() =>
      Array.from(document.images).some((img) => !img.complete || img.naturalWidth === 0),
    );
    if (blank) {
      throw new Error('stitch page failed to load the captured slide images');
    }
    await captureFullPage(page, output, tmpDir);
    const end = Date.now();
    console.log(
      `ok: ${output} (${count} slides, ${stage.w}x${stage.h * count}@${scale}x, ${format}) ` +
        `load=${tLoad - t0}ms prepare=${tPrepare - tLoad}ms render=${tRender - tPrepare}ms stitch=${end - tRender}ms total=${end - t0}ms`,
    );
  }
} finally {
  await browser.close();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
}
