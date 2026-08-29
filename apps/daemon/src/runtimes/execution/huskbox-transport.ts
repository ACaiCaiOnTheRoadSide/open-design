import { randomUUID } from 'node:crypto';
import { PassThrough, type Readable, type Writable } from 'node:stream';

import type { HuskboxExecutionConfig } from './huskbox-config.js';
import {
  HuskboxClient,
  HuskboxHttpError,
  type HuskboxApiError,
  type HuskboxExecuteRequest,
  type HuskboxExecutionStatus,
} from './huskbox-client.js';
import type {
  ExecutionCancelOptions,
  ExecutionHandle,
  ExecutionResult,
  ExecutionSpec,
  ExecutionTransport,
} from './transport.js';

const RETRY_MARKER = '[od-retry]';
const DEFAULT_FAILURE_EXIT = 127;
const SANDBOX_HOME = '/home/sandbox';
const SANDBOX_PATH = '/usr/local/bin:/usr/bin:/bin';

// Fixed names only: these sets are the credential boundary to a tenant sandbox.
// Ambient spawn env may contribute only non-secret process behaviour. Credentials
// and generated config must be present in the explicit, run-scoped remoteEnv map.
const AMBIENT_BEHAVIOR_ENV_ALLOWLIST = new Set(['LANG', 'LC_ALL', 'TERM']);
const RUN_SCOPED_REMOTE_ENV_ALLOWLIST = new Set([
  // Trusted per-run tool capability. OD_SYNC_TOKEN is intentionally absent: the
  // workspace service mints and inserts it after this constructor returns.
  'OD_TOOL_TOKEN',
  // OhMyAgent's one fixed provider key plus daemon-generated model/MCP payloads.
  'OPEN_DESIGN_OHMYAGENT_API_KEY',
  'OD_OHMYAGENT_MODEL_CONFIG_B64', 'OD_OHMYAGENT_MODEL_CONFIG_PATH',
  'OD_OHMYAGENT_MCP_CONFIG_B64', 'OD_OHMYAGENT_MCP_CONFIG_PATH',
  // OpenCode inline config and OpenDesign's one fixed BYOK key. Provider-
  // selected or prefix-matched environment names are never accepted.
  'OPENCODE_CONFIG_CONTENT', 'OPEN_DESIGN_BYOK_API_KEY',
]);

export class HuskboxExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: { status?: number; executionId?: string; attempt?: number; retryable?: boolean; remoteStatus?: string; trace_id?: string; data?: unknown } = {},
  ) {
    super(message);
    this.name = 'HuskboxExecutionError';
  }
}

/** Explicit integration seam for sync-token minting and daemon hydration. */
export interface HuskboxWorkspaceService {
  prepare?(context: { spec: ExecutionSpec; env: Record<string, string>; projectId: string | null }): void;
  hydrateAfterExecution?(context: { execution: HuskboxExecutionStatus; projectId: string | null }): void | Promise<void>;
}

export interface HuskboxTransportOptions {
  client?: HuskboxClient;
  fetcher?: typeof fetch;
  workspaceService?: HuskboxWorkspaceService;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  idempotencyKey?: () => string;
}

export const HUSKBOX_BOOTSTRAP_SCRIPT = `set -u
mkdir -p "$HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME" "$OHMYAGENT_CONFIG_DIR" "$TMPDIR" "$OD_DATA_DIR/projects"
# Runtime config files must be materialized inside the sandbox: daemon-local
# temp paths are not mounted into a fresh Huskbox. Values travel in env rather
# than argv/process listings and are removed before the agent starts.
if [ -n "\${OD_OHMYAGENT_MODEL_CONFIG_B64:-}" ]; then
  mkdir -p "\${OD_OHMYAGENT_MODEL_CONFIG_PATH%/*}"
  printf '%s' "$OD_OHMYAGENT_MODEL_CONFIG_B64" | base64 -d > "$OD_OHMYAGENT_MODEL_CONFIG_PATH" || exit 125
  chmod 600 "$OD_OHMYAGENT_MODEL_CONFIG_PATH"
  unset OD_OHMYAGENT_MODEL_CONFIG_B64 OD_OHMYAGENT_MODEL_CONFIG_PATH
fi
if [ -n "\${OD_OHMYAGENT_MCP_CONFIG_B64:-}" ]; then
  mkdir -p "\${OD_OHMYAGENT_MCP_CONFIG_PATH%/*}"
  printf '%s' "$OD_OHMYAGENT_MCP_CONFIG_B64" | base64 -d > "$OD_OHMYAGENT_MCP_CONFIG_PATH" || exit 125
  chmod 600 "$OD_OHMYAGENT_MCP_CONFIG_PATH"
  unset OD_OHMYAGENT_MCP_CONFIG_B64 OD_OHMYAGENT_MCP_CONFIG_PATH
fi
if [ -n "\${OD_INSTALL_URL:-}" ]; then
  mkdir -p "\${OD_BIN%/*}"
  auth=()
  [ -n "\${OD_TOOL_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $OD_TOOL_TOKEN")
  curl -fsSL --retry 3 "\${auth[@]}" "$OD_INSTALL_URL" -o "$OD_BIN" || exit 126
fi
export OD_SYNC_STATE_DIR="$HOME/.od-sync-state"
if [ -n "\${OD_BACKEND_URL:-}" ] && [ -n "\${OD_PROJECT_ID:-}" ]; then
  "$OD_NODE_BIN" "$OD_BIN" sync pull || { echo "[od-bootstrap] sync pull failed" >&2; exit 125; }
fi
mkdir -p "\${OD_AGENT_CWD:-$OD_DATA_DIR}"
cd "\${OD_AGENT_CWD:-$OD_DATA_DIR}" || exit 125
if [ -n "\${OD_STDIN_LEN:-}" ]; then
  head -c "$OD_STDIN_LEN" > "$TMPDIR/prompt.bin"
  "$@" < "$TMPDIR/prompt.bin"
else
  "$@"
fi
code=$?
if [ -n "\${OD_BACKEND_URL:-}" ] && [ -n "\${OD_PROJECT_ID:-}" ]; then
  "$OD_NODE_BIN" "$OD_BIN" sync push || echo "[od-bootstrap] sync push failed" >&2
fi
exit $code`;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

function projectIdFromCwd(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const match = cwd.replace(/\\/gu, '/').match(/\/projects\/([^/]+)(?:\/|$)/u);
  return match?.[1] ?? null;
}

/** Pure, auditable constructor. `spec.env` and `spec.remoteEnv` each have a
 * separate fixed-key allowlist; neither arbitrary keys nor prefixes are used. */
export function createHuskboxSandboxEnv(
  spec: ExecutionSpec,
  config: HuskboxExecutionConfig,
): { env: Record<string, string>; projectId: string | null } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.env ?? {})) {
    if (value !== undefined && AMBIENT_BEHAVIOR_ENV_ALLOWLIST.has(key)) env[key] = value;
  }
  for (const [key, value] of Object.entries(spec.remoteEnv ?? {})) {
    if (value !== undefined && RUN_SCOPED_REMOTE_ENV_ALLOWLIST.has(key)) env[key] = value;
  }
  const projectId = projectIdFromCwd(spec.cwd);
  const mount = config.sandboxMount.replace(/\/$/u, '');
  env.OD_NODE_BIN = '/usr/bin/node';
  env.OD_BIN = `${mount}/.od/bin/od-cli.mjs`;
  env.TMPDIR = `${mount}/.od/tmp`;
  env.OD_DATA_DIR = mount;
  env.HOME = SANDBOX_HOME;
  env.XDG_CONFIG_HOME = `${SANDBOX_HOME}/.config`;
  env.XDG_CACHE_HOME = `${SANDBOX_HOME}/.cache`;
  env.PATH = SANDBOX_PATH;
  env.OHMYAGENT_CONFIG_DIR = `${mount}/.od/ohmyagent`;
  if (projectId) {
    env.OD_PROJECT_ID = projectId;
    env.OD_AGENT_CWD = `${mount}/projects/${projectId}`;
    env.OD_PROJECT_DIR = env.OD_AGENT_CWD;
  } else if (spec.cwd) {
    const daemonMount = config.daemonMount.replace(/\/$/u, '');
    env.OD_AGENT_CWD = spec.cwd === daemonMount || spec.cwd.startsWith(`${daemonMount}/`)
      ? `${mount}${spec.cwd.slice(daemonMount.length)}`
      : mount;
  }
  if (config.daemonPublicUrl) {
    env.OD_DAEMON_URL = config.daemonPublicUrl;
    env.OD_INSTALL_URL = `${config.daemonPublicUrl}/api/od-cli.mjs`;
  }
  if (config.backendPublicUrl) env.OD_BACKEND_URL = config.backendPublicUrl;
  return { env, projectId };
}

function sandboxCommandArgs(spec: ExecutionSpec, env: Record<string, string>): string[] {
  const args = [...(spec.args ?? [])];
  if (spec.command.split(/[\\/]/u).at(-1) !== 'ohmyagent' || !spec.cwd || !env.OD_AGENT_CWD) return args;
  for (let index = 0; index < args.length - 1; index++) {
    if ((args[index] === '--cwd' || args[index] === '-C') && args[index + 1] === spec.cwd) {
      args[index + 1] = env.OD_AGENT_CWD;
    }
  }
  return args;
}

export class HuskboxExecutionTransport implements ExecutionTransport {
  private readonly client: HuskboxClient;
  constructor(readonly config: HuskboxExecutionConfig, private readonly options: HuskboxTransportOptions = {}) {
    this.client = options.client ?? new HuskboxClient(config, options.fetcher);
  }
  execute(spec: ExecutionSpec): HuskboxExecutionHandle {
    return new HuskboxExecutionHandle(this.client, this.config, spec, this.options);
  }
}

export class HuskboxExecutionHandle implements ExecutionHandle {
  readonly pid = null;
  readonly processGroupId = null;
  readonly stdin: Writable | null = null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly started: Promise<void>;
  readonly result: Promise<ExecutionResult>;

  private readonly stdoutSink = new PassThrough();
  private readonly stderrSink = new PassThrough();
  private readonly abort = new AbortController();
  private stdinChunks: Buffer[] = [];
  private launched = false;
  private settled = false;
  private executionId = '';
  private sawStdout = false;
  private resolveStarted!: () => void;
  private rejectStarted!: (error: Error) => void;
  private resolveResult!: (result: ExecutionResult) => void;

  constructor(
    private readonly client: HuskboxClient,
    private readonly config: HuskboxExecutionConfig,
    private readonly spec: ExecutionSpec,
    private readonly options: HuskboxTransportOptions,
  ) {
    this.stdout = this.stdoutSink;
    this.stderr = this.stderrSink;
    this.started = new Promise<void>((resolve, reject) => { this.resolveStarted = resolve; this.rejectStarted = reject; });
    void this.started.catch(() => undefined);
    this.result = new Promise<ExecutionResult>((resolve) => { this.resolveResult = resolve; });
    if ((spec.stdin ?? 'ignore') === 'ignore') queueMicrotask(() => this.launch());
  }

  writeStdin(chunk: string | Uint8Array, encoding: BufferEncoding = 'utf8'): boolean {
    if (this.launched) throw new HuskboxExecutionError('STDIN_ALREADY_SENT', 'Huskbox stdin must be buffered before execution starts');
    this.stdinChunks.push(typeof chunk === 'string' ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    return true;
  }

  endStdin(chunk?: string | Uint8Array, encoding: BufferEncoding = 'utf8'): void {
    if (chunk !== undefined) this.writeStdin(chunk, encoding);
    this.launch();
  }

  async cancel(_options: ExecutionCancelOptions = {}): Promise<ExecutionResult> {
    if (!this.settled) {
      this.abort.abort(new HuskboxExecutionError('CANCELED', 'Huskbox execution canceled'));
      if (!this.launched) this.finish({ exitCode: null, signal: 'SIGTERM' });
    }
    return this.result;
  }

  dispose(): void {
    if (!this.settled) this.abort.abort(new HuskboxExecutionError('DISPOSED', 'Huskbox execution disposed'));
    this.stdoutSink.destroy();
    this.stderrSink.destroy();
  }

  private launch(): void {
    if (this.launched) return;
    this.launched = true;
    void this.run();
  }

  private async run(): Promise<void> {
    const { env, projectId } = createHuskboxSandboxEnv(this.spec, this.config);
    const stdin = Buffer.concat(this.stdinChunks).toString('utf8');
    this.stdinChunks = [];
    if ((this.spec.stdin ?? 'ignore') === 'pipe') {
      env.OD_STDIN_LEN = String(Buffer.byteLength(stdin));
    } else {
      delete env.OD_STDIN_LEN;
    }
    try {
      this.options.workspaceService?.prepare?.({ spec: this.spec, env, projectId });
      let lastError: Error = new HuskboxExecutionError('STREAM_DROPPED', 'Huskbox stream dropped before completion');
      const idempotencyKey = this.options.idempotencyKey?.() ?? `od-run-${randomUUID()}`;
      for (let attempt = 1; attempt <= this.config.retryMaxAttempts; attempt++) {
        if (this.abort.signal.aborted) return this.finish({ exitCode: null, signal: 'SIGTERM' });
        const request: HuskboxExecuteRequest = {
          idempotency_key: idempotencyKey,
          ...(this.config.image ? { image: this.config.image } : {}),
          cmd: ['bash', '-c', HUSKBOX_BOOTSTRAP_SCRIPT, 'bash', this.spec.command, ...sandboxCommandArgs(this.spec, env)],
          env,
          ...(stdin ? { stdin } : {}),
        };
        const outcome = await this.attempt(request, attempt, projectId);
        if (outcome) return this.finish(outcome);
        lastError = this.lastAttemptError ?? lastError;
        if (attempt < this.config.retryMaxAttempts) {
          // The key remains stable for this transport execution group. If the
          // first response was lost before an id arrived, Huskbox can replay the
          // same attempt rather than creating a second execution. Once an id is
          // acknowledged we never POST again (at-most-once from that boundary).
          // Before acknowledgement delivery is at-least-once, but the stable key
          // makes execution at-most-once under Huskbox's idempotency contract.
          const delay = Math.min(60_000, this.config.retryBaseMs * (2 ** (attempt - 1)));
          this.stderrSink.write(`${RETRY_MARKER} ${lastError.message}; retry ${attempt + 1}/${this.config.retryMaxAttempts}\n`);
          await (this.options.sleep ?? sleep)(delay, this.abort.signal);
        }
      }
      this.fail(lastError);
    } catch (error) {
      if (this.abort.signal.aborted) this.finish({ exitCode: null, signal: 'SIGTERM' });
      else this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private lastAttemptError: Error | null = null;

  /** null means retry; an ExecutionResult means terminal. */
  private async attempt(request: HuskboxExecuteRequest, attempt: number, projectId: string | null): Promise<ExecutionResult | null> {
    let completed: HuskboxExecutionStatus | null = null;
    let eventError: HuskboxExecutionError | null = null;
    this.executionId = '';
    try {
      await this.client.stream(request, this.abort.signal, (event) => {
        let body: any;
        try { body = JSON.parse(event.data); } catch {
          eventError = new HuskboxExecutionError('INVALID_SSE_EVENT', `Invalid Huskbox ${event.event} event JSON`, { attempt });
          return;
        }
        if (event.event === 'started') {
          this.executionId = typeof body.id === 'string' ? body.id : '';
          this.resolveStarted();
        } else if (event.event === 'stdout') {
          if (typeof body.data === 'string' && body.data) {
            this.sawStdout = true;
            this.stdoutSink.write(body.data);
          }
        } else if (event.event === 'stderr') {
          if (typeof body.data === 'string' && body.data) this.stderrSink.write(body.data);
        } else if (event.event === 'completed') {
          completed = body as HuskboxExecutionStatus;
          this.executionId ||= completed.id || '';
        } else if (event.event === 'error') {
          const api = body.error as HuskboxApiError | undefined;
          eventError = new HuskboxExecutionError(api?.code || 'EXECUTION_ERROR', api?.message || 'Huskbox execution failed', {
            executionId: body.id || this.executionId, attempt, retryable: false,
            ...(typeof body.trace_id === 'string' ? { trace_id: body.trace_id } : {}),
          });
        }
      });
    } catch (error) {
      if (this.abort.signal.aborted) return { exitCode: null, signal: 'SIGTERM' };
      if (this.executionId) {
        return await this.resultAfterAcknowledgedDrop(
          await this.pollAcknowledgedStatus(this.executionId), attempt, projectId,
        );
      }
      if (error instanceof HuskboxHttpError && error.code === 'EXECUTION_IN_PROGRESS') {
        const id = this.executionIdFromErrorData(error.data);
        if (id) {
          this.executionId = id;
          return await this.resultAfterAcknowledgedDrop(
            await this.pollAcknowledgedStatus(id), attempt, projectId,
          );
        }
      }
      const retryable = !(error instanceof HuskboxHttpError)
        || error.status === 429
        || error.status >= 500
        || (error.status === 409 && error.code === 'EXECUTION_IN_PROGRESS');
      const structured = error instanceof HuskboxHttpError
        ? new HuskboxExecutionError(error.code, error.message, {
            status: error.status, attempt, retryable,
            ...(error.trace_id ? { trace_id: error.trace_id } : {}),
            ...(error.data !== undefined ? { data: error.data } : {}),
          })
        : new HuskboxExecutionError('NETWORK_ERROR', error instanceof Error ? error.message : String(error), { attempt, retryable: true });
      this.lastAttemptError = structured;
      if (!retryable || this.sawStdout) return { exitCode: DEFAULT_FAILURE_EXIT, signal: null, error: structured };
      return null;
    }
    if (eventError) return { exitCode: DEFAULT_FAILURE_EXIT, signal: null, error: eventError };
    if (completed) {
      await this.options.workspaceService?.hydrateAfterExecution?.({ execution: completed, projectId });
      return this.mapCompleted(completed, attempt);
    }
    const probe = this.executionId ? await this.pollAcknowledgedStatus(this.executionId) : null;
    if (this.executionId) return await this.resultAfterAcknowledgedDrop(probe, attempt, projectId);
    const suffix = probe ? ` (execution ${probe.timed_out ? 'timed out' : probe.status})` : '';
    const dropped = new HuskboxExecutionError('STREAM_DROPPED', `Huskbox stream dropped before completion${suffix}`, {
      ...(this.executionId ? { executionId: this.executionId } : {}), attempt, retryable: !this.sawStdout,
    });
    this.lastAttemptError = dropped;
    return this.sawStdout ? { exitCode: 1, signal: null, error: dropped } : null;
  }

  private async resultAfterAcknowledgedDrop(
    probe: HuskboxExecutionStatus | null,
    attempt: number,
    projectId: string | null,
  ): Promise<ExecutionResult> {
    if (probe && this.isTerminal(probe)) {
      await this.options.workspaceService?.hydrateAfterExecution?.({ execution: probe, projectId });
      return this.mapCompleted(probe, attempt);
    }
    const status = probe?.status ?? 'unknown';
    const inProgress = status === 'pending' || status === 'running';
    const error = new HuskboxExecutionError(
      inProgress ? 'EXECUTION_STATUS_TIMEOUT' : 'EXECUTION_STATUS_UNKNOWN',
      inProgress
        ? `Timed out waiting for acknowledged Huskbox execution ${this.executionId}; remote status is still ${status}. It was not re-POSTed.`
        : `Huskbox stream dropped; acknowledged execution ${this.executionId} status is ${status}. It was not re-POSTed.`,
      { executionId: this.executionId, attempt, retryable: false, remoteStatus: status },
    );
    this.lastAttemptError = error;
    return { exitCode: DEFAULT_FAILURE_EXIT, signal: null, error };
  }

  private isTerminal(execution: HuskboxExecutionStatus): boolean {
    return execution.timed_out === true
      || ['succeeded', 'failed', 'timed_out', 'rejected', 'canceled'].includes(execution.status);
  }

  private mapCompleted(execution: HuskboxExecutionStatus, attempt: number): ExecutionResult {
    if (execution.timed_out || execution.status === 'timed_out') {
      return { exitCode: 124, signal: null, error: new HuskboxExecutionError('EXECUTION_TIMEOUT', 'Huskbox execution timed out', { executionId: execution.id, attempt }) };
    }
    if ((execution.status === 'failed' || execution.status === 'rejected' || execution.status === 'canceled')
      && typeof execution.exit_code !== 'number' && !execution.error) {
      const code = execution.status === 'rejected' ? 'EXECUTION_REJECTED' : 'EXECUTION_FAILED';
      return { exitCode: DEFAULT_FAILURE_EXIT, signal: null, error: new HuskboxExecutionError(code, `Huskbox execution ${execution.status}`, { executionId: execution.id, attempt }) };
    }
    if (typeof execution.exit_code !== 'number') {
      return { exitCode: DEFAULT_FAILURE_EXIT, signal: null, error: new HuskboxExecutionError('MISSING_EXIT_CODE', `Huskbox ${execution.status || 'completed'} execution has no exit_code`, { executionId: execution.id, attempt }) };
    }
    const error = execution.error
      ? new HuskboxExecutionError(execution.error.code, execution.error.message, { executionId: execution.id, attempt })
      : undefined;
    return { exitCode: execution.exit_code, signal: null, ...(error ? { error } : {}) };
  }

  private executionIdFromErrorData(data: unknown): string {
    if (!data || typeof data !== 'object') return '';
    const id = (data as Record<string, unknown>).id;
    return typeof id === 'string' ? id : '';
  }

  private async pollAcknowledgedStatus(id: string): Promise<HuskboxExecutionStatus | null> {
    let latest: HuskboxExecutionStatus | null = null;
    // Reuse the configured bounded attempt count, but only for GET status calls.
    // An acknowledged execution is never sent through the outer POST retry loop.
    for (let poll = 1; poll <= this.config.retryMaxAttempts; poll++) {
      latest = await this.probe(id);
      if (!latest || this.isTerminal(latest)) return latest;
      if (latest.status !== 'pending' && latest.status !== 'running') return latest;
      if (poll < this.config.retryMaxAttempts) {
        await (this.options.sleep ?? sleep)(this.config.retryBaseMs, this.abort.signal);
      }
    }
    return latest;
  }

  private async probe(id: string): Promise<HuskboxExecutionStatus | null> {
    const controller = new AbortController();
    const abortParent = () => controller.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', abortParent, { once: true });
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try { return await this.client.status(id, controller.signal); }
    catch { return null; }
    finally {
      clearTimeout(timer);
      this.abort.signal.removeEventListener('abort', abortParent);
    }
  }

  private fail(error: Error): void {
    this.rejectStarted(error);
    this.stderrSink.write(`od-agent huskbox: ${error.message}\n`);
    this.finish({ exitCode: DEFAULT_FAILURE_EXIT, signal: null, error });
  }

  private finish(result: ExecutionResult): void {
    if (this.settled) return;
    this.settled = true;
    if (result.error) this.rejectStarted(result.error);
    else this.resolveStarted();
    this.stdoutSink.end();
    this.stderrSink.end();
    this.resolveResult(result);
  }
}
