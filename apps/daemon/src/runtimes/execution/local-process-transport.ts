import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type {
  ExecutionCancelOptions,
  ExecutionHandle,
  ExecutionResult,
  ExecutionSignal,
  ExecutionSpec,
  ExecutionTransport,
} from './transport.js';

const DEFAULT_CANCEL_GRACE_MS = 3_000;
const DEFAULT_FORCE_WAIT_MS = 500;

function positiveMs(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && (value ?? 0) >= 0 ? value! : fallback;
}

/**
 * Host-process implementation of ExecutionTransport. It is the sole owner of
 * local spawn/PID/process-group signaling semantics. In particular, callers
 * cancel an execution handle instead of signaling a PID themselves.
 */
export class LocalProcessTransport implements ExecutionTransport {
  execute(spec: ExecutionSpec): LocalProcessExecutionHandle {
    return new LocalProcessExecutionHandle(spec);
  }
}

export class LocalProcessExecutionHandle implements ExecutionHandle {
  readonly childProcess: ChildProcess;
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly started: Promise<void>;
  readonly result: Promise<ExecutionResult>;

  private settledResult: ExecutionResult | null = null;
  private cancelPromise: Promise<ExecutionResult> | null = null;

  constructor(spec: ExecutionSpec) {
    const child = spawn(spec.command, [...(spec.args ?? [])], {
      cwd: spec.cwd,
      env: spec.env,
      shell: false,
      detached: process.platform !== 'win32',
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
      stdio: [spec.stdin ?? 'ignore', 'pipe', 'pipe'],
    });
    this.childProcess = child;
    this.stdin = child.stdin;
    // stdout/stderr are invariantly piped by the transport.
    this.stdout = child.stdout!;
    this.stderr = child.stderr!;

    this.started = new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    // A caller may only care about result; avoid an unhandled rejection while
    // still preserving `started` as the explicit spawn-failure signal.
    void this.started.catch(() => undefined);

    this.result = new Promise<ExecutionResult>((resolve) => {
      let spawnError: Error | undefined;
      child.once('error', (error) => {
        spawnError = error;
      });
      child.once('close', (exitCode, signal) => {
        const result: ExecutionResult = {
          exitCode,
          signal,
          ...(spawnError ? { error: spawnError } : {}),
        };
        this.settledResult = result;
        resolve(result);
      });
    });
  }

  get pid(): number | null {
    return typeof this.childProcess.pid === 'number' ? this.childProcess.pid : null;
  }

  get processGroupId(): number | null {
    return process.platform !== 'win32' ? this.pid : null;
  }

  writeStdin(chunk: string | Uint8Array, encoding?: BufferEncoding): boolean {
    if (!this.stdin) throw new Error('Execution stdin is not available');
    return typeof chunk === 'string'
      ? this.stdin.write(chunk, encoding ?? 'utf8')
      : this.stdin.write(chunk);
  }

  endStdin(chunk?: string | Uint8Array, encoding?: BufferEncoding): void {
    if (!this.stdin || this.stdin.destroyed) return;
    if (chunk === undefined) this.stdin.end();
    else if (typeof chunk === 'string') this.stdin.end(chunk, encoding ?? 'utf8');
    else this.stdin.end(chunk);
  }

  cancel(options: ExecutionCancelOptions = {}): Promise<ExecutionResult> {
    if (this.settledResult) return Promise.resolve(this.settledResult);
    if (this.cancelPromise) return this.cancelPromise;
    this.cancelPromise = this.cancelExecution(options);
    return this.cancelPromise;
  }

  dispose(): void {
    for (const stream of [this.childProcess.stdin, this.stdout, this.stderr]) {
      if (!stream) continue;
      try { stream.removeAllListeners(); } catch {}
      try { stream.destroy(); } catch {}
    }
  }

  private async cancelExecution(options: ExecutionCancelOptions): Promise<ExecutionResult> {
    this.endStdin();
    this.signal('SIGTERM');
    const graceMs = positiveMs(options.graceMs, DEFAULT_CANCEL_GRACE_MS);
    // A direct CLI may exit on SIGTERM while an MCP/tool grandchild in the
    // same group ignores it. Keep the captured-group escalation alive even if
    // the direct child's result resolves first; this is generation-safe because
    // each local execution starts as its own detached group leader.
    let groupEscalation: NodeJS.Timeout | null = null;
    if (this.processGroupId !== null) {
      groupEscalation = setTimeout(() => this.signalProcessGroup('SIGKILL'), graceMs);
      groupEscalation.unref?.();
    }
    const graceful = await this.waitForResult(graceMs);
    if (graceful) return graceful;
    if (groupEscalation) clearTimeout(groupEscalation);
    this.signal('SIGKILL');
    return (await this.waitForResult(positiveMs(options.forceWaitMs, DEFAULT_FORCE_WAIT_MS)))
      ?? { exitCode: null, signal: 'SIGKILL' };
  }

  private signalProcessGroup(signal: ExecutionSignal): boolean {
    const processGroupId = this.processGroupId;
    if (processGroupId === null) return false;
    try {
      process.kill(-processGroupId, signal);
      return true;
    } catch {
      return false;
    }
  }

  private signal(signal: ExecutionSignal): boolean {
    if (this.settledResult) return false;
    if (this.signalProcessGroup(signal)) return true;
    try {
      return this.childProcess.kill(signal);
    } catch {
      return false;
    }
  }

  private async waitForResult(timeoutMs: number): Promise<ExecutionResult | null> {
    if (this.settledResult) return this.settledResult;
    if (timeoutMs === 0) return null;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      timer.unref?.();
      void this.result.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });
  }
}
