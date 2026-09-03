#!/usr/bin/env node
// Export HTML to a text-preserving PDF with sandbox-owned Chromium.
// No Electron or client-browser print path is used.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const SLIDE_SELECTOR = '.slide, [data-screen-label], .deck-slide, .ppt-slide';
const CLONE_ANCESTORS = '.mini-slide, .overview, .notes-overlay, .thumb';
const HIDE_CHROME_SELECTOR =
  '.progress-bar, .notes-overlay, aside.notes, .speaker-notes, .deck-nav, .deck-hint, .deck-counter';
const DEFAULT_PAGE_WIDTH = 1440;
const DEFAULT_PAGE_HEIGHT = 1000;
const DEFAULT_SLIDE_WIDTH = 1920;
const DEFAULT_SLIDE_HEIGHT = 1080;
const MIN_SURFACE_PX = 320;
const MAX_SURFACE_PX = 8192;
// Chromium rejects or clips pathological custom paper sizes. Keep a normal
// viewport-height page for documents above this threshold.
const MAX_SINGLE_PAGE_PX = 19_000;
const RESOURCE_WAIT_TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
const positional = [];
let forceDeck = false;
for (const arg of argv) {
  if (arg === '--deck') forceDeck = true;
  else positional.push(arg);
}
const [inputArg, outputArg] = positional;
if (!inputArg || !outputArg) {
  console.error('usage: node render-pdf.mjs [--deck] <input.html> <output.pdf>');
  process.exit(2);
}

const isUrl = /^https?:\/\//i.test(inputArg);
const input = isUrl ? inputArg : path.resolve(inputArg);
if (!isUrl && !fs.existsSync(input)) {
  console.error(`input not found: ${input}`);
  process.exit(3);
}
const output = path.resolve(outputArg);
if (!/\.pdf$/i.test(output)) {
  console.error(`output must use the .pdf extension: ${output}`);
  process.exit(2);
}
const projectRoot = path.resolve(process.env.OD_PROJECT_DIR || (!isUrl ? path.dirname(input) : ''));

function isOutside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

function prepareOutputDirectory(root, target) {
  const lexicalRoot = path.resolve(root);
  if (isOutside(lexicalRoot, target)) throw new Error(`unsafe output path outside project directory: ${target}`);

  const canonicalRoot = fs.realpathSync(lexicalRoot);
  const relativeParent = path.relative(lexicalRoot, path.dirname(target));
  let canonicalParent = canonicalRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    const next = path.join(canonicalParent, segment);
    if (fs.existsSync(next)) {
      canonicalParent = fs.realpathSync(next);
      if (isOutside(canonicalRoot, canonicalParent) || !fs.statSync(canonicalParent).isDirectory()) {
        throw new Error(`unsafe output path outside project directory: ${target}`);
      }
    } else {
      fs.mkdirSync(next);
      canonicalParent = next;
    }
  }
  return canonicalParent;
}

let outputDirectory;
try {
  outputDirectory = prepareOutputDirectory(projectRoot, output);
} catch (error) {
  console.error(String(error?.message || error));
  process.exit(2);
}

function envDimension(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= MIN_SURFACE_PX && value <= MAX_SURFACE_PX
    ? Math.round(value)
    : fallback;
}
const viewportWidth = envDimension('OD_PDF_WIDTH', DEFAULT_PAGE_WIDTH);
const viewportHeight = envDimension('OD_PDF_HEIGHT', DEFAULT_PAGE_HEIGHT);

const systemChromium =
  process.env.OD_PPTX_CHROMIUM ||
  ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].find((candidate) =>
    fs.existsSync(candidate),
  ) ||
  null;
const proxyServer =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
const proxyBypass = process.env.NO_PROXY || process.env.no_proxy || undefined;

function contentType(file) {
  switch (path.extname(file).toLowerCase()) {
    case '.html': case '.htm': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': case '.mjs': return 'text/javascript; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.otf': return 'font/otf';
    default: return 'application/octet-stream';
  }
}

async function serveProject(root) {
  const canonicalRoot = fs.realpathSync(root);
  const server = http.createServer((request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url || '/', 'http://127.0.0.1').pathname);
      const candidate = path.resolve(canonicalRoot, `.${pathname}`);
      const relative = path.relative(canonicalRoot, candidate);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      const stat = fs.statSync(candidate);
      const file = fs.realpathSync(stat.isDirectory() ? path.join(candidate, 'index.html') : candidate);
      const realRelative = path.relative(canonicalRoot, file);
      if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
        response.writeHead(403).end('forbidden');
        return;
      }
      response.setHeader('content-type', contentType(file));
      response.setHeader('cache-control', 'no-store');
      fs.createReadStream(file).on('error', () => response.writeHead(404).end('not found')).pipe(response);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return server;
}

async function waitForPrintableContent(page) {
  await page.evaluate(async (timeoutMs) => {
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => { img.loading = 'eager'; });
    const images = Promise.all(Array.from(document.images || []).map((img) =>
      img.complete ? Promise.resolve() : new Promise((resolve) => {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', resolve, { once: true });
      }),
    ));
    const urls = new Set();
    for (const element of document.querySelectorAll('*')) {
      const style = getComputedStyle(element);
      for (const value of [style.backgroundImage, style.borderImageSource, style.listStyleImage]) {
        if (!value || value === 'none') continue;
        value.replace(/url\((['"]?)(.*?)\1\)/g, (_match, _quote, url) => {
          if (url && !/^data:/i.test(url)) urls.add(url);
          return '';
        });
      }
    }
    const cssImages = Promise.all(Array.from(urls).map((url) => new Promise((resolve) => {
      const image = new Image();
      image.onload = resolve;
      image.onerror = resolve;
      image.src = url;
    })));
    const fonts = document.fonts?.ready?.catch(() => {}) ?? Promise.resolve();
    await Promise.race([
      Promise.all([fonts, images, cssImages]),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out waiting ${timeoutMs}ms for fonts and images`)), timeoutMs)),
    ]);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, RESOURCE_WAIT_TIMEOUT_MS);
}

async function prewarmDocument(page) {
  await page.evaluate(async () => {
    const settle = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const height = () => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0);
    const step = window.innerHeight || 900;
    for (let y = 0; y < height(); y += step) {
      window.scrollTo(0, y);
      await settle();
    }
    window.scrollTo(0, 0);
    await settle();
  });
}

async function detectDeck(page) {
  return page.evaluate(([selector, cloneAncestors]) => {
    const strong = document.querySelector('deck-stage, .deck-stage, [data-screen-label], .deck-slide, .ppt-slide');
    const titled = document.querySelector('.deck > .slide, .slide[data-title]');
    const candidates = Array.from(document.querySelectorAll(selector)).filter((element) => !element.closest(cloneAncestors));
    const slides = candidates.filter(
      (element) => !candidates.some((ancestor) => ancestor !== element && ancestor.contains(element)),
    );
    return { count: slides.length, isDeck: Boolean(strong || titled) && slides.length > 0 };
  }, [SLIDE_SELECTOR, CLONE_ANCESTORS]);
}

async function measureSlide(page) {
  const measured = await page.evaluate(([selector, cloneAncestors]) => {
    const positive = (value) => {
      if (typeof value === 'number') return Number.isFinite(value) && value > 1 ? value : null;
      const match = /^(\d+(?:\.\d+)?)(?:px)?$/i.exec(String(value || '').trim());
      const number = match ? Number(match[1]) : NaN;
      return Number.isFinite(number) && number > 1 ? number : null;
    };
    const pair = (width, height) => {
      const w = positive(width);
      const h = positive(height);
      return w != null && h != null ? { w, h } : null;
    };
    const candidates = Array.from(document.querySelectorAll(selector)).filter((element) => !element.closest(cloneAncestors));
    const slides = candidates.filter(
      (element) => !candidates.some((ancestor) => ancestor !== element && ancestor.contains(element)),
    );
    for (const slide of slides) {
      const stage = slide.closest('deck-stage');
      const size =
        (stage && (pair(stage.designWidth, stage.designHeight) || pair(stage.getAttribute('width'), stage.getAttribute('height')))) ||
        pair(slide.getAttribute('width'), slide.getAttribute('height')) ||
        pair(slide.style?.width, slide.style?.height) ||
        pair(getComputedStyle(slide).width, getComputedStyle(slide).height) ||
        pair(slide.offsetWidth, slide.offsetHeight);
      if (size) return size;
      const rect = slide.getBoundingClientRect();
      if (rect.width > 1 && rect.height > 1) return { w: rect.width, h: rect.height };
    }
    return null;
  }, [SLIDE_SELECTOR, CLONE_ANCESTORS]);
  if (
    measured && measured.w >= MIN_SURFACE_PX && measured.w <= MAX_SURFACE_PX &&
    measured.h >= MIN_SURFACE_PX && measured.h <= MAX_SURFACE_PX
  ) {
    return { w: Math.round(measured.w), h: Math.round(measured.h) };
  }
  return { w: DEFAULT_SLIDE_WIDTH, h: DEFAULT_SLIDE_HEIGHT };
}

async function prepareDeckForPrint(page, stage) {
  await page.evaluate(([slideSelector, cloneAncestors, hideSelector, width, height]) => {
    document.querySelectorAll(hideSelector).forEach((element) => {
      element.style.setProperty('display', 'none', 'important');
    });
    document.querySelectorAll('deck-stage').forEach((element) => element.setAttribute('noscale', ''));
    const candidates = Array.from(document.querySelectorAll(slideSelector)).filter(
      (element) => !element.closest(cloneAncestors),
    );
    const slides = candidates.filter(
      (element) => !candidates.some((ancestor) => ancestor !== element && ancestor.contains(element)),
    );
    slides.forEach((slide) => {
      ['active', 'visible', 'is-active', 'current'].forEach((name) => slide.classList.add(name));
      let display = getComputedStyle(slide).display;
      if (display === 'none' && slide.style.getPropertyValue('display')) {
        slide.style.removeProperty('display');
        display = getComputedStyle(slide).display;
      }
      for (const [property, value] of Object.entries({
        ...(display === 'none' ? { display: 'block' } : {}), position: 'relative', inset: 'auto', transform: 'none', opacity: '1',
        visibility: 'visible', width: `${width}px`, height: `${height}px`, minHeight: `${height}px`,
        maxHeight: `${height}px`, overflow: 'hidden', margin: '0', breakAfter: 'page', pageBreakAfter: 'always',
      })) slide.style.setProperty(property.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`), value, 'important');
    });
    slides.at(-1)?.style.setProperty('break-after', 'auto', 'important');
    slides.at(-1)?.style.setProperty('page-break-after', 'auto', 'important');
    const style = document.createElement('style');
    style.setAttribute('data-od-pdf-export', '');
    style.textContent = `
      @page { size: ${width}px ${height}px; margin: 0; }
      html, body { margin: 0 !important; padding: 0 !important; width: ${width}px !important;
        min-width: ${width}px !important; height: auto !important; overflow: visible !important; }
      .deck, deck-stage, .deck-stage, #deck-stage { position: static !important; transform: none !important;
        width: ${width}px !important; height: auto !important; min-height: 0 !important;
        overflow: visible !important; display: block !important; }
      *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important;
        transition-duration: 0s !important; transition-delay: 0s !important;
        -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }, [SLIDE_SELECTOR, CLONE_ANCESTORS, HIDE_CHROME_SELECTOR, stage.w, stage.h]);
}

async function preparePageForPrint(page) {
  await page.evaluate(() => {
    const style = document.createElement('style');
    style.setAttribute('data-od-pdf-export', '');
    style.textContent = `
      *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important;
        transition-duration: 0s !important; transition-delay: 0s !important;
        -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  });
  await prewarmDocument(page);
}

let browser;
let server;
let pdf;
let tempOutput;
const t0 = Date.now();
try {
  if (!isUrl) server = await serveProject(projectRoot);
  const address = server?.address();
  const inputUrl = isUrl
    ? input
    : `http://127.0.0.1:${address.port}/${path.relative(projectRoot, input).split(path.sep).map(encodeURIComponent).join('/')}`;

  try {
    browser = await chromium.launch({
      ...(systemChromium ? { executablePath: systemChromium } : {}),
      ...(proxyServer ? { proxy: { server: proxyServer, bypass: proxyBypass } } : {}),
      args: [
        '--no-sandbox', '--disable-dev-shm-usage', '--force-color-profile=srgb', '--hide-scrollbars',
        '--font-render-hinting=none', '--disable-gpu', '--no-zygote', '--renderer-process-limit=1',
        '--disable-extensions', '--disable-background-networking', '--js-flags=--max-old-space-size=256',
      ],
    });
  } catch (error) {
    console.error(`chromium failed to launch: ${String(error?.message || error).split('\n')[0]}`);
    console.error("run the skill's bundled scripts/setup-env.sh, source its env.sh, and retry; do not install a browser by hand");
    process.exit(6);
  }

  const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.IntersectionObserver = class {
      constructor(callback) { this.callback = callback; this.root = null; this.rootMargin = '0px'; this.thresholds = [0]; }
      observe(target) {
        const rect = target.getBoundingClientRect();
        Promise.resolve().then(() => this.callback([{ target, isIntersecting: true, intersectionRatio: 1,
          boundingClientRect: rect, intersectionRect: rect, rootBounds: null, time: performance.now() }], this));
      }
      unobserve() {}
      disconnect() {}
      takeRecords() { return []; }
    };
  });
  await page.goto(inputUrl, { waitUntil: 'load', timeout: 60_000 });
  await page.emulateMedia({ media: 'screen' });
  await waitForPrintableContent(page);

  const deck = await detectDeck(page);
  const renderAsDeck = forceDeck || deck.isDeck;
  if (forceDeck && deck.count === 0) throw new Error(`--deck was requested, but no slides matched ${SLIDE_SELECTOR}`);

  let expectedPages = 1;
  if (renderAsDeck) {
    const stage = await measureSlide(page);
    await page.setViewportSize({ width: stage.w, height: stage.h });
    await prepareDeckForPrint(page, stage);
    await waitForPrintableContent(page);
    expectedPages = deck.count;
    pdf = await page.pdf({
      width: `${stage.w}px`,
      height: `${stage.h}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      scale: 1,
    });
  } else {
    await preparePageForPrint(page);
    await waitForPrintableContent(page);
    const size = await page.evaluate(() => ({
      width: Math.ceil(Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, window.innerWidth)),
      height: Math.ceil(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, window.innerHeight)),
    }));
    const paperHeight = size.height <= MAX_SINGLE_PAGE_PX ? size.height : viewportHeight;
    expectedPages = Math.max(1, Math.ceil(size.height / paperHeight));
    await page.addStyleTag({ content: `@page{size:${size.width}px ${paperHeight}px;margin:0}html,body{margin:0!important;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important}` });
    pdf = await page.pdf({
      width: `${size.width}px`,
      height: `${paperHeight}px`,
      margin: { top: '0', right: '0', bottom: '0', left: '0' },
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: false,
      scale: 1,
    });
  }

  const bytes = pdf.length;
  if (bytes < 1024 || pdf.subarray(0, 5).toString() !== '%PDF-') {
    throw new Error(`Chromium produced an invalid PDF (${bytes} bytes)`);
  }
  const actualPages = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) || []).length;
  if (actualPages < 1) throw new Error('Chromium produced a PDF whose page count could not be verified');
  if (renderAsDeck && actualPages !== expectedPages) {
    throw new Error(`deck pagination mismatch: expected ${expectedPages} pages, PDF contains ${actualPages}`);
  }
  tempOutput = path.join(outputDirectory, `.${path.basename(output)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempOutput, pdf, { flag: 'wx' });
  fs.renameSync(tempOutput, output);
  tempOutput = undefined;
  console.log(`ok: ${output} (${actualPages} page${actualPages === 1 ? '' : 's'}, ${bytes} bytes, text-preserving Chromium PDF, ${Date.now() - t0}ms)`);
} finally {
  if (tempOutput) fs.rmSync(tempOutput, { force: true });
  await browser?.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}
