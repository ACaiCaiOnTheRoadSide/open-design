import { getRequestContext } from './request-context.js';
import { getPlatformDefaultProviderConfig, type PlatformExtractionConfig } from './platform-default-provider-config.js';

export const PROVIDER_CONFIG_HEADER = 'x-od-provider-config';
const MAX_PROVIDER_CONFIG_BYTES = 256 * 1024;

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

/** Validate the trusted gateway's OpenCode config without ever logging its contents. */
export function sanitizeProviderConfig(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > MAX_PROVIDER_CONFIG_BYTES) return undefined;
  try {
    const parsed = object(JSON.parse(trimmed));
    const providers = object(parsed?.provider);
    const model = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
    if (!providers || Object.keys(providers).length === 0 || !model || !model.includes('/')) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

export function parseProviderConfig(raw: string | null | undefined): JsonObject | null {
  const sanitized = sanitizeProviderConfig(raw);
  if (!sanitized) return null;
  return object(JSON.parse(sanitized));
}

export function providerConfigModel(raw: string | null | undefined): string | null {
  const parsed = parseProviderConfig(raw);
  return typeof parsed?.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null;
}

export async function resolveOpenCodeProviderConfig(): Promise<string | null> {
  const requestConfig = getRequestContext()?.providerConfig;
  if (requestConfig) return requestConfig;
  const envConfig = sanitizeProviderConfig(process.env.OD_OPENCODE_PROVIDER_CONFIG);
  if (envConfig) return envConfig;
  if (!process.env.OD_BACKEND_URL) return null;
  return getPlatformDefaultProviderConfig();
}

/** Convert the backend-generated OpenCode shape to the direct-call memory shape. */
export function extractionConfigFromProviderConfig(
  raw: string | null | undefined,
): PlatformExtractionConfig | null {
  const parsed = parseProviderConfig(raw);
  const modelId = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
  const slash = modelId.indexOf('/');
  if (slash <= 0 || slash === modelId.length - 1) return null;
  const providerId = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  const provider = object(object(parsed?.provider)?.[providerId]);
  const options = object(provider?.options);
  const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
  if (!apiKey) return null;
  const baseUrl = typeof options?.baseURL === 'string'
    ? options.baseURL.trim()
    : typeof options?.baseUrl === 'string' ? options.baseUrl.trim() : '';
  const npm = typeof provider?.npm === 'string' ? provider.npm : '';
  return {
    provider: npm.includes('anthropic') ? 'anthropic' : 'openai',
    model,
    baseUrl,
    apiKey,
  };
}
