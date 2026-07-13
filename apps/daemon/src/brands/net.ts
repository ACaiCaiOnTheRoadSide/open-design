// Proxy-aware fetch for the brand-extraction harvest pipeline.
//
// Node's built-in fetch (undici) ignores HTTP_PROXY / HTTPS_PROXY / ALL_PROXY
// entirely, so a raw `fetch(url)` always dials the origin directly. On
// egress-restricted deployments (daemon in a cluster whose only route to part
// of the public internet is a proxy) that means the programmatic brand harvest
// silently fails for those origins and extraction falls back to the far slower
// agent path.
//
// `brandFetch` is a drop-in replacement for `fetch` that is DIRECT-FIRST:
//
//   - No proxy configured → plain direct fetch, identical to before.
//   - Proxy configured → try the origin directly with a short probe timeout;
//     only when the direct attempt errors out (connection reset, blocked
//     route, probe timeout) retry through the proxy dispatcher — the same
//     env/system proxy resolution the media/chat routes use
//     (`proxyDispatcherRequestInit`, honors NO_PROXY).
//
// Direct-first matters because one deployment serves both worlds: origins the
// cluster reaches directly must not pay the proxy detour (or depend on the
// proxy being able to reach them at all). The per-host verdict is cached for
// ROUTE_CACHE_TTL_MS so one harvest's dozens of fetches against the same site
// don't re-probe every time. A total failure (both attempts) caches nothing —
// a site that is simply down doesn't get pinned to the proxy route.

import { proxyDispatcherRequestInit } from '../connectionTest.js';

const PROXY_DISPATCHER_TTL_MS = 5 * 60 * 1000;
const ROUTE_CACHE_TTL_MS = 10 * 60 * 1000;
/** How long a first direct attempt against an unknown host may take before we
 *  give up and retry through the proxy. Callers budget ~7-8s per fetch, so the
 *  probe must fail fast enough to leave room for the proxied retry. */
const DIRECT_PROBE_TIMEOUT_MS = 4_000;

type ProxyRequestInit = ReturnType<typeof proxyDispatcherRequestInit>;

let active: ProxyRequestInit | null = null;
let activeBuiltAt = 0;

function currentProxyRequestInit(): ProxyRequestInit['requestInit'] {
  const now = Date.now();
  if (!active || now - activeBuiltAt > PROXY_DISPATCHER_TTL_MS) {
    const expired = active;
    // undici close() is graceful (waits for in-flight requests), so retiring
    // an expired dispatcher never aborts a request still using it.
    active = proxyDispatcherRequestInit(process.env);
    activeBuiltAt = now;
    if (expired) void expired.close().catch(() => {});
  }
  return active.requestInit;
}

const routeByHost = new Map<string, { via: 'direct' | 'proxy'; at: number }>();

function cachedRoute(host: string | null): 'direct' | 'proxy' | null {
  if (!host) return null;
  const entry = routeByHost.get(host);
  if (!entry) return null;
  if (Date.now() - entry.at > ROUTE_CACHE_TTL_MS) {
    routeByHost.delete(host);
    return null;
  }
  return entry.via;
}

function rememberRoute(host: string | null, via: 'direct' | 'proxy'): void {
  if (host) routeByHost.set(host, { via, at: Date.now() });
}

function hostOf(input: string | URL): string | null {
  try {
    return new URL(typeof input === 'string' ? input : input.href).host || null;
  } catch {
    return null;
  }
}

/** `fetch` with direct-first proxy fallback. Callers keep full control of
 *  headers/redirect/signal; only the undici dispatcher (and, for the direct
 *  probe, a tighter timeout) is layered in. */
export async function brandFetch(
  input: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const proxied = currentProxyRequestInit();
  if (!proxied.dispatcher) return fetch(input, init);

  const host = hostOf(input);
  switch (cachedRoute(host)) {
    case 'direct':
      return fetch(input, init);
    case 'proxy':
      return fetch(input, { ...(init ?? {}), ...proxied });
    default:
      break;
  }

  try {
    const probeSignal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS)])
      : AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS);
    // Any HTTP response — including 4xx/5xx — proves direct connectivity; the
    // caller decides what to do with the status.
    const res = await fetch(input, { ...(init ?? {}), signal: probeSignal });
    rememberRoute(host, 'direct');
    return res;
  } catch (err) {
    // The caller gave up (its own signal fired) — don't burn more time on a
    // proxied retry it will never consume.
    if (init?.signal?.aborted) throw err;
    const res = await fetch(input, { ...(init ?? {}), ...proxied });
    rememberRoute(host, 'proxy');
    return res;
  }
}
