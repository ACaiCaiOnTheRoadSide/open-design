import { HuskboxSseParser, type HuskboxSseEvent } from './huskbox-sse.js';

export interface HuskboxExecuteRequest {
  idempotency_key: string;
  image?: string;
  cmd: string[];
  env?: Record<string, string>;
  stdin?: string;
  input_workspace_url?: string;
  timeout_seconds?: number;
  resource_tier?: string;
  network?: string;
  terminal?: boolean;
}

export interface HuskboxApiError { code: string; message: string }
export interface HuskboxExecutionStatus {
  id: string;
  tenant_id?: string;
  idempotency_key?: string;
  status: string;
  resource_tier?: string;
  image_ref?: string;
  image_digest?: string;
  image_pull_duration_ms?: number;
  worker_id?: string;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  output_truncated?: boolean;
  timed_out?: boolean;
  output_workspace_url?: string;
  duration_ms?: number;
  error?: HuskboxApiError;
  started_at?: string;
  finished_at?: string;
  created_at?: string;
  updated_at?: string;
  request?: unknown;
}

export interface HuskboxErrorPayload {
  code: string;
  message: string;
  trace_id?: string;
  data?: unknown;
}

export class HuskboxHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly trace_id?: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'HuskboxHttpError';
  }
}

export class HuskboxClient {
  constructor(
    private readonly config: { baseUrl: string; apiKey?: string },
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private headers(accept?: string): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}),
      ...(accept ? { Accept: accept } : {}),
    };
  }

  async stream(request: HuskboxExecuteRequest, signal: AbortSignal, onEvent: (event: HuskboxSseEvent) => void): Promise<void> {
    const response = await this.fetcher(`${this.config.baseUrl}/openapi/v1/executions/stream`, {
      method: 'POST', headers: this.headers('text/event-stream'), body: JSON.stringify(request), signal,
    });
    if (!response.ok) throw await this.httpError(response);
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    if (contentType !== 'text/event-stream') {
      throw new HuskboxHttpError(response.status, 'UNEXPECTED_CONTENT_TYPE', `Unexpected Huskbox stream Content-Type ${JSON.stringify(response.headers.get('content-type'))}`);
    }
    if (!response.body) throw new HuskboxHttpError(response.status, 'EMPTY_STREAM', 'Huskbox stream response has no body');
    const parser = new HuskboxSseParser(onEvent);
    const reader = response.body.getReader();
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        parser.feed(next.value);
      }
      // Do not stop when a completed event arrives. The SaaS stream can emit a
      // post-processing error after completed, so the complete body is consumed.
      parser.end();
    } finally {
      reader.releaseLock();
    }
  }

  async status(id: string, signal: AbortSignal): Promise<HuskboxExecutionStatus> {
    const response = await this.fetcher(`${this.config.baseUrl}/openapi/v1/executions/${encodeURIComponent(id)}`, {
      headers: this.headers('application/json'), signal,
    });
    if (!response.ok) throw await this.httpError(response);
    const envelope = await response.json() as { code?: number; message?: string; data?: HuskboxExecutionStatus };
    if (envelope.code !== 0 || !envelope.data) {
      throw new HuskboxHttpError(response.status, String(envelope.code ?? 'INVALID_ENVELOPE'), envelope.message || 'Huskbox response envelope is missing data', undefined, envelope.data);
    }
    return envelope.data;
  }

  private async httpError(response: Response): Promise<HuskboxHttpError> {
    const text = (await response.text()).slice(0, 1_048_576);
    try {
      const body = JSON.parse(text) as Partial<HuskboxErrorPayload>;
      return new HuskboxHttpError(
        response.status,
        typeof body.code === 'string' && body.code ? body.code : `HTTP_${response.status}`,
        typeof body.message === 'string' && body.message ? body.message : text || `Huskbox HTTP ${response.status}`,
        typeof body.trace_id === 'string' ? body.trace_id : undefined,
        body.data,
      );
    } catch {
      return new HuskboxHttpError(response.status, `HTTP_${response.status}`, text || `Huskbox HTTP ${response.status}`);
    }
  }
}
