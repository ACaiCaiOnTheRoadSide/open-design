import { CHAT_TOOL_ENDPOINTS } from './tool-tokens.js';

/**
 * Endpoints a per-run agent tool token (`odtt_…`) may reach even when the
 * bound-API-token guard is active. Mirrors the chat tool-endpoint allowlist:
 * a tool token can never bypass the guard for any non-tool (admin / gateway)
 * surface.
 */
export const TOOL_TOKEN_GUARD_BYPASS_ENDPOINTS: ReadonlySet<string> = new Set(
  CHAT_TOOL_ENDPOINTS,
);

export type ApiTokenGuardDecision =
  | { allow: true }
  | { allow: false; status: number; code: string; message: string };

export interface ApiTokenGuardInput {
  /** `req.path` of the incoming `/api/*` request. */
  path: string;
  /** HTTP method, used only for the preview-asset GET bypass. */
  method: string;
  /** Raw `Authorization` header value (`''` when absent). */
  authorization: string;
  /** Configured `OD_API_TOKEN` (non-empty — the guard only runs when set). */
  apiToken: string;
  /** Whether the socket peer is a loopback address (desktop UI / local CLI). */
  isLoopbackPeer: boolean;
  /** Whether `path` is a health/readiness/version probe. */
  isOpenProbePath: boolean;
  /** Whether a GET request resolved to a valid project-preview asset scope. */
  previewAssetAllowed: boolean;
  /** Validates a bearer as a live, endpoint-scoped agent tool token. */
  isToolTokenValid: (bearer: string) => boolean;
}

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

/**
 * Decide whether a request passes the daemon's bound-API-token guard.
 *
 * Invariant (bypass precedence, first match wins):
 *   1. open probe path (health/ready/version)
 *   2. GET to a valid project-preview asset scope
 *   3. a *valid* agent tool token for a tool endpoint — the multitenant fix:
 *      a per-run agent reaches the daemon over a non-loopback hop carrying
 *      only its `odtt_` tool token (never `OD_API_TOKEN`). Letting a valid
 *      token through hands the request to the tool endpoint's own
 *      `authorizeToolRequest`, which still enforces endpoint + operation +
 *      tenant scope. This never widens access to non-tool endpoints because
 *      the path must be in TOOL_TOKEN_GUARD_BYPASS_ENDPOINTS.
 *   4. loopback peer (the localhost desktop UI / local CLI carry no bearer)
 *   5. otherwise the bearer must equal `OD_API_TOKEN`, else 401.
 */
export function decideBoundApiTokenGuard(
  input: ApiTokenGuardInput,
): ApiTokenGuardDecision {
  if (input.isOpenProbePath) return { allow: true };

  if (input.method === 'GET' && input.previewAssetAllowed) return { allow: true };

  const match = BEARER_RE.exec(input.authorization);
  const bearer = match ? match[1] : null;

  if (
    bearer &&
    TOOL_TOKEN_GUARD_BYPASS_ENDPOINTS.has(input.path) &&
    input.isToolTokenValid(bearer)
  ) {
    return { allow: true };
  }

  if (input.isLoopbackPeer) return { allow: true };

  if (!bearer || bearer !== input.apiToken) {
    return {
      allow: false,
      status: 401,
      code: 'API_TOKEN_REQUIRED',
      message: 'Authorization: Bearer <OD_API_TOKEN> required',
    };
  }

  return { allow: true };
}
