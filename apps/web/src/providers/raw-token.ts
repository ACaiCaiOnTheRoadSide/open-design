/**
 * Signed-token access for project raw assets that load INSIDE the sandboxed
 * preview iframe.
 *
 * The preview iframe runs with `sandbox="allow-scripts"` (no
 * `allow-same-origin`), so its document has an opaque origin. Sub-resource
 * loads and in-document navigations it makes (relative <img>, multi-page
 * <a href>, url-loaded iframe src) are treated as cross-site by the browser,
 * which strips SameSite cookies. Behind a login-cookie gateway those requests
 * then 401 — images vanish and clicking a link white-screens.
 *
 * od-web itself runs in a cookie-carrying (studio) iframe, so it can exchange
 * its session for a short-lived HMAC token scoped to one project via
 * `GET /api/projects/:id/raw-token`. Sandbox-facing URLs then use the
 * cookie-free form `/raw-signed/<token>/<projectId>/<path>`, which the gateway
 * lets through and the backend verifies.
 *
 * When the endpoint is unavailable (501 = feature off, e.g. local/dev without
 * the secret, or an older backend) we fall back to the plain `/raw/` URL so
 * behavior is unchanged wherever cookies already flow (desktop, same-origin).
 */

import { useEffect, useReducer } from 'react';

interface TokenEntry {
  token: string;
  /** Expiry as epoch seconds (mirrors the backend claim). */
  exp: number;
}

// Refresh a bit before the hard expiry so an in-flight preview never renders a
// URL whose token dies mid-load.
const REFRESH_SKEW_MS = 60_000;

const cache = new Map<string, TokenEntry>();
const inflight = new Map<string, Promise<string | null>>();
const listeners = new Set<() => void>();

function isFresh(entry: TokenEntry | undefined): entry is TokenEntry {
  return !!entry && Date.now() < entry.exp * 1000 - REFRESH_SKEW_MS;
}

/**
 * Synchronously read a still-fresh cached token, or null. Safe to call during
 * render — never triggers a fetch.
 */
export function cachedRawToken(projectId: string): string | null {
  const entry = cache.get(projectId);
  return isFresh(entry) ? entry.token : null;
}

/**
 * Ensure a fresh token for `projectId` is (being) fetched. Dedupes concurrent
 * callers and notifies `useRawToken` subscribers when a new token lands.
 * Resolves to the token, or null if the feature is off / the request failed
 * (callers then fall back to the plain `/raw/` URL).
 */
export function ensureRawToken(projectId: string): Promise<string | null> {
  const fresh = cachedRawToken(projectId);
  if (fresh) return Promise.resolve(fresh);

  const pending = inflight.get(projectId);
  if (pending) return pending;

  const request = (async (): Promise<string | null> => {
    try {
      const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/raw-token`, {
        cache: 'no-store',
      });
      if (!resp.ok) return null;
      const data = (await resp.json()) as { token?: unknown; exp?: unknown };
      if (typeof data.token !== 'string' || typeof data.exp !== 'number') return null;
      cache.set(projectId, { token: data.token, exp: data.exp });
      notify();
      return data.token;
    } catch {
      return null;
    } finally {
      inflight.delete(projectId);
    }
  })();

  inflight.set(projectId, request);
  return request;
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe a component to the raw token for `projectId`. Kicks off a fetch on
 * mount, re-renders when the token arrives, and re-fetches shortly before
 * expiry so a long-open preview keeps working. Returns the current fresh token
 * or null (fall back to `/raw/`).
 */
export function useRawToken(projectId: string | null | undefined): string | null {
  const [, forceRender] = useReducer((n: number) => n + 1, 0);

  useEffect(() => {
    if (!projectId) return;
    const listener = () => forceRender();
    listeners.add(listener);
    let timer: ReturnType<typeof setTimeout> | undefined;

    const pump = () => {
      void ensureRawToken(projectId).then(() => {
        const entry = cache.get(projectId);
        if (!entry) return;
        // Schedule the next refresh just before this token goes stale.
        const dueMs = Math.max(1_000, entry.exp * 1000 - REFRESH_SKEW_MS - Date.now());
        timer = setTimeout(pump, dueMs);
      });
    };
    pump();

    return () => {
      listeners.delete(listener);
      if (timer) clearTimeout(timer);
    };
  }, [projectId]);

  return projectId ? cachedRawToken(projectId) : null;
}
