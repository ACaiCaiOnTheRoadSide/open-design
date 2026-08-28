import { describe, expect, it } from 'vitest';
import { ohmyagentAgentDef } from '../../src/runtimes/defs/ohmyagent.js';

const ctx = { cwd: '/workspace/project' };

describe('OhMyAgent runtime args', () => {
  it('uses headless stdin JSONL with bypass permissions and cwd', () => {
    expect(ohmyagentAgentDef.buildArgs('secret prompt', [], [], { model: 'gpt-5' }, ctx)).toEqual([
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--cwd', '/workspace/project',
      '--model', 'gpt-5',
    ]);
    expect(ohmyagentAgentDef.promptViaStdin).toBe(true);
    expect(ohmyagentAgentDef.bin).toBe('ohmyagent');
  });

  it('resumes only its daemon agent_sessions id and references config files', () => {
    expect(ohmyagentAgentDef.buildArgs('', [], [], {}, {
      ...ctx,
      resumeSessionId: 'oma-session',
      ohmyagentModelConfigPath: '/tmp/model.json',
      ohmyagentMcpConfigPath: '/tmp/mcp.json',
    })).toContainEqual('--resume');
    const args = ohmyagentAgentDef.buildArgs('', [], [], {}, {
      ...ctx,
      resumeSessionId: 'oma-session',
      ohmyagentModelConfigPath: '/tmp/model.json',
      ohmyagentMcpConfigPath: '/tmp/mcp.json',
    });
    expect(args).toEqual(expect.arrayContaining([
      '--resume', 'oma-session', '--model-config', '@/tmp/model.json', '--mcp-config', '@/tmp/mcp.json',
    ]));
    expect(ohmyagentAgentDef.capturesSessionIdFromStream).toBe(true);
  });
});
