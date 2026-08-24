import type { Server } from 'node:http';

import type { StartServerOptions } from './server.js';

type StartedServer = {
  server: Server;
  url: string;
  shutdown?: () => Promise<void>;
};

export type StartedDaemonRuntime = StartedServer & {
  stop(): Promise<void>;
};

type DaemonRuntimeOptions = Omit<StartServerOptions, 'returnServer'> & {
  openBrowser?: boolean;
  logListening?: boolean;
};

export type DaemonCliStartupConfig = {
  host: string;
  open: boolean;
  port: number;
};

export type DaemonCliStartupParseResult =
  | { ok: true; config: DaemonCliStartupConfig }
  | { ok: false; kind: 'help' }
  | { ok: false; kind: 'error'; message: string };

export const DEFAULT_DAEMON_BIND_HOST = '127.0.0.1';

export function normalizeDaemonBindHost(input: unknown): string {
  const host = String(input ?? '').trim();
  return host || DEFAULT_DAEMON_BIND_HOST;
}

function requiredOptionValue(flag: string, value: string | undefined, label: string): string | DaemonCliStartupParseResult {
  if (value == null || value.startsWith('-')) {
    return { ok: false, kind: 'error', message: `${flag} requires ${label}` };
  }
  return value;
}

export function parseDaemonCliStartupArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): DaemonCliStartupParseResult {
  let port = Number(env.OD_PORT) || 7456;
  let host = normalizeDaemonBindHost(env.OD_BIND_HOST);
  let open = true;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a == null) continue;
    if (a === '-p' || a === '--port') {
      const next = requiredOptionValue(a, argv[++i], 'a port');
      if (typeof next !== 'string') return next;
      const parsedPort = Number(next);
      if (!Number.isInteger(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
        return { ok: false, kind: 'error', message: `invalid port: ${next}` };
      }
      port = parsedPort;
    } else if (a === '--host') {
      const next = requiredOptionValue(a, argv[++i], 'an address');
      if (typeof next !== 'string') return next;
      host = normalizeDaemonBindHost(next);
    } else if (a === '--no-open') {
      open = false;
    } else if (a === '-h' || a === '--help') {
      return { ok: false, kind: 'help' };
    } else if (a.startsWith('-')) {
      return { ok: false, kind: 'error', message: `unknown option: ${a}` };
    } else {
      return { ok: false, kind: 'error', message: `unknown command: od ${a}` };
    }
  }

  return { ok: true, config: { host, open, port } };
}

export async function closeHttpServer(
  server: Server,
  { closeTimeoutMs = 5_000, idleCloseMs = 1_000 } = {},
): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    let resolved = false;
    const resolveOnce = () => {
      if (resolved) return;
      resolved = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      resolveClose();
    };
    const rejectOnce = (error: Error) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(idleTimer);
      clearTimeout(hardTimer);
      rejectClose(error);
    };
    const idleTimer = setTimeout(() => {
      server.closeIdleConnections?.();
    }, Math.min(idleCloseMs, closeTimeoutMs));
    const hardTimer = setTimeout(() => {
      server.closeAllConnections?.();
      resolveOnce();
    }, closeTimeoutMs);
    idleTimer.unref?.();
    hardTimer.unref?.();
    server.close((error) => (error == null ? resolveOnce() : rejectOnce(error)));
  }).finally(() => {
    server.closeIdleConnections?.();
  });
}

export function createDaemonRuntimeStop(started: StartedServer): () => Promise<void> {
  let stopPromise: Promise<void> | undefined;
  return () => {
    if (!stopPromise) {
      stopPromise = (async () => {
        // Stop accepting work and drain already-accepted HTTP requests before
        // services (and finally PostgreSQL) are torn down. Do not swallow the
        // service barrier: callers and SIGTERM must be able to observe a failed
        // project-sync flush and exit non-zero.
        await Promise.allSettled([closeHttpServer(started.server)]);
        await (started.shutdown?.() ?? Promise.resolve());
      })();
    }
    return stopPromise;
  };
}

export async function startDaemonRuntime(options: DaemonRuntimeOptions = {}): Promise<StartedDaemonRuntime> {
  const { openBrowser: shouldOpenBrowser = false, logListening = false, ...serverOptions } = options;
  const { startServer } = await import('./server.js');
  const started = await startServer({
    ...serverOptions,
    returnServer: true,
  }) as string | StartedServer;
  if (typeof started === 'string') {
    throw new Error('daemon startServer did not return a server handle');
  }

  const stop = createDaemonRuntimeStop(started);

  if (logListening) {
    console.log(`[od] listening on ${started.url}`);
  }
  if (shouldOpenBrowser) {
    const { openBrowser } = await import('./browser/index.js');
    openBrowser(started.url);
  }

  return {
    ...started,
    stop,
  };
}

export function createDaemonSignalStop(
  runtime: Pick<StartedDaemonRuntime, 'stop'>,
  options: {
    exit?: (code: number) => void;
    logError?: (message: string, error: unknown) => void;
  } = {},
): () => Promise<void> {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const logError = options.logError ?? ((message: string, error: unknown) => console.error(message, error));
  let signalStopPromise: Promise<void> | undefined;

  return () => {
    if (!signalStopPromise) {
      signalStopPromise = runtime.stop();
      void signalStopPromise.then(
        () => exit(0),
        (error) => {
          logError('daemon graceful shutdown failed', error);
          exit(1);
        },
      );
    }
    return signalStopPromise;
  };
}

export async function runDaemonCliStartup(argv: string[], options: { printHelp?: () => void } = {}): Promise<void> {
  const parsed = parseDaemonCliStartupArgs(argv);
  if (!parsed.ok) {
    if (parsed.kind === 'error') {
      console.error(parsed.message);
      options.printHelp?.();
      process.exit(2);
    }
    options.printHelp?.();
    return;
  }
  const { host, open, port } = parsed.config;

  const runtime = await startDaemonRuntime({
    host,
    logListening: true,
    openBrowser: open,
    port,
  });
  const stop = createDaemonSignalStop(runtime);
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
