export interface HuskboxExecutionConfig {
  baseUrl: string;
  apiKey?: string;
  tenantId: string;
  sandboxMount: string;
  daemonMount: string;
  daemonPublicUrl?: string;
  backendPublicUrl?: string;
  retryMaxAttempts: number;
  retryBaseMs: number;
  requestTimeoutMs: number;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function huskboxExecutionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HuskboxExecutionConfig {
  const baseUrl = env.OD_HUSKBOX_BASE_URL?.trim();
  const tenantId = env.OD_HUSKBOX_TENANT_ID?.trim();
  if (!baseUrl) throw new Error('OD_HUSKBOX_BASE_URL is required for huskbox execution');
  if (!tenantId) throw new Error('OD_HUSKBOX_TENANT_ID is required for huskbox execution');
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OD_HUSKBOX_BASE_URL must use http or https');
  }
  if (parsed.search || parsed.hash) throw new Error('OD_HUSKBOX_BASE_URL must not contain query or fragment');
  return {
    baseUrl: parsed.toString().replace(/\/$/u, ''),
    ...(env.OD_HUSKBOX_API_KEY?.trim() ? { apiKey: env.OD_HUSKBOX_API_KEY.trim() } : {}),
    tenantId,
    sandboxMount: env.OD_HUSKBOX_SANDBOX_MOUNT?.trim() || '/workspace',
    daemonMount: env.OD_HUSKBOX_DAEMON_MOUNT?.trim() || '/data',
    ...(env.OD_HUSKBOX_DAEMON_PUBLIC_URL?.trim() ? { daemonPublicUrl: env.OD_HUSKBOX_DAEMON_PUBLIC_URL.trim().replace(/\/$/u, '') } : {}),
    ...(env.OD_HUSKBOX_BACKEND_PUBLIC_URL?.trim() ? { backendPublicUrl: env.OD_HUSKBOX_BACKEND_PUBLIC_URL.trim().replace(/\/$/u, '') } : {}),
    retryMaxAttempts: positiveInteger(env.OD_HUSKBOX_RETRY_MAX_ATTEMPTS, 4),
    retryBaseMs: positiveInteger(env.OD_HUSKBOX_RETRY_BASE_MS, 2_000),
    requestTimeoutMs: positiveInteger(env.OD_HUSKBOX_REQUEST_TIMEOUT_MS, 10_000),
  };
}

export type ExecutionTransportKind = 'local' | 'huskbox';
export function executionTransportKind(env: NodeJS.ProcessEnv = process.env): ExecutionTransportKind {
  const value = env.OD_EXECUTION_TRANSPORT?.trim() || 'local';
  if (value !== 'local' && value !== 'huskbox') throw new Error(`Unsupported OD_EXECUTION_TRANSPORT: ${value}`);
  return value;
}
