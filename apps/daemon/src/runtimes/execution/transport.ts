import type { Readable, Writable } from 'node:stream';

export type ExecutionSignal = NodeJS.Signals;

export interface ExecutionSpec {
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Values explicitly constructed for this run's remote executor. */
  remoteEnv?: NodeJS.ProcessEnv;
  stdin?: 'pipe' | 'ignore';
  windowsVerbatimArguments?: boolean;
}

export interface ExecutionResult {
  exitCode: number | null;
  signal: ExecutionSignal | null;
  error?: Error;
}

export interface ExecutionCancelOptions {
  /** Time allowed after SIGTERM before escalating to SIGKILL. */
  graceMs?: number;
  /** Final bounded wait after SIGKILL. */
  forceWaitMs?: number;
}

export interface ExecutionHandle {
  /** Present for local execution; remote transports must not invent one. */
  readonly pid: number | null;
  /** Present only when the transport owns an OS process group. */
  readonly processGroupId: number | null;
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Rejects when the execution cannot be started (for example ENOENT). */
  readonly started: Promise<void>;
  /** Resolves once output streams and execution have closed. */
  readonly result: Promise<ExecutionResult>;
  writeStdin(chunk: string | Uint8Array, encoding?: BufferEncoding): boolean;
  endStdin(chunk?: string | Uint8Array, encoding?: BufferEncoding): void;
  cancel(options?: ExecutionCancelOptions): Promise<ExecutionResult>;
  dispose(): void;
}

export interface ExecutionTransport {
  execute(spec: ExecutionSpec): ExecutionHandle;
}
