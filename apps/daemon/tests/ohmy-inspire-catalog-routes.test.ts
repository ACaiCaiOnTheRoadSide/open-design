import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerLocalOhMyInspireCatalogRoutes } from '../src/routes/ohmy-inspire-catalog.js';

const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function startApp(env: NodeJS.ProcessEnv, fetchImpl?: typeof fetch) {
  const app = express();
  registerLocalOhMyInspireCatalogRoutes(app, { env, ...(fetchImpl ? { fetchImpl } : {}) });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing test server address');
  return `http://127.0.0.1:${address.port}`;
}

describe('local OhMyInspire catalog proxy', () => {
  it('is not registered outside local development', async () => {
    const base = await startApp({ OD_TELEMETRY_ENV: 'production' });
    const response = await fetch(`${base}/api/v1/catalog/templates`);
    expect(response.status).toBe(404);
  });

  it('reports missing server-side configuration without exposing a token', async () => {
    const base = await startApp({ OD_TELEMETRY_ENV: 'local_development' });
    const response = await fetch(`${base}/api/v1/catalog/templates`);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ code: 'OHMYINSPIRE_LOCAL_NOT_CONFIGURED' });
  });

  it('forwards catalog requests with the server-side token', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ data: [{ id: 'template-1' }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const base = await startApp({
      OD_TELEMETRY_ENV: 'local_development',
      OHMYINSPIRE_BASE_URL: 'https://design-prompt.example',
      OHMYINSPIRE_TOKEN: 'local-secret',
      OHMYINSPIRE_SESSION_COOKIE: 'baizhiyun=user-session; unrelated=secret',
    }, fetchImpl);

    const response = await fetch(`${base}/api/v1/catalog/templates?mode=all&page=1`, {
      headers: { cookie: 'baizhiyun=stale-browser-session' },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: [{ id: 'template-1' }] });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(String(target)).toBe('https://design-prompt.example/openapi/v1/catalog/templates?mode=all&page=1');
    expect(init?.headers).toEqual({
      authorization: 'Bearer local-secret',
      cookie: 'baizhiyun=user-session',
    });
  });

  it('forwards only allowlisted root preview images with range support', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(
      new Uint8Array([1, 2, 3]),
      {
        status: 206,
        headers: {
          'content-type': 'image/webp',
          'content-range': 'bytes 0-2/3',
          'accept-ranges': 'bytes',
        },
      },
    ));
    const base = await startApp({
      OD_TELEMETRY_ENV: 'local_development',
      OHMYINSPIRE_BASE_URL: 'https://design-prompt.example',
      OHMYINSPIRE_TOKEN: 'local-secret',
    }, fetchImpl);

    const response = await fetch(`${base}/api/v1/catalog/raw-preview/gpt-image-2/case544.webp`, {
      headers: { range: 'bytes=0-2' },
    });
    expect(response.status).toBe(206);
    const [target, init] = fetchImpl.mock.calls[0]!;
    expect(String(target)).toBe('https://design-prompt.example/gpt-image-2/case544.webp');
    expect(init?.headers).toMatchObject({ range: 'bytes=0-2' });

    const rejected = await fetch(`${base}/api/v1/catalog/raw-preview/private/secret.json`);
    expect(rejected.status).toBe(400);
  });
});
