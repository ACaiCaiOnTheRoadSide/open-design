import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';

const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let outputDir: string;
let bundlePath: string;

function runBundle(args: string[]) {
  return spawnSync(process.execPath, [bundlePath, ...args], {
    cwd: daemonDir,
    encoding: 'utf8',
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

  it('exposes sync, file, and research help without loading daemon-native dependencies', () => {
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
  });

  it.each(['media', 'serve'])('rejects unsupported sandbox command %s', (command) => {
    const result = runBundle([command]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`unsupported sandbox command '${command}'`);
    expect(result.stderr).toContain('only supports: od sync pull|push, od file get');
    expect(result.stderr).toContain('od research search');
  });

  it('prints the restricted command surface when no command is supplied', () => {
    const result = runBundle([]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('only supports: od sync pull|push, od file get');
    expect(result.stderr).toContain('od research search');
  });
});
