import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDatabase,
  deleteProject,
  insertConversation,
  insertProject,
  openDatabase,
} from '../src/db.js';

const dirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('project deletion residual equivalence', () => {
  it('cascades conversation/message rows including persisted artifact and run events', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'od-project-delete-residual-'));
    dirs.push(dir);
    const db = openDatabase(dir, { dataDir: dir });
    insertProject(db, { id: 'p1', name: 'Project', createdAt: 1, updatedAt: 1 });
    insertConversation(db, {
      id: 'c1', projectId: 'p1', title: 'Conversation', createdAt: 1, updatedAt: 1,
    });
    db.prepare(`INSERT INTO messages
      (id, conversation_id, role, content, events_json, produced_files_json, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      'm1', 'c1', 'assistant', 'done',
      JSON.stringify([{ event: 'agent', data: { type: 'usage' } }]),
      JSON.stringify([{ path: 'artifact.html' }]), 0, 1,
    );

    deleteProject(db, 'p1', { facts: 'none' });

    expect(db.prepare(`SELECT 1 FROM conversations WHERE id = 'c1'`).get()).toBeUndefined();
    // Run events and artifact projections are columns of the message row; proving
    // the row is gone covers all four residual classes with the real FK cascade.
    expect(db.prepare(`SELECT events_json, produced_files_json FROM messages WHERE id = 'm1'`).get())
      .toBeUndefined();
  });
});
