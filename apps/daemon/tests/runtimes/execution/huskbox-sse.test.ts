import { describe, expect, it, vi } from 'vitest';

import { HuskboxSseParser } from '../../../src/runtimes/execution/huskbox-sse.js';

describe('HuskboxSseParser', () => {
  it('preserves UTF-8 split across chunks and parses CRLF/multiline data', () => {
    const events: Array<{ event: string; data: string }> = [];
    const parser = new HuskboxSseParser((event) => events.push(event));
    const bytes = new TextEncoder().encode('event: stdout\r\ndata: 你\r\ndata: 好\r\n\r\n');
    const split = bytes.indexOf(0xe4) + 1;
    parser.feed(bytes.slice(0, split));
    parser.feed(bytes.slice(split));
    parser.end();
    expect(events).toEqual([{ event: 'stdout', data: '你\n好' }]);
  });

  it('ignores comments and dispatches an unterminated final event', () => {
    const listener = vi.fn();
    const parser = new HuskboxSseParser(listener);
    parser.feed(': heartbeat\nevent: stderr\ndata: warning');
    parser.end();
    expect(listener).toHaveBeenCalledWith({ event: 'stderr', data: 'warning' });
  });
});
