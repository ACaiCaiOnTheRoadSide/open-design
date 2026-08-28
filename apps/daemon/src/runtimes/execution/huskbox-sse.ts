export interface HuskboxSseEvent { event: string; data: string }

/** Incremental SSE parser supporting split UTF-8 code points, CRLF, comments and multi-line data. */
export class HuskboxSseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private readonly decoder = new TextDecoder();

  constructor(private readonly dispatch: (event: HuskboxSseEvent) => void) {}

  feed(chunk: Uint8Array | string): void {
    this.buffer += typeof chunk === 'string'
      ? chunk
      : this.decoder.decode(chunk, { stream: true });
    this.consumeLines();
  }

  end(): void {
    this.buffer += this.decoder.decode();
    this.consumeLines();
    if (this.buffer) this.line(this.buffer.replace(/\r$/u, ''));
    this.buffer = '';
    this.flush();
  }

  private consumeLines(): void {
    for (;;) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/u, '');
      this.buffer = this.buffer.slice(index + 1);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (!line) { this.flush(); return; }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }

  private flush(): void {
    if (!this.event && this.data.length === 0) return;
    this.dispatch({ event: this.event || 'message', data: this.data.join('\n') });
    this.event = '';
    this.data = [];
  }
}
