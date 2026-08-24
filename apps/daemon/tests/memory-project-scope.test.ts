import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  composeMemoryBody,
  TrustedMemoryScope,
  upsertMemoryEntry,
} from '../src/memory.js';

const directories: string[] = [];
const originalDb = process.env.OD_DAEMON_DB;

afterEach(async () => {
  if (originalDb === undefined) delete process.env.OD_DAEMON_DB;
  else process.env.OD_DAEMON_DB = originalDb;
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SQLite/filesystem memory project-scope compatibility', () => {
  it('ignores trusted scope and preserves byte-for-byte composition and stored output', async () => {
    process.env.OD_DAEMON_DB = 'sqlite';
    const dataDir = await mkdtemp(path.join(tmpdir(), 'od-memory-scope-'));
    directories.push(dataDir);
    const created = await upsertMemoryEntry(dataDir, {
      name: 'Stable preference',
      description: 'Keep it simple',
      type: 'feedback',
      body: 'Use restrained decoration.',
      projectId: 'must-not-be-persisted',
    }, undefined);
    expect(created).not.toHaveProperty('projectId');
    const baseline = await composeMemoryBody(dataDir);
    const scoped = await composeMemoryBody(
      dataDir,
      TrustedMemoryScope.fromLoadedProject({ id: 'p1' }),
    );
    expect(scoped).toBe(baseline);
  });
});
