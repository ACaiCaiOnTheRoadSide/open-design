import { afterEach, describe, expect, it, vi } from 'vitest';

const original = process.env.OD_ALLOWED_AGENTS;
afterEach(() => {
  if (original === undefined) delete process.env.OD_ALLOWED_AGENTS;
  else process.env.OD_ALLOWED_AGENTS = original;
  vi.resetModules();
});

describe('OD_ALLOWED_AGENTS', () => {
  it('filters runtime registration to the configured ids', async () => {
    process.env.OD_ALLOWED_AGENTS = 'opencode';
    vi.resetModules();
    const registry = await import('../src/runtimes/registry.js');
    expect(registry.AGENT_DEFS.map((agent) => agent.id)).toEqual(['opencode']);
    expect(registry.getAgentDef('claude')).toBeNull();
  });

  it('fails closed for an unknown configured id', async () => {
    process.env.OD_ALLOWED_AGENTS = 'not-a-runtime';
    vi.resetModules();
    const registry = await import('../src/runtimes/registry.js');
    expect(registry.AGENT_DEFS).toEqual([]);
  });
});
