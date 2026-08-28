import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

/**
 * OhMyAgent headless JSONL contract, verified against cmd/ohmyagent/root.go:
 * a non-terminal stdin selects headless mode; --output-format json installs
 * JSONLinesSink; --resume accepts the engine-owned session id.
 */
export const ohmyagentAgentDef = {
  id: 'ohmyagent',
  name: 'OhMyAgent',
  bin: 'ohmyagent',
  versionArgs: ['--version'],
  fallbackModels: [DEFAULT_MODEL_OPTION],
  buildArgs: (_prompt, _images, _extra, options = {}, runtimeContext = {}) => {
    const cwd = runtimeContext.cwd?.trim();
    if (!cwd) throw new Error('ohmyagent requires runtimeContext.cwd');
    const args = [
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--cwd', cwd,
    ];
    if (options.model && options.model !== 'default') args.push('--model', options.model);
    if (runtimeContext.resumeSessionId) args.push('--resume', runtimeContext.resumeSessionId);
    if (runtimeContext.ohmyagentModelConfigPath) {
      args.push('--model-config', `@${runtimeContext.ohmyagentModelConfigPath}`);
    }
    if (runtimeContext.ohmyagentMcpConfigPath) {
      args.push('--mcp-config', `@${runtimeContext.ohmyagentMcpConfigPath}`);
    }
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'ohmyagent-jsonl',
  resumesSessionViaCli: true,
  capturesSessionIdFromStream: true,
  externalMcpInjection: 'ohmyagent-config-file',
} satisfies RuntimeAgentDef;
