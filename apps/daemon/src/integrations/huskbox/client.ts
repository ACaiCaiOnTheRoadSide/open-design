export type HuskboxInfrastructureFailureKind =
  | 'openapi'
  | 'timeout'
  | 'stream'
  | 'protocol'
  | 'worker';

/** A typed failure of the remote execution infrastructure, never worker business validation. */
export class HuskboxInfrastructureError extends Error {
  readonly name = 'HuskboxInfrastructureError';
  constructor(
    readonly kind: HuskboxInfrastructureFailureKind,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export const HUSKBOX_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface HuskboxConfig {
  apiKey: string;
  baseUrl: string;
  daemonPublicUrl: string;
  resourceTier: string;
  tenantId: string;
  timeoutSeconds: number;
}

export const FIXED_HUSKBOX_WORKER_COMMAND = [
  '/bin/sh',
  '-c',
  'set -eu; curl -fsS -H "Authorization: Bearer $OD_DAEMON_TOKEN" "$OD_DAEMON_URL/api/desktop-render-worker.mjs" -o /tmp/od-render-worker.mjs; curl -fsS -H "Authorization: Bearer $OD_DAEMON_TOKEN" "$OD_DAEMON_URL/api/chromium-bundle.tar.gz" -o /tmp/chromium.tar.gz; mkdir -p /tmp/chromium /tmp/fc-cache; tar -xzf /tmp/chromium.tar.gz -C /tmp/chromium; printf "%s\\n" "<?xml version=\"1.0\"?>" "<!DOCTYPE fontconfig SYSTEM \"fonts.dtd\">" "<fontconfig><dir>/tmp/chromium/usr/share/fonts</dir><cachedir>/tmp/fc-cache</cachedir></fontconfig>" > /tmp/fonts.conf; export LD_LIBRARY_PATH="/tmp/chromium/usr/lib:/tmp/chromium/lib:/tmp/chromium/usr/lib/pulseaudio${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" FONTCONFIG_FILE=/tmp/fonts.conf; exec node /tmp/od-render-worker.mjs',
] as const;

function httpUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return value.trim().replace(/\/+$/, '');
  } catch { return null; }
}

export function readHuskboxConfig(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): HuskboxConfig | null {
  const baseUrl = httpUrl(env.OD_HUSKBOX_BASE_URL);
  const daemonPublicUrl = httpUrl(env.OD_HUSKBOX_DAEMON_PUBLIC_URL);
  const apiKey = env.OD_HUSKBOX_API_KEY?.trim();
  const tenantId = env.OD_HUSKBOX_TENANT_ID?.trim();
  if (!baseUrl || !daemonPublicUrl || !apiKey || !tenantId) return null;
  const timeout = Number(env.OD_HUSKBOX_TIMEOUT_SECONDS);
  return {
    baseUrl, daemonPublicUrl, apiKey, tenantId,
    resourceTier: env.OD_HUSKBOX_RESOURCE_TIER?.trim() || 'standard',
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? Math.floor(timeout) : 300,
  };
}

export class HuskboxSseParser {
  private buffer = '';
  private stdout = '';
  private remoteError = '';
  private direct: unknown;
  private bytes = 0;
  constructor(private readonly maxBytes = HUSKBOX_MAX_OUTPUT_BYTES) {}

  push(text: string): void {
    this.bytes += Buffer.byteLength(text);
    if (this.bytes > this.maxBytes) throw new Error(`Huskbox output exceeds ${this.maxBytes} bytes`);
    this.buffer += text;
    const blocks = this.buffer.split(/\r?\n\r?\n/);
    this.buffer = blocks.pop() || '';
    for (const block of blocks) this.consume(block);
  }

  private consume(block: string): void {
    let event = '';
    const lines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
    }
    if (!lines.length) return;
    const raw = lines.join('\n');
    let value: unknown = raw;
    try { value = JSON.parse(raw); } catch { /* stdout may be plain text */ }
    if (value && typeof value === 'object' && 'result' in value) this.direct = (value as Record<string, unknown>).result;
    const addition = stdoutStrings(value).join('');
    if (Buffer.byteLength(this.stdout) + Buffer.byteLength(addition) > this.maxBytes) throw new Error(`Huskbox stdout exceeds ${this.maxBytes} bytes`);
    this.stdout += addition;
    if (/error|failed/i.test(event)) this.remoteError = typeof value === 'string' ? value : JSON.stringify(value);
  }

  finish(): string {
    if (this.buffer) this.consume(this.buffer);
    if (this.direct !== undefined) return JSON.stringify(this.direct);
    if (!this.stdout) throw new Error(this.remoteError || 'Huskbox execution returned no worker output');
    return this.stdout;
  }
}

function stdoutStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  const object = value as Record<string, unknown>;
  const direct = ['stdout', 'stdout_delta', 'output'].flatMap((key) => typeof object[key] === 'string' ? [object[key] as string] : []);
  return direct.concat(stdoutStrings(object.data));
}

export async function executeHuskboxWorker<T>(config: HuskboxConfig, options: {
  daemonToken: string;
  input: unknown;
  fetch?: typeof fetch | undefined;
  maxOutputBytes?: number | undefined;
}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), (config.timeoutSeconds + 15) * 1000);
  try {
    const stdin = JSON.stringify(options.input);
    const response = await (options.fetch ?? fetch)(`${config.baseUrl}/openapi/v1/executions/stream`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        cmd: FIXED_HUSKBOX_WORKER_COMMAND,
        env: {
          OD_DAEMON_TOKEN: options.daemonToken,
          OD_DAEMON_URL: config.daemonPublicUrl,
          OD_STDIN_LEN: String(Buffer.byteLength(stdin, 'utf8')),
        },
        resource_tier: config.resourceTier,
        stdin,
        tenant_id: config.tenantId,
        timeout_seconds: config.timeoutSeconds,
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new HuskboxInfrastructureError('openapi', `Huskbox HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
    if (!response.body) throw new HuskboxInfrastructureError('stream', 'Huskbox execution returned no response body');
    const parser = new HuskboxSseParser(options.maxOutputBytes);
    const decoder = new TextDecoder();
    try {
      for await (const chunk of response.body) parser.push(decoder.decode(chunk, { stream: true }));
      parser.push(decoder.decode());
      const output = parser.finish();
      for (const line of output.trim().split(/\r?\n/).reverse()) {
        try { return JSON.parse(line) as T; } catch { /* seek final JSON line */ }
      }
      throw new HuskboxInfrastructureError('protocol', 'Huskbox worker returned no JSON result');
    } catch (error) {
      if (error instanceof HuskboxInfrastructureError) throw error;
      throw new HuskboxInfrastructureError('stream', error instanceof Error ? error.message : String(error), { cause: error });
    }
  } catch (error) {
    if (error instanceof HuskboxInfrastructureError) throw error;
    if (controller.signal.aborted) {
      throw new HuskboxInfrastructureError('timeout', 'Huskbox execution timed out', { cause: error });
    }
    throw new HuskboxInfrastructureError('openapi', error instanceof Error ? error.message : String(error), { cause: error });
  } finally { clearTimeout(timer); }
}
