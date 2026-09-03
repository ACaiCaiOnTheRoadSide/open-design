import { DEFAULT_MODEL_OPTION } from './shared.js';
import type { RuntimeAgentDef } from '../types.js';

/** Every OpenDesign turn owns one stdio session and reclaims it only after all
 * background activity and notification turns have drained. */
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
      '--stdio',
      '--permission-mode', 'bypassPermissions',
      '--cwd', cwd,
    ];
    if (options.model && options.model !== 'default') args.push('--model', options.model);
    return args;
  },
  promptViaStdin: true,
  streamFormat: 'ohmyagent-jsonl',
  resumesSessionViaCli: false,
  capturesSessionIdFromStream: false,
  defaultModelEnvVar: 'OD_OHMYAGENT_MODEL',
  externalMcpInjection: 'ohmyagent-config-file',
} satisfies RuntimeAgentDef;
