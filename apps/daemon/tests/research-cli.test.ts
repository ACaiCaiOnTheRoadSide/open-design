import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { splitResearchSubcommand } from '../src/research/cli-args.js';
import { runSandboxResearch } from '../src/research/cli-run.js';

describe('research CLI', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OD_TOOL_TOKEN;
    delete process.env.OD_DAEMON_URL;
  });
  it('preserves query values equal to the search subcommand', () => {
    expect(
      splitResearchSubcommand([
        'search',
        '--query',
        'search',
        '--daemon-url',
        'http://127.0.0.1:7456',
      ]),
    ).toEqual({
      sub: 'search',
      subArgs: ['--query', 'search', '--daemon-url', 'http://127.0.0.1:7456'],
    });
  });

  it('uses the scoped tool route and bearer token from the lightweight bundle', async () => {
    let request: { url?: string; authorization?: string; body?: unknown } = {};
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        request = {
          ...(req.url ? { url: req.url } : {}),
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
        };
        res.setHeader('content-type', 'application/json');
        res.end('{"provider":"pinterest","sources":[]}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    process.env.OD_DAEMON_URL = `http://127.0.0.1:${address.port}`;
    process.env.OD_TOOL_TOKEN = 'odtt_scoped';
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await runSandboxResearch(['search', '--query', 'mobile checkout', '--max-sources', '20', '--providers', 'pinterest']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(request).toEqual({
      url: '/api/tools/research/search',
      authorization: 'Bearer odtt_scoped',
      body: { query: 'mobile checkout', providers: ['pinterest'], maxSources: 20 },
    });
    expect(stdout).toHaveBeenCalledWith('{"provider":"pinterest","sources":[]}\n');
  });
});
