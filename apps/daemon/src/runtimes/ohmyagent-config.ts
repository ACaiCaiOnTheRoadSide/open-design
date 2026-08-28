import type { ByokChatProviderConfig } from '@open-design/contracts';

export const OHMYAGENT_API_KEY_ENV = 'OPEN_DESIGN_OHMYAGENT_API_KEY';

export interface OhMyAgentRuntimeModelConfig {
  config: Record<string, unknown>;
  env: Record<string, string>;
}

/** Convert OpenDesign's run-scoped provider contract to OhMyAgent RuntimeModelConfig. */
export function buildOhMyAgentModelConfig(
  provider: ByokChatProviderConfig | null | undefined,
  requestedModel: string | null | undefined,
): OhMyAgentRuntimeModelConfig | null {
  if (!provider || typeof provider !== 'object') return null;
  const model = (requestedModel ?? provider.model ?? '').trim();
  if (!model || model === 'default') return null;
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
  const config: Record<string, unknown> = {
    name: 'open-design-runtime',
    type,
    model,
    ...(baseUrl ? { base_url: baseUrl.replace(/\/+$/u, '') } : {}),
    ...(apiKey ? { api_key: `env:${OHMYAGENT_API_KEY_ENV}` } : {}),
  };
  return { config, env: apiKey ? { [OHMYAGENT_API_KEY_ENV]: apiKey } : {} };
}
