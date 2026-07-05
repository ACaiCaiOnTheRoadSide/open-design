import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'vitest';

import {
  closeDatabase,
  insertConversation,
  insertProject,
  getConversation,
  listConversations,
  listLatestConversationRunStatuses,
  listLatestProjectRunStatuses,
  listProjectsAwaitingInput,
  openDatabase,
  upsertMessage,
} from '../src/db.js';
import { composeProjectDisplayStatus } from '../src/server.js';

type Db = Awaited<ReturnType<typeof openDatabase>>;

// 本 fork 的 openDatabase 连的是共享 PG 测试库(忽略传入路径),projects/
// conversations/messages 的 id 是全局主键且跨测试、跨运行残留。因此:
//  - 每个测试用 uid() 铸唯一 project id,conversation/message/run id 全部
//    从它派生,避免主键冲突和 upsert 撞到别的测试的行;
//  - listProjectsAwaitingInput / listLatest*RunStatuses 返回的是整个租户的
//    全量集合,断言只用 has()/get() 查本测试的 id,不对全量做 deepEqual。

function uid(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

const tempDirs: string[] = [];

afterEach(async () => {
  await closeDatabase();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function createDb(): Promise<Db> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-project-status-'));
  tempDirs.push(dir);
  return openDatabase(dir, { dataDir: path.join(dir, '.od') });
}

async function seedProject(db: Db, projectId: string, runStatus = 'succeeded') {
  await insertProject(db, {
    id: projectId,
    name: projectId,
    createdAt: 1,
    updatedAt: 1,
  });
  await insertConversation(db, {
    id: `${projectId}-conversation`,
    projectId,
    title: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await upsertMessage(db, `${projectId}-conversation`, {
    id: `${projectId}-run`,
    role: 'assistant',
    content: 'done',
    runId: `${projectId}-run-id`,
    runStatus,
    endedAt: 50,
  });
  return `${projectId}-conversation`;
}

async function addMessage(
  db: Db,
  conversationId: string,
  id: string,
  role: 'user' | 'assistant',
  content: string,
) {
  await upsertMessage(db, conversationId, { id, role, content });
}

test('unanswered structured question marks project as awaiting input', async () => {
  const db = await createDb();
  const projectId = uid('project-a');
  const conversationId = await seedProject(db, projectId);

  await addMessage(db, conversationId, `${conversationId}-question`, 'assistant', 'Need one choice\n<question-form id="q1">');

  assert.equal((await listProjectsAwaitingInput(db)).has(projectId), true);
});

test('ask-question alias of question-form also marks project as awaiting input', async () => {
  const db = await createDb();
  const projectId = uid('project-a-alias');
  const conversationId = await seedProject(db, projectId);

  // <ask-question> is an accepted alias for <question-form>; an alias-form
  // turn must mark the project awaiting input just like the canonical tag.
  await addMessage(db, conversationId, `${conversationId}-question`, 'assistant', 'Need one choice\n<ask-question id="q1">');

  assert.equal((await listProjectsAwaitingInput(db)).has(projectId), true);
});

test('user reply after structured question clears awaiting input', async () => {
  const db = await createDb();
  const projectId = uid('project-b');
  const conversationId = await seedProject(db, projectId);

  await addMessage(db, conversationId, `${conversationId}-question`, 'assistant', '<question-form id="q1">');
  await addMessage(db, conversationId, `${conversationId}-answer`, 'user', 'Here is my answer');

  assert.equal((await listProjectsAwaitingInput(db)).has(projectId), false);
});

test('latest structured question form wins across assistant turns', async () => {
  const db = await createDb();
  const projectId = uid('project-c');
  const conversationId = await seedProject(db, projectId);

  await addMessage(db, conversationId, `${conversationId}-question-1`, 'assistant', '<question-form id="q1">');
  await addMessage(db, conversationId, `${conversationId}-answer`, 'user', 'answered');
  await addMessage(db, conversationId, `${conversationId}-question-2`, 'assistant', '<question-form id="q2">');

  assert.equal((await listProjectsAwaitingInput(db)).has(projectId), true);
});

test('plain text question does not mark awaiting input', async () => {
  const db = await createDb();
  const projectId = uid('project-d');
  const conversationId = await seedProject(db, projectId);

  await addMessage(db, conversationId, `${conversationId}-question`, 'assistant', 'Can you clarify the color palette?');

  assert.equal((await listProjectsAwaitingInput(db)).has(projectId), false);
});

test('conversation latest run follows assistant message position', async () => {
  const db = await createDb();
  const projectId = uid('project-latest');
  const conversationId = await seedProject(db, projectId, 'succeeded');

  await upsertMessage(db, conversationId, {
    id: `${conversationId}-running`,
    role: 'assistant',
    content: 'working',
    runId: `${conversationId}-running-id`,
    runStatus: 'running',
    startedAt: 20,
  });

  assert.equal((await listConversations(db, projectId))[0]?.latestRun?.status, 'running');
  assert.equal((await getConversation(db, conversationId))?.latestRun?.status, 'running');
});

test('conversation latest run status breaks timestamp ties by message position', async () => {
  const db = await createDb();
  const projectId = uid('project-conversation-status-tie');
  const conversationId = `${projectId}-conversation`;
  await insertProject(db, {
    id: projectId,
    name: projectId,
    createdAt: 1,
    updatedAt: 1,
  });
  await insertConversation(db, {
    id: conversationId,
    projectId,
    title: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-failed`,
    role: 'assistant',
    content: 'failed',
    runId: `${conversationId}-failed-run`,
    runStatus: 'failed',
    endedAt: 50,
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-succeeded`,
    role: 'assistant',
    content: 'succeeded',
    runId: `${conversationId}-succeeded-run`,
    runStatus: 'succeeded',
    endedAt: 50,
  });

  const runStatuses = await listLatestConversationRunStatuses(db);

  assert.equal(runStatuses.get(conversationId)?.value, 'succeeded');
  assert.equal(runStatuses.get(conversationId)?.runId, `${conversationId}-succeeded-run`);
});

test('conversation summaries expose cumulative completed run duration', async () => {
  const db = await createDb();
  const projectId = uid('project-duration');
  const conversationId = `${projectId}-conversation`;
  await insertProject(db, {
    id: projectId,
    name: projectId,
    createdAt: 1,
    updatedAt: 1,
  });
  await insertConversation(db, {
    id: conversationId,
    projectId,
    title: 'Duration test',
    createdAt: 1,
    updatedAt: 4,
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-first`,
    role: 'assistant',
    content: 'first done',
    runId: `${conversationId}-first-run`,
    runStatus: 'succeeded',
    startedAt: 10_000,
    endedAt: 40_000,
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-running`,
    role: 'assistant',
    content: 'still running',
    runId: `${conversationId}-running-run`,
    runStatus: 'running',
    startedAt: 45_000,
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-second`,
    role: 'assistant',
    content: 'second done',
    runId: `${conversationId}-second-run`,
    runStatus: 'failed',
    startedAt: 50_000,
    endedAt: 125_000,
  });

  const listed = (await listConversations(db, projectId))[0] as { totalDurationMs?: number };
  const fetched = await getConversation(db, conversationId) as { totalDurationMs?: number } | null;

  assert.equal(listed.totalDurationMs, 105_000);
  assert.equal(fetched?.totalDurationMs, 105_000);
});

test('usage-only terminal run durations degrade to 0 in the PG total (fork semantics)', async () => {
  // 上游 sqlite 版里 usage-only 终态 run 会从 events_json 里取 durationMs
  // 计入总时长(此例应为 52_000)。本 fork 的 PG 版 terminalRunDurationSql
  // 明确放弃 events_json 兜底("the events_json fallback degrades to 0",
  // src/db.ts),usage-only run 计 0,只有带时间戳的 run 计入。
  const db = await createDb();
  const projectId = uid('project-usage-duration');
  const conversationId = `${projectId}-conversation`;
  await insertProject(db, {
    id: projectId,
    name: projectId,
    createdAt: 1,
    updatedAt: 1,
  });
  await insertConversation(db, {
    id: conversationId,
    projectId,
    title: 'Usage duration test',
    createdAt: 1,
    updatedAt: 4,
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-imported`,
    role: 'assistant',
    content: 'imported done',
    runId: `${conversationId}-imported-run`,
    runStatus: 'succeeded',
    events: [{ kind: 'usage', durationMs: 22_000 }],
  });
  await upsertMessage(db, conversationId, {
    id: `${conversationId}-timestamped`,
    role: 'assistant',
    content: 'timestamped done',
    runId: `${conversationId}-timestamped-run`,
    runStatus: 'succeeded',
    startedAt: 30_000,
    endedAt: 60_000,
  });

  const listed = (await listConversations(db, projectId))[0] as { totalDurationMs?: number };
  const fetched = await getConversation(db, conversationId) as { totalDurationMs?: number } | null;

  assert.equal(listed.totalDurationMs, 30_000);
  assert.equal(fetched?.totalDurationMs, 30_000);
});

test('conversation listing batches latest run summaries for large projects', async () => {
  const db = await createDb();
  const projectId = uid('project-large');
  await insertProject(db, {
    id: projectId,
    name: projectId,
    createdAt: 1,
    updatedAt: 1,
  });
  for (let i = 0; i < 125; i += 1) {
    const conversationId = `${projectId}-conversation-${i}`;
    await insertConversation(db, {
      id: conversationId,
      projectId,
      title: `Conversation ${i}`,
      createdAt: i,
      updatedAt: i,
    });
    await upsertMessage(db, conversationId, {
      id: `${conversationId}-older`,
      role: 'assistant',
      content: 'done',
      runId: `${conversationId}-older-run`,
      runStatus: 'succeeded',
      startedAt: 10,
      endedAt: 20,
    });
    await upsertMessage(db, conversationId, {
      id: `${conversationId}-latest`,
      role: 'assistant',
      content: 'failed',
      runId: `${conversationId}-latest-run`,
      runStatus: 'failed',
      startedAt: 100,
      endedAt: 175,
    });
  }

  const preparedSql: string[] = [];
  const instrumentedDb = new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          preparedSql.push(sql);
          return target.prepare(sql);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as Db;

  const conversations = await listConversations(instrumentedDb, projectId);

  assert.equal(conversations.length, 125);
  assert.equal(preparedSql.length, 1);
  assert.equal(conversations[0]?.latestRun?.status, 'failed');
  assert.equal(conversations[0]?.latestRun?.durationMs, 75);
  assert.equal(conversations[0]?.messageCount, 2);
});

test('only succeeded statuses are overridden by awaiting input', async () => {
  const db = await createDb();
  const failedProjectId = uid('project-failed');
  const canceledProjectId = uid('project-canceled');
  const runningProjectId = uid('project-running');
  const failedConversationId = await seedProject(db, failedProjectId, 'failed');
  const canceledConversationId = await seedProject(db, canceledProjectId, 'canceled');
  const runningConversationId = await seedProject(db, runningProjectId, 'running');

  await addMessage(db, failedConversationId, `${failedConversationId}-question`, 'assistant', '<question-form id="failed">');
  await addMessage(db, canceledConversationId, `${canceledConversationId}-question`, 'assistant', '<question-form id="canceled">');
  await addMessage(db, runningConversationId, `${runningConversationId}-question`, 'assistant', '<question-form id="running">');

  const awaiting = await listProjectsAwaitingInput(db);
  const runStatuses = await listLatestProjectRunStatuses(db);

  assert.equal(awaiting.has(failedProjectId), true);
  assert.equal(awaiting.has(canceledProjectId), true);
  assert.equal(awaiting.has(runningProjectId), true);
  assert.equal(runStatuses.get(failedProjectId)?.value, 'failed');
  assert.equal(runStatuses.get(canceledProjectId)?.value, 'canceled');
  assert.equal(runStatuses.get(runningProjectId)?.value, 'running');
});

test('queued active run surfaces as running in project projection', () => {
  const status = composeProjectDisplayStatus(
    {
      value: 'queued',
      updatedAt: 42,
      runId: 'active-run',
    },
    new Set(),
    'project-queued-active',
  );

  assert.deepEqual(status, {
    value: 'running',
    updatedAt: 42,
    runId: 'active-run',
  });
});

test('queued db-latest run status surfaces as running in project projection', async () => {
  const db = await createDb();
  const projectId = uid('project-queued-db');
  await seedProject(db, projectId, 'queued');

  const runStatuses = await listLatestProjectRunStatuses(db);
  const status = composeProjectDisplayStatus(
    runStatuses.get(projectId) ?? { value: 'not_started' },
    new Set(),
    projectId,
  );

  assert.equal(runStatuses.get(projectId)?.value, 'queued');
  assert.deepEqual(status, {
    value: 'running',
    updatedAt: 50,
    runId: `${projectId}-run-id`,
  });
});
