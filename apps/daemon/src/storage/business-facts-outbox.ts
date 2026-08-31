import type Database from 'better-sqlite3';
import { requireRequestContext, runWithRequestContext, type VerifiedPrincipal } from '../request-context.js';
import type {
  AgentRunResultFact,
  BusinessFactsStore,
  MessageFact,
  ProjectFact,
  ToolCallFact,
  UsageFact,
} from './business-facts.js';

type SqliteDb = Database.Database;
type OutboxPayload =
  | { kind: 'message'; principal: VerifiedPrincipal; message: MessageFact; usage?: UsageFact; toolCalls?: ToolCallFact[] }
  | { kind: 'project-create'; principal: VerifiedPrincipal; project: ProjectFact }
  | { kind: 'project-update'; project: ProjectFact }
  | { kind: 'project-delete'; principal: VerifiedPrincipal; projectId: string; deletedAt: number }
  | { kind: 'project-discard'; principal: VerifiedPrincipal; projectId: string }
  | { kind: 'agent-run-result'; principal: VerifiedPrincipal; result: AgentRunResultFact };

export interface BusinessFactsOutbox {
  recordMessage(message: MessageFact, usage?: UsageFact, toolCalls?: ToolCallFact[]): Promise<void>;
  enqueueProjectCreate(project: ProjectFact, principal?: VerifiedPrincipal): void;
  enqueueProjectUpdate(project: ProjectFact): void;
  enqueueProjectDelete(projectId: string, deletedAt: number, principal?: VerifiedPrincipal): void;
  recordProjectDelete(projectId: string, deletedAt: number, principal?: VerifiedPrincipal): Promise<void>;
  enqueueProjectDiscard(projectId: string, principal?: VerifiedPrincipal): void;
  recordAgentRunResult(result: AgentRunResultFact, principal: VerifiedPrincipal): Promise<void>;
  drain(): Promise<void>;
  stop(): void;
}

function verifiedPrincipal(explicit?: VerifiedPrincipal): VerifiedPrincipal {
  const principal = explicit ?? requireRequestContext();
  if (!principal.tenantId || !principal.userId) throw new Error('Business facts require a verified principal');
  return { tenantId: principal.tenantId, userId: principal.userId };
}

/** Durable, ordered SQLite retry boundary for PostgreSQL business projection. */
export function createBusinessFactsOutbox(
  db: SqliteDb,
  store: BusinessFactsStore,
  options: { intervalMs?: number } = {},
): BusinessFactsOutbox {
  let draining: Promise<void> | null = null;
  let stopped = false;
  const maxCreated = db.prepare(`SELECT COALESCE(MAX(created_at), 0) AS value FROM business_fact_outbox`)
    .get() as { value?: number } | undefined;
  let lastEnqueuedAt = Number(maxCreated?.value ?? 0);

  const flush = async (): Promise<void> => {
    if (!store.enabled || stopped) return;
    while (!stopped) {
      const rows = db.prepare(
        `SELECT id, payload_json AS payloadJson, created_at AS createdAt
         FROM business_fact_outbox ORDER BY created_at, id LIMIT 100`,
      ).all() as Array<{ id: string; payloadJson: string; createdAt: number }>;
      if (rows.length === 0) return;

      for (const row of rows) {
        let payload: OutboxPayload;
        try {
          payload = JSON.parse(row.payloadJson) as OutboxPayload;
        } catch (error) {
          db.prepare(
            `UPDATE business_fact_outbox SET attempts = attempts + 1, last_error = ?
             WHERE id = ? AND payload_json = ? AND created_at = ?`,
          ).run(String(error), row.id, row.payloadJson, row.createdAt);
          return; // global FIFO: never allow a later aggregate to overtake
        }
        try {
          if (payload.kind === 'message') {
            await runWithRequestContext(payload.principal, () =>
              store.upsertMessage(payload.message, payload.usage, payload.toolCalls));
          } else if (payload.kind === 'project-create') {
            await runWithRequestContext(payload.principal, () => store.createProject(payload.project));
          } else if (payload.kind === 'project-update') {
            await store.updateProjectProjection(payload.project);
          } else if (payload.kind === 'project-delete') {
            await runWithRequestContext(payload.principal, () => store.deleteProject(payload.projectId, payload.deletedAt));
          } else if (payload.kind === 'project-discard') {
            await runWithRequestContext(payload.principal, () => store.discardProject(payload.projectId));
          } else if (payload.kind === 'agent-run-result') {
            await store.recordAgentRunResult(payload.result, payload.principal);
          } else {
            throw new Error('Unknown business fact outbox payload');
          }
          db.prepare(
            `DELETE FROM business_fact_outbox WHERE id = ? AND payload_json = ? AND created_at = ?`,
          ).run(row.id, row.payloadJson, row.createdAt);
        } catch (error) {
          db.prepare(
            `UPDATE business_fact_outbox SET attempts = attempts + 1, last_error = ?
             WHERE id = ? AND payload_json = ? AND created_at = ?`,
          ).run(String(error).slice(0, 1000), row.id, row.payloadJson, row.createdAt);
          return; // stop on first failure; per-project/message ordering is preserved
        }
      }
      // Enqueues can happen while PostgreSQL is awaited. Poll a fresh snapshot so
      // every caller sharing this drain observes all revisions queued before it settles.
    }
  };

  const drain = (): Promise<void> => {
    if (!draining) draining = flush().finally(() => { draining = null; });
    return draining;
  };
  const interval = store.enabled
    ? setInterval(() => { void drain(); }, options.intervalMs ?? 5_000)
    : null;
  interval?.unref();
  if (store.enabled) queueMicrotask(() => { void drain(); });

  const insertPayload = (id: string, payload: OutboxPayload): void => {
    lastEnqueuedAt = Math.max(Date.now(), lastEnqueuedAt + 1);
    db.prepare(
      `INSERT INTO business_fact_outbox (id, payload_json, created_at)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json,
         created_at = excluded.created_at, attempts = 0, last_error = NULL`,
    ).run(id, JSON.stringify(payload), lastEnqueuedAt);
  };

  return {
    async recordMessage(message, usage, toolCalls) {
      if (!store.enabled) return;
      const principal = verifiedPrincipal();
      const id = `message:${message.id}:${message.updatedAt}`;
      const existing = db.prepare(
        `SELECT payload_json AS payloadJson FROM business_fact_outbox WHERE id = ?`,
      ).get(id) as { payloadJson?: string } | undefined;
      let existingUsage: UsageFact | undefined;
      let existingToolCalls: ToolCallFact[] | undefined;
      if (existing?.payloadJson) {
        try {
          const parsed = JSON.parse(existing.payloadJson) as OutboxPayload;
          if (parsed.kind === 'message') {
            existingUsage = parsed.usage;
            existingToolCalls = parsed.toolCalls;
          }
        } catch {
          // Replacing an unreadable same-key payload repairs the poison row.
        }
      }
      const mergedUsage: UsageFact | undefined = usage
        ? { ...(existingUsage ?? {}), ...usage }
        : existingUsage;
      const mergedToolCalls = toolCalls?.length ? toolCalls : existingToolCalls;
      insertPayload(id, {
        kind: 'message', principal, message,
        ...(mergedUsage ? { usage: mergedUsage } : {}),
        ...(mergedToolCalls?.length ? { toolCalls: mergedToolCalls } : {}),
      });
      await drain();
      const pending = db.prepare(`SELECT 1 FROM business_fact_outbox WHERE id = ?`).get(id);
      if (pending) throw new Error('Business facts were queued for durable retry');
    },
    enqueueProjectCreate(project, explicitPrincipal) {
      if (!store.enabled) return;
      insertPayload(`project:create:${project.id}`, {
        kind: 'project-create', principal: verifiedPrincipal(explicitPrincipal), project,
      });
      queueMicrotask(() => { void drain(); });
    },
    enqueueProjectUpdate(project) {
      if (!store.enabled) return;
      insertPayload(`project:update:${project.id}`, { kind: 'project-update', project });
      queueMicrotask(() => { void drain(); });
    },
    enqueueProjectDelete(projectId, deletedAt, explicitPrincipal) {
      if (!store.enabled) return;
      insertPayload(`project:delete:${projectId}`, {
        kind: 'project-delete', principal: verifiedPrincipal(explicitPrincipal), projectId, deletedAt,
      });
      queueMicrotask(() => { void drain(); });
    },
    async recordProjectDelete(projectId, deletedAt, explicitPrincipal) {
      if (!store.enabled) return;
      insertPayload(`project:delete:${projectId}`, {
        kind: 'project-delete', principal: verifiedPrincipal(explicitPrincipal), projectId, deletedAt,
      });
      await drain();
      const pending = db.prepare(`SELECT 1 FROM business_fact_outbox WHERE id = ?`)
        .get(`project:delete:${projectId}`);
      if (pending) throw new Error('Project deletion fact was queued for durable retry');
    },
    enqueueProjectDiscard(projectId, explicitPrincipal) {
      if (!store.enabled) return;
      insertPayload(`project:discard:${projectId}`, {
        kind: 'project-discard', principal: verifiedPrincipal(explicitPrincipal), projectId,
      });
      queueMicrotask(() => { void drain(); });
    },
    async recordAgentRunResult(result, explicitPrincipal) {
      if (!store.enabled) return;
      const principal = verifiedPrincipal(explicitPrincipal);
      const id = result.eventKey;
      insertPayload(id, { kind: 'agent-run-result', principal, result });
      await drain();
      const pending = db.prepare(`SELECT 1 FROM business_fact_outbox WHERE id = ?`).get(id);
      if (pending) throw new Error('Agent run result was queued for durable retry');
    },
    drain,
    stop() {
      stopped = true;
      if (interval) clearInterval(interval);
    },
  };
}
