import type { ByokChatProviderConfig } from '@open-design/contracts';

import { parseProviderConfig } from '../runtime-provider-config.js';

export const OHMYAGENT_API_KEY_ENV = 'OPEN_DESIGN_OHMYAGENT_API_KEY';

export function ohmyagentProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ByokChatProviderConfig | null {
  const protocol = env.OD_OHMYAGENT_MODEL_PROTOCOL?.trim();
  const model = env.OD_OHMYAGENT_MODEL?.trim();
  if (!model || (protocol !== 'anthropic' && protocol !== 'openai' && protocol !== 'ollama')) return null;
  const baseUrl = env.OD_OHMYAGENT_MODEL_BASE_URL?.trim();
  return {
    protocol,
    model,
    apiKey: env.OD_OHMYAGENT_MODEL_API_KEY?.trim() ?? '',
    ...(baseUrl ? { baseUrl } : {}),
    requiresApiKey: protocol !== 'ollama',
  };
}

export interface OhMyAgentRuntimeModelConfig {
  config: Record<string, unknown>;
  env: Record<string, string>;
}

type OhMyAgentProviderType = 'anthropic' | 'openai-chat' | 'openai-responses';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function runtimeModelConfig(
  type: OhMyAgentProviderType,
  model: string,
  baseUrl: string,
  apiKey: string,
): OhMyAgentRuntimeModelConfig | null {
  if (!model || !apiKey) return null;
  if (baseUrl) {
    try { new URL(baseUrl); } catch { return null; }
  }
  return {
    config: {
      name: 'open-design-runtime',
      type,
      model,
      ...(baseUrl ? { base_url: baseUrl.replace(/\/+$/u, '') } : {}),
      api_key: `env:${OHMYAGENT_API_KEY_ENV}`,
    },
    env: { [OHMYAGENT_API_KEY_ENV]: apiKey },
  };
}

/** Convert the trusted backend/OpenCode provider shape to OhMyAgent RuntimeModelConfig. */
export function buildOhMyAgentModelConfigFromProviderConfig(
  raw: string | null | undefined,
  requestedModel: string | null | undefined,
): OhMyAgentRuntimeModelConfig | null {
  const parsed = parseProviderConfig(raw);
  const configuredModelId = typeof parsed?.model === 'string' ? parsed.model.trim() : '';
  const slash = configuredModelId.indexOf('/');
  if (slash <= 0 || slash === configuredModelId.length - 1) return null;
  const providerId = configuredModelId.slice(0, slash);
  const configuredModel = configuredModelId.slice(slash + 1);
  const provider = object(object(parsed?.provider)?.[providerId]);
  const options = object(provider?.options);
  const apiKey = typeof options?.apiKey === 'string' ? options.apiKey.trim() : '';
  const baseUrl = typeof options?.baseURL === 'string'
    ? options.baseURL.trim()
    : typeof options?.baseUrl === 'string' ? options.baseUrl.trim() : '';
  const npm = typeof provider?.npm === 'string' ? provider.npm.trim() : '';
  const type: OhMyAgentProviderType | null = npm === '@ai-sdk/anthropic'
    ? 'anthropic'
    : npm === '@ai-sdk/openai'
      ? 'openai-responses'
      : npm === '@ai-sdk/openai-compatible'
        ? 'openai-chat'
        : null;
  if (!type) return null;
  const requested = requestedModel?.trim() ?? '';
  const model = requested && requested !== 'default'
    ? (requested.startsWith(`${providerId}/`) ? requested.slice(providerId.length + 1) : requested)
    : configuredModel;
  return runtimeModelConfig(type, model, baseUrl, apiKey);
}

/** Convert OpenDesign's run-scoped provider contract to OhMyAgent RuntimeModelConfig. */
export function buildOhMyAgentModelConfig(
  provider: ByokChatProviderConfig | null | undefined,
  requestedModel: string | null | undefined,
): OhMyAgentRuntimeModelConfig | null {
  if (!provider || typeof provider !== 'object') return null;
  const requested = requestedModel?.trim();
  const model = (requested && requested !== 'default' ? requested : provider.model ?? '').trim();
  if (!model) return null;
  const baseUrl = provider.baseUrl?.trim();
  const apiKey = provider.apiKey?.trim() ?? '';
  const keyRequired = provider.requiresApiKey !== false && provider.protocol !== 'ollama';
  if (keyRequired && !apiKey) return null;

  // OhMyAgent provider.NewFromConfig supports exactly these wire types.
  let realOpenAI = !baseUrl;
  if (baseUrl) {
    try { realOpenAI = new URL(baseUrl).hostname === 'api.openai.com'; } catch { return null; }
  }
  const type = provider.protocol === 'anthropic'
    ? 'anthropic'
    : provider.protocol === 'openai' && realOpenAI
      ? 'openai-responses'
      : 'openai-chat';
  if (!keyRequired && !apiKey) {
    return {
      config: {
        name: 'open-design-runtime', type, model,
        ...(baseUrl ? { base_url: baseUrl.replace(/\/+$/u, '') } : {}),
      },
      env: {},
    };
  }
  return runtimeModelConfig(type, model, baseUrl ?? '', apiKey);
}
