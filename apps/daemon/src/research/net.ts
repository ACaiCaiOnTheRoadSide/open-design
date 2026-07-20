// Direct-first, proxy-fallback egress for research providers.
//
// Two deployment facts drive this module:
//
//   1. The daemon inherits a DIFFERENT proxy than the agent. In cluster
//      deployments the agent reaches the open internet through OD_AGENT_PROXY
//      (it runs `curl --proxy $OD_AGENT_PROXY`, see prompts/discovery.ts),
//      while Node's undici honors the ambient HTTP(S)_PROXY — which may point
//      at a proxy that cannot reach the public internet at all. Research egress
//      must unify on the agent's proxy, so when OD_AGENT_PROXY is set we resolve
//      it here and ignore the ambient HTTP(S)_PROXY.
//
//   2. The proxy must NOT be the default route. Origins the cluster reaches
//      directly (Pinterest among them) fail when forced through the proxy. So
//      egress is DIRECT-FIRST: try the origin directly under a short probe
//      timeout, and only when the direct attempt errors out fall back to the
//      (agent) proxy for one retry. This mirrors brands/net.ts:brandFetch, but
//      sourced from OD_AGENT_PROXY instead of the ambient proxy env.

import { proxyDispatcherRequestInit } from '../connectionTest.js';

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

/** How long a direct attempt may run before we give up and retry via proxy.
 *  Generous enough for a legitimately-reachable origin (Pinterest answers in
 *  ~3s from the cluster), tight enough that a blocked/hung direct route still
 *  leaves budget for the proxied retry inside each provider's overall timeout. */
const DIRECT_PROBE_TIMEOUT_MS = 8_000;

/**
 * Resolve the proxy env research egress should use, unified with the agent's
 * proxy. When OD_AGENT_PROXY is set it wins over every ambient proxy var so
 * research dials the same proxy the agent does; otherwise returns null, meaning
 * "fall back to the ambient proxy env" (local dev / non-cluster, unchanged).
 */
export function resolveResearchProxyEnv(
  env: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | null {
  const agentProxy = env.OD_AGENT_PROXY?.trim();
  if (!agentProxy) return null;
  const noProxy = env.NO_PROXY ?? env.no_proxy;
  return {
    HTTP_PROXY: agentProxy,
    HTTPS_PROXY: agentProxy,
    ALL_PROXY: agentProxy,
    ...(noProxy ? { NO_PROXY: noProxy } : {}),
  };
}

/** Build the (agent-unified) proxy dispatcher for a single research call. The
 *  caller owns the returned `close()` and must invoke it once the call settles. */
export function researchProxyRequestInit(
  env: NodeJS.ProcessEnv = process.env,
): ReturnType<typeof proxyDispatcherRequestInit> {
  return proxyDispatcherRequestInit(resolveResearchProxyEnv(env) ?? env);
}

/**
 * Wrap fetch so each request is tried DIRECT first and only retried through
 * `proxied` when the direct attempt fails. When no proxy is configured every
 * request is plain-direct.
 */
export function directFirstFetch(
  proxied: Pick<RequestInit, 'dispatcher'>,
): FetchLike {
  if (!proxied.dispatcher) {
    return (input, init) => fetch(input, init);
  }
  return async (input, init) => {
    try {
      const probeSignal = init?.signal
        ? AbortSignal.any([
            init.signal,
            AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS),
          ])
        : AbortSignal.timeout(DIRECT_PROBE_TIMEOUT_MS);
      // Any HTTP response — including 4xx/5xx — proves direct connectivity; the
      // caller decides what to do with the status.
      return await fetch(input, { ...(init ?? {}), signal: probeSignal });
    } catch (err) {
      // The caller's own signal fired (its overall timeout / abort) — don't
      // burn a proxied retry it will never consume.
      if (init?.signal?.aborted) throw err;
      return await fetch(input, { ...(init ?? {}), ...proxied });
    }
  };
}
