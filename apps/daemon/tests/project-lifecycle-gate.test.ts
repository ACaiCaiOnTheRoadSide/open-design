import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  __resetProjectLifecycleGateForTests,
  assertProjectActive,
  beginProjectDeletion,
  markProjectActive,
  ProjectDeletedError,
  ProjectDeletingError,
  runProjectActiveOperation,
  runProjectMemoryWrite,
} from '../src/project-lifecycle-gate.js';
import { getProject, insertProject, openDatabase } from '../src/db.js';

describe('project lifecycle gate', () => {
  const tempDirs: string[] = [];

  beforeEach(() => __resetProjectLifecycleGateForTests());
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('marks every project synchronously and waits for registered writes', async () => {
    let release!: () => void;
    const work = runProjectMemoryWrite('b', () => new Promise<void>((resolve) => { release = resolve; }));

    const deletionPromise = beginProjectDeletion(['b', 'a']);
    expect(() => assertProjectActive('a')).toThrow(ProjectDeletingError);
    expect(() => assertProjectActive('b')).toThrow(ProjectDeletingError);
    await expect(runProjectMemoryWrite('b', async () => undefined)).rejects.toBeInstanceOf(ProjectDeletingError);

    let drained = false;
    void deletionPromise.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await work;
    const deletion = await deletionPromise;
    expect(deletion.projectIds).toEqual(['a', 'b']);
    deletion.commit();
    expect(() => assertProjectActive('a')).toThrow(ProjectDeletedError);
  });

  it('waits for a registered non-Memory project operation before deletion', async () => {
    let release!: () => void;
    const operation = runProjectActiveOperation(
      'sync-project',
      () => new Promise<void>((resolve) => { release = resolve; }),
    );

    const deletionPromise = beginProjectDeletion(['sync-project']);
    await expect(runProjectActiveOperation('sync-project', async () => undefined))
      .rejects.toBeInstanceOf(ProjectDeletingError);
    let drained = false;
    void deletionPromise.then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);

    release();
    await operation;
    const deletion = await deletionPromise;
    deletion.rollback();
  });

  it('rolls back all ids after cleanup failure', async () => {
    const deletion = await beginProjectDeletion(['p2', 'p1']);
    deletion.rollback();

    expect(() => assertProjectActive('p1')).not.toThrow();
    await expect(runProjectMemoryWrite('p2', async () => 42)).resolves.toBe(42);
  });

  it('rejects overlapping deletion without partially marking its other ids', async () => {
    const first = await beginProjectDeletion(['shared']);
    await expect(beginProjectDeletion(['other', 'shared'])).rejects.toBeInstanceOf(ProjectDeletingError);
    expect(() => assertProjectActive('other')).not.toThrow();
    first.rollback();
  });

  it('allows same-id recreation after a committed tombstone', async () => {
    const deletion = await beginProjectDeletion(['reused']);
    deletion.commit();
    expect(() => assertProjectActive('reused')).toThrow(ProjectDeletedError);

    markProjectActive('reused');
    expect(() => assertProjectActive('reused')).not.toThrow();
    await expect(runProjectMemoryWrite('reused', async () => 'written')).resolves.toBe('written');
  });

  it('only clears a tombstone after an inserted SQLite row survives outer transaction commit', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-project-lifecycle-'));
    tempDirs.push(dir);
    const db = openDatabase(dir, { dataDir: dir });
    const deletion = await beginProjectDeletion(['rebuild']);
    deletion.commit();

    expect(() => db.transaction(() => {
      insertProject(db, { id: 'rebuild', name: 'rolled back', createdAt: 1, updatedAt: 1 });
      throw new Error('rollback');
    })()).toThrow('rollback');
    await Promise.resolve();
    expect(getProject(db, 'rebuild')).toBeNull();
    expect(() => assertProjectActive('rebuild')).toThrow(ProjectDeletedError);
    await expect(runProjectMemoryWrite('rebuild', async () => 'stale'))
      .rejects.toBeInstanceOf(ProjectDeletedError);

    db.transaction(() => {
      insertProject(db, { id: 'rebuild', name: 'committed', createdAt: 2, updatedAt: 2 });
    })();
    expect(() => assertProjectActive('rebuild')).toThrow(ProjectDeletedError);
    await Promise.resolve();
    expect(getProject(db, 'rebuild')?.name).toBe('committed');
    expect(() => assertProjectActive('rebuild')).not.toThrow();
    db.close();
  });

  it('releases a write lease when work rejects', async () => {
    await expect(runProjectMemoryWrite('p', async () => {
      throw new Error('PG failed');
    })).rejects.toThrow('PG failed');
    const deletion = await beginProjectDeletion(['p']);
    deletion.rollback();
  });
});
