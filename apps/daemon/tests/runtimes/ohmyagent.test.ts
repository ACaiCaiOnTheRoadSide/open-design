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

  it('starts fresh without passing session configs as stdio CLI flags', () => {
    const args = ohmyagentAgentDef.buildArgs('', [], [], {}, {
      ...ctx,
      resumeSessionId: 'stale-oma-session',
      ohmyagentModelConfigPath: '/tmp/model.json',
      ohmyagentMcpConfigPath: '/tmp/mcp.json',
    });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('--model-config');
    expect(args).not.toContain('--mcp-config');
    expect(ohmyagentAgentDef.resumesSessionViaCli).toBe(false);
    expect(ohmyagentAgentDef.capturesSessionIdFromStream).toBe(false);
    expect(ohmyagentAgentDef.defaultModelEnvVar).toBe('OD_OHMYAGENT_MODEL');
  });
});
