import { execFile, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileP = promisify(execFile);
let outputDir: string;
let bundlePath: string;

function runBundle(args: string[]) {
  return spawnSync(process.execPath, [bundlePath, ...args], {
    cwd: daemonDir,
    encoding: 'utf8',
  });
}

async function runBundleAsync(args: string[], env: NodeJS.ProcessEnv) {
  return execFileP(process.execPath, [bundlePath, ...args], {
    cwd: daemonDir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

beforeAll(async () => {
  outputDir = await mkdtemp(path.join(tmpdir(), 'od-cli-bundle-'));
  bundlePath = path.join(outputDir, 'od-cli.mjs');
  await build({
    entryPoints: [path.join(daemonDir, 'src/od-cli.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: bundlePath,
  });
});

afterAll(async () => {
  await rm(outputDir, { recursive: true, force: true });
});

describe('sandbox od-cli bundle contract', () => {
  it('builds from the lightweight entry point', async () => {
    const packageJson = JSON.parse(await readFile(path.join(daemonDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts['build:od-cli']).toContain('src/od-cli.ts');
    expect(packageJson.scripts['build:od-cli']).not.toContain('src/cli.ts');
    expect(packageJson.scripts['build:od-cli']).toContain('dist/od-cli.mjs');
  });

  it('exposes sync, file, research, and media help without loading daemon-native dependencies', () => {
    const sync = runBundle(['sync', '--help']);
    expect(sync.status).toBe(0);
    expect(sync.stdout).toContain('od sync pull');
    expect(sync.stdout).toContain('od sync push');

    const file = runBundle(['file', '--help']);
    expect(file.status).toBe(0);
    expect(file.stdout).toContain('od file get');

    const research = runBundle(['research', '--help']);
    expect(research.status).toBe(0);
    expect(research.stdout).toContain('od research search');
    expect(research.stdout).toContain('--providers pinterest');

    const media = runBundle(['media', '--help']);
    expect(media.status).toBe(0);
    expect(media.stdout).toContain('od media generate');
    expect(media.stdout).toContain('od media wait');
    expect(media.stdout).toContain('OD_TOOL_TOKEN');
  });

  it('rejects unsupported sandbox commands', () => {
    const result = runBundle(['serve']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unsupported sandbox command 'serve'");
    expect(result.stderr).toContain('only supports: od sync pull|push, od file get');
    expect(result.stderr).toContain('od research search');
    expect(result.stderr).toContain('od media generate|wait');
  });

  it('prints the restricted command surface when no command is supplied', () => {
    const result = runBundle([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('only supports: od sync pull|push, od file get');
    expect(result.stderr).toContain('od research search');
    expect(result.stderr).toContain('od media generate|wait');
  });

  it('generates media through the injected tool endpoint and authenticated wait endpoint', async () => {
    const requests: Array<{ url: string; authorization: string | undefined; body: unknown }> = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      request.setEncoding('utf8');
      for await (const chunk of request) raw += chunk;
      requests.push({
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(raw),
      });
      response.setHeader('content-type', 'application/json');
      if (request.url === '/api/tools/media/generate') {
        response.end(JSON.stringify({ taskId: 'task-1', status: 'queued' }));
      } else {
        response.end(JSON.stringify({
          status: 'done',
          nextSince: 1,
          file: { name: 'generated.png', size: 42, kind: 'image', mime: 'image/png' },
        }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');

    try {
      const result = await runBundleAsync(
        ['media', 'generate', '--surface', 'image', '--model', 'vela/test', '--prompt', 'pearl', '--image', 'a.png'],
        {
          OD_DAEMON_URL: `http://127.0.0.1:${address.port}`,
          OD_TOOL_TOKEN: 'sandbox-token',
          OD_PROJECT_ID: 'project-1',
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        file: { name: 'generated.png', size: 42, kind: 'image', mime: 'image/png' },
      });
      expect(requests).toHaveLength(2);
      expect(requests[0]).toMatchObject({
        url: '/api/tools/media/generate',
        authorization: 'Bearer sandbox-token',
        body: {
          surface: 'image',
          model: 'vela/test',
          prompt: 'pearl',
          image: 'a.png',
          images: ['a.png'],
        },
      });
      expect(requests[1]).toMatchObject({
        url: '/api/media/tasks/task-1/wait',
        authorization: 'Bearer sandbox-token',
        body: { since: 0 },
      });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });

  it('supports standalone authenticated media wait', async () => {
    let requestUrl = '';
    let authorization: string | undefined;
    let requestBody: unknown;
    const server = createServer(async (request, response) => {
      requestUrl = request.url ?? '';
      authorization = request.headers.authorization;
      let raw = '';
      request.setEncoding('utf8');
      for await (const chunk of request) raw += chunk;
      requestBody = JSON.parse(raw);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ status: 'done', file: { name: 'clip.mp4' } }));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind TCP');

    try {
      const result = await runBundleAsync(['media', 'wait', 'task/unsafe', '--since', '7'], {
        OD_DAEMON_URL: `http://127.0.0.1:${address.port}/`,
        OD_TOOL_TOKEN: 'sandbox-token',
        OD_PROJECT_ID: 'project-1',
      });
      expect(JSON.parse(result.stdout)).toEqual({ file: { name: 'clip.mp4' } });
      expect(requestUrl).toBe('/api/media/tasks/task%2Funsafe/wait');
      expect(authorization).toBe('Bearer sandbox-token');
      expect(requestBody).toMatchObject({ since: 7 });
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
