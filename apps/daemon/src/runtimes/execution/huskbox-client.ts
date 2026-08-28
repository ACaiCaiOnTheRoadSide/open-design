import { HuskboxSseParser, type HuskboxSseEvent } from './huskbox-sse.js';

export interface HuskboxExecuteRequest {
  idempotencyKey: string;
  cmd: string[];
  env?: Record<string, string>;
  stdin?: string;
  inputWorkspaceURL?: string;
  timeoutSeconds?: number;
  resourceTier?: string;
  network?: string;
  terminal?: boolean;
  debug?: { retainSandboxSeconds?: number; retainOn?: string };
}
export interface HuskboxApiError { code: string; message: string }
export interface HuskboxExecutionStatus {
  id: string;
  status: string;
  exitCode?: number;
  timedOut?: boolean;
  outputWorkspaceURL?: string;
  error?: HuskboxApiError;
}

export class HuskboxHttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HuskboxHttpError';
  }
}

export class HuskboxClient {
  constructor(
    private readonly config: { baseUrl: string; tenantId: string; apiKey?: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(accept?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'X-Huskbox-Tenant-ID': this.config.tenantId,
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(accept ? { Accept: accept } : {}),
    };
  }

  async stream(request: HuskboxExecuteRequest, signal: AbortSignal, onEvent: (event: HuskboxSseEvent) => void): Promise<void> {
    const response = await this.fetcher(`${this.config.baseUrl}/v1/executions/stream`, {
      method: 'POST', headers: this.headers('text/event-stream'), body: JSON.stringify(request), signal,
    });
    if (!response.ok) throw await this.httpError(response);
    if (!response.body) throw new HuskboxHttpError(response.status, 'EMPTY_STREAM', 'Huskbox stream response has no body');
    const parser = new HuskboxSseParser(onEvent);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parser.feed(next.value);
      }
      parser.end();
    } finally {
      reader.releaseLock();
    }
  }

  async status(id: string, signal: AbortSignal): Promise<HuskboxExecutionStatus> {
    const response = await this.fetcher(`${this.config.baseUrl}/v1/executions/${encodeURIComponent(id)}`, {
      headers: this.headers(), signal,
    });
    if (!response.ok) throw await this.httpError(response);
    return await response.json() as HuskboxExecutionStatus;
  }

  private async httpError(response: Response): Promise<HuskboxHttpError> {
    const text = (await response.text()).slice(0, 2_000);
    try {
      const body = JSON.parse(text) as { error?: Partial<HuskboxApiError> };
      return new HuskboxHttpError(response.status, body.error?.code || `HTTP_${response.status}`, body.error?.message || text || `Huskbox HTTP ${response.status}`);
    } catch {
      return new HuskboxHttpError(response.status, `HTTP_${response.status}`, text || `Huskbox HTTP ${response.status}`);
    }
  }
}
