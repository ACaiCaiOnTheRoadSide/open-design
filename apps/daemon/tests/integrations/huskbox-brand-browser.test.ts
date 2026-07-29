import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hasHuskboxBrandBrowserContext, huskboxBrandDumpDom, huskboxBrandScreenshot, validBrandBrowserUrl } from '../../src/integrations/huskbox/brand-browser.js';
import { FIXED_HUSKBOX_WORKER_COMMAND } from '../../src/integrations/huskbox/client.js';
import { validateBrandBrowserInput } from '../../src/integrations/huskbox/desktop-render-worker.js';

const config = { baseUrl: 'https://huskbox.example', daemonPublicUrl: 'https://daemon.example', apiKey: 'key', tenantId: 'tenant', resourceTier: 'standard', timeoutSeconds: 30 };
function stream(result: unknown) {
  return new Response(`event: stdout\ndata: ${JSON.stringify({ stdout: `${JSON.stringify(result)}\n` })}\n\n`);
}

describe('Huskbox brand browser', () => {
  it('rejects non-http URLs and fixed worker kinds', () => {
    expect(validBrandBrowserUrl('https://example.com')).toBe(true);
    expect(validBrandBrowserUrl('file:///etc/passwd')).toBe(false);
    expect(() => validateBrandBrowserInput({ kind: 'shell', url: 'https://x.test' })).toThrow(/kind/);
    expect(() => validateBrandBrowserInput({ kind: 'dump-dom', url: 'file:///tmp/x' })).toThrow(/http/);
  });

  it('falls back without complete remote configuration', async () => {
    const fetch = vi.fn();
    expect(hasHuskboxBrandBrowserContext({ config: null, daemonToken: 'token' })).toBe(false);
    expect(hasHuskboxBrandBrowserContext({ config, daemonToken: '' })).toBe(false);
    expect(hasHuskboxBrandBrowserContext({ config, daemonToken: 'token' })).toBe(true);
    expect(await huskboxBrandDumpDom('https://x.test', { config: null, daemonToken: 'token', fetch })).toBeNull();
    expect(await huskboxBrandScreenshot('https://x.test', '/tmp/x', { config, daemonToken: '', fetch })).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends fixed dump-dom payload and parses SSE', async () => {
    const fetch = vi.fn(async () => stream({ ok: true, kind: 'dump-dom', html: '<html>remote</html>' }));
    expect(await huskboxBrandDumpDom('https://x.test/a', { config, daemonToken: 'daemon-token', fetch })).toBe('<html>remote</html>');
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const [url, init] = call;
    expect(url).toBe('https://huskbox.example/openapi/v1/executions/stream');
    const payload = JSON.parse(String(init?.body));
    expect(payload.cmd).toEqual(FIXED_HUSKBOX_WORKER_COMMAND);
    expect(JSON.parse(payload.stdin)).toEqual({ kind: 'dump-dom', url: 'https://x.test/a' });
  });

  it('writes a bounded screenshot into the requested brand path', async () => {
    const png = Buffer.from('small-png');
    const fetch = vi.fn(async () => stream({ ok: true, kind: 'screenshot', bytes: png.length, data: png.toString('base64') }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-husk-brand-'));
    const output = path.join(dir, 'screenshot.png');
    expect(await huskboxBrandScreenshot('https://x.test', output, { config, daemonToken: 'token', fetch })).toBe(true);
    expect(fs.readFileSync(output)).toEqual(png);
    const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(JSON.parse(String(call[1].body)).stdin).kind).toBe('screenshot');
  });
});
