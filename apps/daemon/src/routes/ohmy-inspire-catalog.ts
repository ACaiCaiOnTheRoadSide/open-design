import type { Express, Request, Response } from 'express';
import { Readable } from 'node:stream';

const CATALOG_PREFIX = '/api/v1/catalog';
const UPSTREAM_PREFIX = '/openapi/v1/catalog';
const MAX_RESPONSE_BYTES = 50 * 1024 * 1024;

interface LocalCatalogOptions {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

function configuredUpstream(env: NodeJS.ProcessEnv): { baseURL: URL; token: string } | null {
  if (env.OD_TELEMETRY_ENV !== 'local_development') return null;
  const token = env.OHMYINSPIRE_TOKEN?.trim();
  const rawBaseURL = env.OHMYINSPIRE_BASE_URL?.trim();
  if (!token || !rawBaseURL) return null;

  const baseURL = new URL(rawBaseURL);
  if (baseURL.protocol !== 'https:' || baseURL.username || baseURL.password) {
    throw new Error('OHMYINSPIRE_BASE_URL must be an HTTPS origin without credentials');
  }
  baseURL.pathname = '/';
  baseURL.search = '';
  baseURL.hash = '';
  return { baseURL, token };
}

function platformSessionCookie(rawCookie: string | undefined): string | null {
  if (!rawCookie) return null;
  const allowed = new Set(['baizhiyun', 'baizhiyun_admin_session']);
  const cookies = rawCookie.split(';').map((part) => part.trim()).filter((part) => {
    const separator = part.indexOf('=');
    return separator > 0 && allowed.has(part.slice(0, separator));
  });
  return cookies.length > 0 ? cookies.join('; ') : null;
}

function safeCatalogSuffix(req: Request): string | null {
  const requestPath = new URL(req.originalUrl, 'http://local.invalid').pathname;
  const suffix = requestPath.slice(CATALOG_PREFIX.length);
  if (!suffix.startsWith('/') || suffix.includes('\\')) return null;
  try {
    if (decodeURIComponent(suffix).split('/').includes('..')) return null;
  } catch {
    return null;
  }
  return suffix;
}

export function registerLocalOhMyInspireCatalogRoutes(app: Express, options: LocalCatalogOptions = {}): void {
  const env = options.env ?? process.env;
  if (env.OD_TELEMETRY_ENV !== 'local_development') return;

  app.use(CATALOG_PREFIX, async (req: Request, res: Response) => {
    if (req.method !== 'GET') {
      return res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: 'Only GET is supported locally' });
    }

    let upstream: ReturnType<typeof configuredUpstream>;
    try {
      upstream = configuredUpstream(env);
    } catch (error) {
      return res.status(503).json({
        code: 'OHMYINSPIRE_LOCAL_CONFIG_INVALID',
        message: error instanceof Error ? error.message : 'Invalid local OhMyInspire configuration',
      });
    }
    if (!upstream) {
      return res.status(503).json({
        code: 'OHMYINSPIRE_LOCAL_NOT_CONFIGURED',
        message: 'Set OHMYINSPIRE_BASE_URL and OHMYINSPIRE_TOKEN in the local server environment',
      });
    }

    const suffix = safeCatalogSuffix(req);
    if (!suffix) {
      return res.status(400).json({ code: 'INVALID_CATALOG_PATH', message: 'Invalid catalog path' });
    }

    const rawImageMatch = /^\/raw-preview(\/gpt-image-2\/[A-Za-z0-9._-]+\.webp)$/.exec(suffix);
    if (suffix.startsWith('/raw-preview/') && !rawImageMatch) {
      return res.status(400).json({ code: 'INVALID_PREVIEW_PATH', message: 'Invalid preview path' });
    }
    const target = new URL(rawImageMatch?.[1] ?? `${UPSTREAM_PREFIX}${suffix}`, upstream.baseURL);
    const queryIndex = req.originalUrl.indexOf('?');
    if (queryIndex >= 0) target.search = req.originalUrl.slice(queryIndex + 1);

    const controller = new AbortController();
    req.once('aborted', () => controller.abort());
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    try {
      const sessionCookie = platformSessionCookie(env.OHMYINSPIRE_SESSION_COOKIE)
        ?? platformSessionCookie(req.headers.cookie);
      const response = await (options.fetchImpl ?? fetch)(target, {
        headers: {
          authorization: `Bearer ${upstream.token}`,
          ...(sessionCookie ? { cookie: sessionCookie } : {}),
          ...(typeof req.headers['x-confirm-template-charge'] === 'string'
            ? { 'x-confirm-template-charge': req.headers['x-confirm-template-charge'] }
            : {}),
          ...(typeof req.headers.range === 'string' ? { range: req.headers.range } : {}),
        },
        redirect: 'error',
        signal: controller.signal,
      });
      const contentLength = Number(response.headers.get('content-length') ?? 0);
      if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        return res.status(502).json({ code: 'OHMYINSPIRE_RESPONSE_TOO_LARGE', message: 'Catalog response is too large' });
      }

      res.status(response.status);
      for (const header of [
        'content-type',
        'content-length',
        'content-disposition',
        'cache-control',
        'accept-ranges',
        'content-range',
        'etag',
        'last-modified',
      ]) {
        const value = response.headers.get(header);
        if (value) res.setHeader(header, value);
      }
      if (!response.body) return res.end();
      Readable.fromWeb(response.body as never).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) {
        return res.status(502).json({
          code: 'OHMYINSPIRE_UNAVAILABLE',
          message: error instanceof Error ? error.message : 'OhMyInspire request failed',
        });
      }
      res.destroy();
    }
  });
}
