import { describe, expect, it } from 'vitest';
import { ohmyagentAgentDef } from '../../src/runtimes/defs/ohmyagent.js';

const ctx = { cwd: '/workspace/project' };

describe('OhMyAgent runtime args', () => {
  it('uses JSON-RPC stdio with bypass permissions and cwd', () => {
    expect(ohmyagentAgentDef.buildArgs('secret prompt', [], [], { model: 'gpt-5' }, ctx)).toEqual([
      '--stdio',
      '--permission-mode', 'bypassPermissions',
      '--cwd', '/workspace/project',
      '--model', 'gpt-5',
    ]);
    expect(ohmyagentAgentDef.promptViaStdin).toBe(true);
    expect(ohmyagentAgentDef.bin).toBe('ohmyagent');
  });

  it('starts fresh even when a prior session id is present and references config files', () => {
    const args = ohmyagentAgentDef.buildArgs('', [], [], {}, {
      ...ctx,
      resumeSessionId: 'stale-oma-session',
      ohmyagentModelConfigPath: '/tmp/model.json',
      ohmyagentMcpConfigPath: '/tmp/mcp.json',
    });
    expect(args).not.toContain('--resume');
    expect(args).toEqual(expect.arrayContaining([
      '--model-config', '@/tmp/model.json', '--mcp-config', '@/tmp/mcp.json',
    ]));
    expect(ohmyagentAgentDef.resumesSessionViaCli).toBe(false);
    expect(ohmyagentAgentDef.capturesSessionIdFromStream).toBe(false);
    expect(ohmyagentAgentDef.defaultModelEnvVar).toBe('OD_OHMYAGENT_MODEL');
  });
});
