#!/usr/bin/env node
// Render an HTML slide deck to a screenshot-per-slide .pptx with headless
// Chromium (Playwright) + PptxGenJS — no Electron/desktop runtime required.
//
// Slide detection, presenter-chrome hiding, stage measurement/pinning, and the
// show-slide/restack paging semantics are ported from the desktop export path
// (apps/desktop/src/main/deck-capture.ts) so this produces the same slides the
// desktop app would.
//
// usage: node render-pptx.mjs <input.html> [output.pptx]
// env:   OD_PPTX_SCALE  device scale factor for capture (default 1; 2 = crisper, slower)
//
// Exit codes: 0 ok, 2 usage, 3 input not found, 4 no slide surfaces (not a deck).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import PptxGenJS from 'pptxgenjs';

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

const [, , inputArg, outputArg] = process.argv;
if (!inputArg) {
  console.error('usage: node render-pptx.mjs <input.html> [output.pptx]');
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

const t0 = Date.now();
const browser = await chromium.launch({
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
    '--js-flags=--max-old-space-size=256',
  ],
});
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

  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'OD', width: stage.w / PX_PER_INCH, height: stage.h / PX_PER_INCH });
  pptx.layout = 'OD';
  for (let i = 0; i < count; i++) {
    await showSlide(i);
    const png = await page.screenshot({
      clip: { x: 0, y: 0, width: stage.w, height: stage.h },
      type: 'png',
    });
    pptx.addSlide().addImage({
      data: `data:image/png;base64,${png.toString('base64')}`,
      x: 0,
      y: 0,
      w: stage.w / PX_PER_INCH,
      h: stage.h / PX_PER_INCH,
    });
    console.log(`slide ${i + 1}/${count} captured`);
  }
  const tRender = Date.now();

  await pptx.writeFile({ fileName: output });
  const end = Date.now();
  console.log(
    `ok: ${output} (${count} slides, ${stage.w}x${stage.h}) ` +
      `load=${tLoad - t0}ms prepare=${tPrepare - tLoad}ms render=${tRender - tPrepare}ms write=${end - tRender}ms total=${end - t0}ms`,
  );
} finally {
  await browser.close();
}
