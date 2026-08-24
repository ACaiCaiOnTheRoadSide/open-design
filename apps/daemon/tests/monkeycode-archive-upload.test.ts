import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createCappedArchiveMultipartBody,
  isArchiveTooLargeError,
  monitorArchiveUploadDisconnect,
} from '../src/import-export-routes.js';

describe('MonkeyCode archive multipart upload', () => {
  it('aborts outbound fetch and stops archive reads when the client disconnects', async () => {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    let destroyed = false;
    const archive = new Readable({
      read() { this.push(Buffer.alloc(16)); },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    });
    // Consume enough to prove the source was active before disconnect.
    archive.read();
    const outbound = new AbortController();
    let fetchSignalAborted = false;
    outbound.signal.addEventListener('abort', () => { fetchSignalAborted = true; });
    const cleanup = monitorArchiveUploadDisconnect(req, res, outbound, () => [archive]);

    req.emit('aborted');

    expect(outbound.signal.aborted).toBe(true);
    expect(fetchSignalAborted).toBe(true);
    expect(destroyed).toBe(true);
    expect(archive.destroyed).toBe(true);
    cleanup();
    expect(req.listenerCount('aborted')).toBe(0);
    expect(res.listenerCount('finish')).toBe(0);
    expect(res.listenerCount('close')).toBe(0);
  });

  it('treats response close before finish as a client disconnect', () => {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    const archive = new Readable({ read() {} });
    const outbound = new AbortController();
    const cleanup = monitorArchiveUploadDisconnect(req, res, outbound, () => [archive]);

    res.emit('close');

    expect(outbound.signal.aborted).toBe(true);
    expect(archive.destroyed).toBe(true);
    cleanup();
  });

  it('does not abort a normally finished response when close follows finish', () => {
    const req = new EventEmitter();
    const res = Object.assign(new EventEmitter(), { writableFinished: false });
    const archive = new Readable({ read() {} });
    const outbound = new AbortController();
    const cleanup = monitorArchiveUploadDisconnect(req, res, outbound, () => [archive]);

    res.emit('finish');
    res.writableFinished = true;
    res.emit('close');

    expect(outbound.signal.aborted).toBe(false);
    expect(archive.destroyed).toBe(false);
    cleanup();
    archive.destroy();
  });

  it('aborts during accumulation when compressed bytes exceed the limit', async () => {
    const archive = Readable.from([Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(6)]);
    const body = createCappedArchiveMultipartBody(archive, 'project-1', 'boundary', 10);
    let emittedBytes = 0;
    await expect((async () => {
      for await (const chunk of body) emittedBytes += Buffer.byteLength(chunk);
    })()).rejects.toMatchObject({ code: 'ARCHIVE_TOO_LARGE' });
    expect(archive.destroyed).toBe(true);
    expect(emittedBytes).toBeLessThan(300);
  });

  it('recognizes the size error when fetch wraps the request stream failure', () => {
    const limit = Object.assign(new Error('too large'), { code: 'ARCHIVE_TOO_LARGE' });
    expect(isArchiveTooLargeError(new TypeError('fetch failed', { cause: limit }))).toBe(true);
    expect(isArchiveTooLargeError(new TypeError('fetch failed'))).toBe(false);
  });
});
