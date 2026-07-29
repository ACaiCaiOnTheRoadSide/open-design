import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import type { DesktopRenderSlidesInput, DesktopRenderSlidesResult } from '@open-design/sidecar-proto';

const SLIDE_SELECTOR = '.slide, [data-screen-label], .deck-slide, .ppt-slide';
const BRAND_MAX_DOM_BYTES = 3_000_000;
const BRAND_MAX_SCREENSHOT_BYTES = 10 * 1024 * 1024;

export type BrandBrowserInput = { kind: 'dump-dom' | 'screenshot'; url: string };
export type BrandBrowserResult = { ok: true; kind: 'dump-dom'; html: string } | { ok: true; kind: 'screenshot'; bytes: number; data: string } | { ok: false; error: string };

export function validateBrandBrowserInput(value: unknown): BrandBrowserInput {
  if (!value || typeof value !== 'object') throw new Error('invalid brand browser task');
  const input = value as Record<string, unknown>;
  if (input.kind !== 'dump-dom' && input.kind !== 'screenshot') throw new Error('brand browser kind must be dump-dom or screenshot');
  if (typeof input.url !== 'string') throw new Error('brand browser URL is required');
  const url = new URL(input.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('brand browser URL must use http or https');
  return { kind: input.kind, url: url.href };
}

export async function readStdin(
  stdin: NodeJS.ReadableStream = process.stdin,
  rawLength: string | undefined = process.env.OD_STDIN_LEN,
): Promise<string> {
  if (!rawLength || !/^\d+$/.test(rawLength)) throw new Error('OD_STDIN_LEN must be a non-negative integer');
  const length = Number(rawLength);
  if (!Number.isSafeInteger(length)) throw new Error('OD_STDIN_LEN is too large');
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.from(chunk);
    const remaining = length - received;
    if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
    received += Math.min(buffer.length, Math.max(remaining, 0));
    if (received === length) break;
  }
  if (received !== length) throw new Error(`stdin ended early: expected ${length} bytes, received ${received}`);
  return Buffer.concat(chunks, length).toString('utf8');
}

export async function findChromium(root = '/tmp/chromium'): Promise<string> {
  const queue = [root];
  while (queue.length) {
    const dir = queue.shift()!;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) queue.push(full);
      else if (/^(chromium|chrome|headless_shell)$/.test(entry.name)) return full;
    }
  }
  throw new Error('Chromium executable not found in bundle');
}

type Cdp = {
  call(method: string, params?: object): Promise<any>;
  close(): void;
  on(method: string, listener: (params: any) => void): void;
};

async function connect(port: number): Promise<Cdp> {
  let wsUrl = '';
  for (let i = 0; i < 100; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json() as Array<{ type: string; webSocketDebuggerUrl: string }>;
      wsUrl = targets.find((x) => x.type === 'page')?.webSocketDebuggerUrl || '';
      if (wsUrl) break;
    } catch { /* Chromium is still starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (!wsUrl) throw new Error('Chromium DevTools endpoint did not start');
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('DevTools websocket failed'));
  });
  let id = 0;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Map<string, Array<(params: any) => void>>();
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method) {
      for (const listener of listeners.get(message.method) || []) listener(message.params);
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    message.error ? waiter.reject(new Error(message.error.message)) : waiter.resolve(message.result);
  };
  return {
    call(method, params = {}) {
      const next = ++id;
      ws.send(JSON.stringify({ id: next, method, params }));
      return new Promise((resolve, reject) => pending.set(next, { resolve, reject }));
    },
    on(method, listener) {
      const current = listeners.get(method) || [];
      current.push(listener);
      listeners.set(method, current);
    },
    close() { ws.close(); },
  };
}

function imageDataUrl(data: string, jpeg = false): string {
  return `data:image/${jpeg ? 'jpeg' : 'png'};base64,${data}`;
}

export function authorizationHeaderForUrl(requestUrl: string, daemonUrl: string, token: string): Record<string, string> {
  try {
    return new URL(requestUrl).origin === new URL(daemonUrl).origin
      ? { Authorization: `Bearer ${token}` }
      : {};
  } catch { return {}; }
}

export const PREPARE_DECK_EXPRESSION = (selector: string, width: number, height: number) => `(()=>{const s=[...document.querySelectorAll(${JSON.stringify(selector)})].filter(e=>!e.closest('.mini-slide, .overview, .notes-overlay, .thumb'));s.forEach((e,i)=>{e.classList.add('active','visible','is-active','current');e.style.setProperty('display','block','important');e.style.setProperty('opacity','1','important');e.style.setProperty('visibility','visible','important');e.style.setProperty('transform','none','important');e.style.setProperty('position','absolute','important');e.style.setProperty('left','0','important');e.style.setProperty('top',(i*${height})+'px','important');e.style.setProperty('width','${width}px','important');e.style.setProperty('height','${height}px','important')});document.body.style.margin='0';document.body.style.height=(s.length*${height})+'px'})()`;

export function remoteRenderPlan(input: DesktopRenderSlidesInput, slideCount: number) {
  if (input.deck === true && slideCount === 0) return { errorCode: 'NO_SLIDES' as const };
  const deck = input.deck === true || (input.deck == null && slideCount > 0);
  if (deck && input.index != null && (input.index < 0 || input.index >= slideCount)) {
    return { errorCode: 'SLIDE_INDEX_OUT_OF_RANGE' as const };
  }
  return { deck };
}

export async function withChromium<T>(run: (cdp: Cdp) => Promise<T>): Promise<T> {
  const executable = await findChromium();
  const port = 9222 + Math.floor(Math.random() * 500);
  const child = spawn(executable, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, '--window-size=1920,1080', 'about:blank',
  ], { stdio: 'ignore' });
  let cdp: Cdp | null = null;
  try {
    cdp = await connect(port);
    return await run(cdp);
  } finally {
    cdp?.close();
    child.kill('SIGKILL');
  }
}

export async function runBrandBrowserTask(raw: unknown): Promise<BrandBrowserResult> {
  const input = validateBrandBrowserInput(raw);
  return withChromium(async (cdp) => {
    await cdp.call('Page.enable');
    await cdp.call('Page.navigate', { url: input.url });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 6_000);
      cdp.on('Page.loadEventFired', () => { clearTimeout(timer); resolve(); });
    });
    if (input.kind === 'dump-dom') {
      const result = await cdp.call('Runtime.evaluate', { expression: 'document.documentElement.outerHTML', returnByValue: true });
      const html = String(result.result.value || '');
      if (Buffer.byteLength(html) > BRAND_MAX_DOM_BYTES) throw new Error(`DOM exceeds ${BRAND_MAX_DOM_BYTES} bytes`);
      return { ok: true, kind: 'dump-dom', html };
    }
    const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const bytes = Buffer.from(shot.data, 'base64');
    if (bytes.length > BRAND_MAX_SCREENSHOT_BYTES) throw new Error(`screenshot exceeds ${BRAND_MAX_SCREENSHOT_BYTES} bytes`);
    return { ok: true, kind: 'screenshot', bytes: bytes.length, data: shot.data };
  });
}

export async function renderWithChromium(input: DesktopRenderSlidesInput): Promise<DesktopRenderSlidesResult> {
  return withChromium(async (cdp) => {
    await cdp.call('Page.enable');
    await cdp.call('Runtime.enable');
    await cdp.call('Fetch.enable', { patterns: [{ urlPattern: '*' }] });
    cdp.on('Fetch.requestPaused', (event) => {
      const headers = authorizationHeaderForUrl(event.request.url, process.env.OD_DAEMON_URL || '', process.env.OD_DAEMON_TOKEN || '');
      void cdp!.call('Fetch.continueRequest', {
        requestId: event.requestId,
        headers: Object.keys(headers).length
          ? Object.entries({ ...event.request.headers, ...headers }).map(([name, value]) => ({ name, value: String(value) }))
          : undefined,
      });
    });
    const frame = await cdp.call('Page.getFrameTree');
    const base = input.baseHref ? `<base href="${input.baseHref.replace(/"/g, '&quot;')}">` : '';
    const html = base ? input.html.replace(/<head([^>]*)>/i, `<head$1>${base}`) : input.html;
    await cdp.call('Page.setDocumentContent', { frameId: frame.frameTree.frame.id, html });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const evaluate = async (expression: string) =>
      (await cdp!.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result.value;
    await evaluate('document.fonts ? document.fonts.ready : true');
    const count = await evaluate(`document.querySelectorAll(${JSON.stringify(SLIDE_SELECTOR)}).length`) as number;
    const plan = remoteRenderPlan(input, count);
    if (plan.errorCode === 'NO_SLIDES') return { ok: false, error: 'no slide surfaces found in this deck', errorCode: plan.errorCode };
    if (plan.errorCode === 'SLIDE_INDEX_OUT_OF_RANGE') return { ok: false, error: 'slide index is out of range', errorCode: plan.errorCode };
    const width = Math.round(input.width || 1920);
    const height = Math.round(input.height || 1080);
    await cdp.call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
    if (plan.deck) {
      await evaluate(PREPARE_DECK_EXPRESSION(SLIDE_SELECTOR, width, height));
      if (input.stitch) {
        const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width, height: height * count, scale: 1 } });
        return { ok: true, mode: 'deck', width, height: height * count, slides: [imageDataUrl(shot.data)] };
      }
      const indices = input.index == null ? [...Array(count).keys()] : [input.index];
      const slides: string[] = [];
      for (const index of indices) {
        const shot = await cdp.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: index * height, width, height, scale: 1 } });
        slides.push(imageDataUrl(shot.data));
      }
      return { ok: true, mode: 'deck', width, height, slides };
    }
    const metrics = await cdp.call('Page.getLayoutMetrics');
    const pageWidth = Math.ceil(metrics.cssContentSize.width);
    const pageHeight = Math.ceil(metrics.cssContentSize.height);
    const jpeg = input.pageImageFormat === 'jpeg';
    const chunks = input.paginate ? Math.max(1, Math.ceil(pageHeight / height)) : 1;
    const slides: string[] = [];
    for (let index = 0; index < chunks; index++) {
      const clipHeight = input.paginate ? Math.min(height, pageHeight - index * height) : pageHeight;
      const shot = await cdp.call('Page.captureScreenshot', {
        format: jpeg ? 'jpeg' : 'png', quality: jpeg ? 90 : undefined, captureBeyondViewport: true,
        clip: { x: 0, y: index * height, width: pageWidth, height: clipHeight, scale: 1 },
      });
      slides.push(imageDataUrl(shot.data, jpeg));
    }
    return { ok: true, mode: 'page', width: pageWidth, height: input.paginate ? height : pageHeight, slides };
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  try {
    const input = JSON.parse(await readStdin()) as DesktopRenderSlidesInput | BrandBrowserInput;
    const result = 'kind' in input ? await runBrandBrowserTask(input) : await renderWithChromium(input);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const result: DesktopRenderSlidesResult = {
      ok: false,
      errorCode: 'RENDER_FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
}
