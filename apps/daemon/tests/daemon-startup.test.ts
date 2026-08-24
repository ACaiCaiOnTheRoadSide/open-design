import { describe, expect, it, vi } from 'vitest';

import type { Server } from 'node:http';
import {
  createDaemonRuntimeStop,
  createDaemonSignalStop,
  parseDaemonCliStartupArgs,
} from '../src/daemon-startup.js';

describe('daemon runtime shutdown ordering', () => {
  it('drains accepted HTTP work before service/pool shutdown and is idempotent', async () => {
    const events: string[] = [];
    let finishDrain: (() => void) | undefined;
    const server = {
      listening: true,
      close(callback: (error?: Error) => void) {
        events.push('http-drain-start');
        finishDrain = () => {
          events.push('http-drain-complete');
          callback();
        };
      },
      closeIdleConnections() {},
    } as unknown as Server;
    const stop = createDaemonRuntimeStop({
      server,
      url: 'http://127.0.0.1:0',
      shutdown: async () => { events.push('services-and-pool-shutdown'); },
    });

    const first = stop();
    const second = stop();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(events).toEqual(['http-drain-start']);

    finishDrain?.();
    await first;
    expect(events).toEqual([
      'http-drain-start',
      'http-drain-complete',
      'services-and-pool-shutdown',
    ]);
  });

  it('a second termination signal waits for the same graceful stop', async () => {
    let finishStop!: () => void;
    const pendingStop = new Promise<void>((resolve) => { finishStop = resolve; });
    const stop = vi.fn(() => pendingStop);
    const exit = vi.fn();
    const onSignal = createDaemonSignalStop({ stop }, { exit });

    const first = onSignal();
    const second = onSignal();

    expect(second).toBe(first);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();

    finishStop();
    await first;
    await Promise.resolve();
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('propagates a graceful service barrier failure after HTTP drain', async () => {
    const server = {
      listening: true,
      close(callback: (error?: Error) => void) { callback(); },
      closeIdleConnections() {},
    } as unknown as Server;
    const stop = createDaemonRuntimeStop({
      server,
      url: 'http://127.0.0.1:0',
      shutdown: async () => { throw new Error('project sync flush failed'); },
    });

    await expect(stop()).rejects.toThrow('project sync flush failed');
  });
});

describe('daemon startup CLI parsing', () => {
  it('parses the documented daemon startup flags', () => {
    expect(parseDaemonCliStartupArgs(['--host', '0.0.0.0', '--port', '8123', '--no-open'], {})).toEqual({
      ok: true,
      config: {
        host: '0.0.0.0',
        open: false,
        port: 8123,
      },
    });
  });

  it('uses environment defaults when startup flags are omitted', () => {
    expect(parseDaemonCliStartupArgs([], { OD_BIND_HOST: '127.0.0.2', OD_PORT: '7345' })).toEqual({
      ok: true,
      config: {
        host: '127.0.0.2',
        open: true,
        port: 7345,
      },
    });
  });

  it('falls back to loopback when bind host input is blank', () => {
    expect(parseDaemonCliStartupArgs([], { OD_BIND_HOST: '   ' })).toEqual({
      ok: true,
      config: {
        host: '127.0.0.1',
        open: true,
        port: 7456,
      },
    });
    expect(parseDaemonCliStartupArgs(['--host', '   '], {})).toEqual({
      ok: true,
      config: {
        host: '127.0.0.1',
        open: true,
        port: 7456,
      },
    });
  });

  it('rejects browser snapshot instead of treating it as daemon startup', () => {
    expect(parseDaemonCliStartupArgs(['browser', 'snapshot', '--url', 'https://example.test/'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: 'unknown command: od browser',
    });
  });

  it('rejects unknown daemon startup options', () => {
    expect(parseDaemonCliStartupArgs(['--url', 'https://example.test/'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: 'unknown option: --url',
    });
  });

  it('rejects flag-shaped values for required daemon startup options', () => {
    expect(parseDaemonCliStartupArgs(['--host', '--no-open'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: '--host requires an address',
    });
    expect(parseDaemonCliStartupArgs(['--port', '--no-open'], {})).toEqual({
      ok: false,
      kind: 'error',
      message: '--port requires a port',
    });
  });
});
