import { PassThrough, Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { DesktopRenderSlidesInput } from '@open-design/sidecar-proto';
import {
  FIXED_RENDER_COMMAND,
  canRenderSlideExport,
  createHuskboxDesktopSlideRenderer,
  HuskboxExecutionStreamParser,
  parseHuskboxExecutionStream,
  readHuskboxDesktopRendererConfig,
  selectDesktopSlideRenderer,
} from '../../src/integrations/huskbox/desktop-renderer.js';
import { authorizationHeaderForUrl, PREPARE_DECK_EXPRESSION, readStdin, remoteRenderPlan } from '../../src/integrations/huskbox/desktop-render-worker.js';
import { HuskboxInfrastructureError } from '../../src/integrations/huskbox/client.js';

describe('Huskbox desktop slide renderer', () => {
  it('reads complete SaaS configuration and normalizes defaults', () => {
    expect(readHuskboxDesktopRendererConfig({
      OD_HUSKBOX_BASE_URL: 'https://huskbox.example/',
      OD_HUSKBOX_API_KEY: 'key',
      OD_HUSKBOX_DAEMON_PUBLIC_URL: 'https://daemon.public/',
      OD_HUSKBOX_RESOURCE_TIER: 'large',
      OD_HUSKBOX_TIMEOUT_SECONDS: '42',
    })).toEqual({
      baseUrl: 'https://huskbox.example', daemonPublicUrl: 'https://daemon.public', apiKey: 'key',
      resourceTier: 'large', timeoutSeconds: 42,
    });
    expect(readHuskboxDesktopRendererConfig({ OD_HUSKBOX_BASE_URL: 'https://x' })).toBeNull();
    expect(readHuskboxDesktopRendererConfig({ OD_HUSKBOX_BASE_URL: 'https://x', OD_HUSKBOX_API_KEY: 'k' })).toBeNull();
    expect(readHuskboxDesktopRendererConfig({ OD_HUSKBOX_BASE_URL: 'file:///tmp/x', OD_HUSKBOX_API_KEY: 'k' })).toBeNull();
  });

  it('preserves a desktop renderer and only selects remote with complete SaaS auth', () => {
    const desktop = vi.fn();
    const config = { baseUrl: 'https://huskbox', daemonPublicUrl: 'https://daemon', apiKey: 'k', resourceTier: 'standard', timeoutSeconds: 30 };
    expect(selectDesktopSlideRenderer(desktop, config, { daemonToken: 'token' })).toBe(desktop);
    expect(selectDesktopSlideRenderer(null, config, { daemonToken: '' })).toBeNull();
    expect(selectDesktopSlideRenderer(null, null, { daemonToken: 'token' })).toBeNull();
    expect(selectDesktopSlideRenderer(null, config, { daemonToken: 'token' })).toBeTypeOf('function');
  });

  it('limits a remote renderer to image and raster PDF without changing desktop capabilities', () => {
    const config = { baseUrl: 'https://huskbox', daemonPublicUrl: 'https://daemon', apiKey: 'k', resourceTier: 'standard', timeoutSeconds: 30 };
    const remote = selectDesktopSlideRenderer(null, config, { daemonToken: 'token' });
    const desktop = vi.fn();
    expect(canRenderSlideExport(remote, 'image')).toBe(true);
    expect(canRenderSlideExport(remote, 'pdf')).toBe(true);
    expect(canRenderSlideExport(remote, 'pptx')).toBe(false);
    expect(canRenderSlideExport(desktop, 'pptx')).toBe(true);
  });

  it('posts the new snake_case streaming API with a fixed command', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(
      'event: stdout\ndata: {"stdout":"{\\"ok\\":true,\\"mode\\":\\"deck\\",\\"slides\\":[\\"data:image/png;base64,AA==\\"]}\\n"}\n\n',
      { status: 200 },
    ));
    const renderer = createHuskboxDesktopSlideRenderer({
      baseUrl: 'https://huskbox.example', daemonPublicUrl: 'https://daemon.internal', apiKey: 'secret',
      resourceTier: 'medium', timeoutSeconds: 60,
    }, { daemonToken: 'daemon-secret', fetch: fetch as typeof globalThis.fetch });
    const result = await renderer({ html: '<section class="slide">A</section>', deck: true, outputDir: '/must/not/escape' });
    expect(result.ok).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe('https://huskbox.example/openapi/v1/executions/stream');
    expect(init?.headers).toEqual({ authorization: 'Bearer secret', 'content-type': 'application/json' });
    const payload = JSON.parse(String(init?.body));
    expect(payload).toMatchObject({
      cmd: FIXED_RENDER_COMMAND,
      env: {
        OD_DAEMON_TOKEN: 'daemon-secret', OD_DAEMON_URL: 'https://daemon.internal',
        OD_STDIN_LEN: String(Buffer.byteLength(payload.stdin, 'utf8')),
      },
      resource_tier: 'medium', timeout_seconds: 60,
    });
    expect(JSON.parse(payload.stdin)).toEqual({ html: '<section class="slide">A</section>', deck: true });
    expect(payload.command).toBeUndefined();
  });

  it('parses direct results, split stdout, and errors', () => {
    expect(parseHuskboxExecutionStream('event: completed\ndata: {"result":{"ok":true,"mode":"page","slides":["data:image/png;base64,AA=="]}}\n\n').mode).toBe('page');
    expect(parseHuskboxExecutionStream('event: stdout\ndata: {"stdout_delta":"{\\"ok\\":true,"}\n\nevent: stdout\ndata: {"stdout_delta":"\\"slides\\":[\\"x\\"]}\\n"}\n\n').ok).toBe(true);
    expect(() => parseHuskboxExecutionStream('event: error\ndata: {"message":"worker died"}\n\n')).toThrow(/worker died/);
  });

  it('parses SSE incrementally and restricts browser bearer auth to daemon origin', () => {
    const parser = new HuskboxExecutionStreamParser();
    parser.push('event: stdout\ndata: {"stdout_delta":"{\\"ok\\":true,"}\n\n');
    parser.push('event: stdout\ndata: {"stdout_delta":"\\"slides\\":[\\"x\\"]}\\n"}\n\n');
    expect(parser.finish().ok).toBe(true);
    expect(authorizationHeaderForUrl('https://daemon.example/api/image', 'https://daemon.example/base', 'secret')).toEqual({ Authorization: 'Bearer secret' });
    expect(authorizationHeaderForUrl('https://cdn.example/image', 'https://daemon.example', 'secret')).toEqual({});
    const prepare = PREPARE_DECK_EXPRESSION('.slide', 1920, 1080);
    expect(prepare).toContain("opacity','1");
    expect(prepare).toContain("visibility','visible");
    expect(prepare).toContain("transform','none");
  });

  it('keeps worker business errors as results and types worker infrastructure failures', async () => {
    const resultResponse = (result: object) => new Response(
      `event: stdout\ndata: ${JSON.stringify({ stdout: `${JSON.stringify(result)}\n` })}\n\n`,
      { status: 200 },
    );
    const config = {
      baseUrl: 'https://huskbox.example', daemonPublicUrl: 'https://daemon.internal', apiKey: 'k', resourceTier: 'standard', timeoutSeconds: 1,
    };
    const businessRenderer = createHuskboxDesktopSlideRenderer(config, {
      daemonToken: 'token',
      fetch: vi.fn(async () => resultResponse({ ok: false, error: 'bad index', errorCode: 'SLIDE_INDEX_OUT_OF_RANGE' })) as typeof globalThis.fetch,
    });
    await expect(businessRenderer({ html: 'x' })).resolves.toMatchObject({
      ok: false,
      errorCode: 'SLIDE_INDEX_OUT_OF_RANGE',
    });

    const failedWorkerRenderer = createHuskboxDesktopSlideRenderer(config, {
      daemonToken: 'token',
      fetch: vi.fn(async () => resultResponse({ ok: false, error: 'chromium crashed', errorCode: 'RENDER_FAILED' })) as typeof globalThis.fetch,
    });
    await expect(failedWorkerRenderer({ html: 'x' })).rejects.toEqual(expect.objectContaining({
      kind: 'worker',
      name: 'HuskboxInfrastructureError',
    } satisfies Partial<HuskboxInfrastructureError>));
  });

  it('surfaces HTTP errors', async () => {
    const failedFetch = vi.fn(async () => new Response('capacity exceeded', { status: 429 }));
    const renderer = createHuskboxDesktopSlideRenderer({
      baseUrl: 'https://huskbox.example', daemonPublicUrl: 'https://daemon.internal', apiKey: 'k', resourceTier: 'standard', timeoutSeconds: 1,
    }, { daemonToken: 'token', fetch: failedFetch as typeof globalThis.fetch });
    await expect(renderer({ html: 'x' })).rejects.toThrow(/HTTP 429.*capacity exceeded/);
    expect(failedFetch).toHaveBeenCalledTimes(1);
  });

  it('reads the declared UTF-8 byte length without waiting for EOF', async () => {
    const text = '{"title":"你好"}';
    const input = new PassThrough();
    const result = readStdin(input, String(Buffer.byteLength(text)));
    input.write(Buffer.from(`${text}trailing`));
    await expect(result).resolves.toBe(text);
    input.destroy();
  });

  it('rejects invalid lengths and stdin that ends early', async () => {
    await expect(readStdin(Readable.from([]), 'nope')).rejects.toThrow(/non-negative integer/);
    await expect(readStdin(Readable.from([Buffer.from('短')]), '4')).rejects.toThrow(/ended early.*4.*3/);
  });

  it('unit tests worker page/deck/index selection', () => {
    const input = { html: '' } satisfies DesktopRenderSlidesInput;
    expect(remoteRenderPlan(input, 2)).toEqual({ deck: true });
    expect(remoteRenderPlan({ ...input, deck: false }, 2)).toEqual({ deck: false });
    expect(remoteRenderPlan({ ...input, deck: true }, 0)).toEqual({ errorCode: 'NO_SLIDES' });
    expect(remoteRenderPlan({ ...input, deck: true, index: 2 }, 2)).toEqual({ errorCode: 'SLIDE_INDEX_OUT_OF_RANGE' });
  });
});
