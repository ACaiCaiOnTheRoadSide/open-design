import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { LocalProcessTransport } from '../../../src/runtimes/execution/local-process-transport.js';

const transport = new LocalProcessTransport();

async function read(stream: NodeJS.ReadableStream): Promise<string> {
  let value = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => { value += String(chunk); });
  await once(stream, 'end');
  return value;
}

describe('LocalProcessTransport', () => {
  it('streams stdout and stderr and reports a clean exit', async () => {
    const handle = transport.execute({
      command: process.execPath,
      args: ['-e', "process.stdout.write('out'); process.stderr.write('err')"],
      stdin: 'ignore',
    });

    const [stdout, stderr, result] = await Promise.all([
      read(handle.stdout),
      read(handle.stderr),
      handle.result,
    ]);

    expect(stdout).toBe('out');
    expect(stderr).toBe('err');
    expect(result).toEqual({ exitCode: 0, signal: null });
    expect(handle.pid).toBeTypeOf('number');
  });

  it('writes stdin and reports a non-zero exit', async () => {
    const handle = transport.execute({
      command: process.execPath,
      args: ['-e', "process.stdin.pipe(process.stdout); process.stdin.on('end', () => { process.exitCode = 7 })"],
      stdin: 'pipe',
    });
    const stdout = read(handle.stdout);

    expect(handle.writeStdin('prompt')).toBe(true);
    handle.endStdin();

    await expect(stdout).resolves.toBe('prompt');
    await expect(handle.result).resolves.toEqual({ exitCode: 7, signal: null });
  });

  it('surfaces spawn errors through started and result', async () => {
    const handle = transport.execute({
      command: `definitely-missing-open-design-agent-${process.pid}`,
      stdin: 'ignore',
    });

    await expect(handle.started).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(handle.result).resolves.toMatchObject({
      exitCode: -2,
      signal: null,
      error: expect.objectContaining({ code: 'ENOENT' }),
    });
  });

  it('cancels the process group with SIGTERM', async () => {
    const handle = transport.execute({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => process.exit(0)); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      stdin: 'ignore',
    });
    await once(handle.stdout, 'data');

    const result = await handle.cancel({ graceMs: 1_000, forceWaitMs: 500 });

    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    await expect(handle.cancel()).resolves.toEqual(result);
  });

  it('escalates cancellation to SIGKILL when SIGTERM is ignored', async () => {
    const handle = transport.execute({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"],
      stdin: 'ignore',
    });
    await once(handle.stdout, 'data');

    const result = await handle.cancel({ graceMs: 20, forceWaitMs: 1_000 });

    expect(result).toMatchObject({ exitCode: null, signal: 'SIGKILL' });
  });
});
