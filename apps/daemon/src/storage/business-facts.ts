import { requireRequestContext, type VerifiedPrincipal } from '../request-context.js';
import { resolveDaemonDbConfig } from './daemon-db.js';
import { query, transaction, type PgQueryable } from './pg.js';

export interface ProjectFact {
  id: string;
  name: string;
  skillId?: string | null;
  designSystemId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageFact {
  id: string;
  conversationId: string;
  projectId: string;
  runStatus: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface UsageFact {
  model: string | null;
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  durationMs?: number;
  createdAt: number;
}

export interface BusinessFactsStore {
  readonly enabled: boolean;
  upsertProject(fact: ProjectFact): Promise<void>;
  /** Trusted local projection update; never creates or changes ownership. */
  updateProjectProjection(fact: ProjectFact): Promise<void>;
  createProject(fact: ProjectFact, conversationId?: string): Promise<void>;
  /** Compensates a primary-store create failure; never creates a tombstone. */
  discardProject(projectId: string): Promise<void>;
  deleteProject(projectId: string, deletedAt?: number): Promise<void>;
  upsertConversation(id: string, projectId: string): Promise<void>;
  upsertMessage(fact: MessageFact, usage?: UsageFact): Promise<void>;
  incrementProjectCounter(projectId: string, counter: 'download_count' | 'published_count'): Promise<void>;
  recordProjectEvent(projectId: string, event: 'download' | 'publish', eventKey: string): Promise<void>;
}

type TransactionRunner = <T>(work: (client: PgQueryable) => Promise<T>) => Promise<T>;

export interface BusinessFactsStoreOptions {
  enabled: boolean;
  query?: PgQueryable['query'];
  transaction?: TransactionRunner;
  principal?: () => Readonly<VerifiedPrincipal>;
}

function safeCount(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

function safeOptionalNonNegative(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One terminal aggregate per message; richer retries update this same event. */
export function businessUsageEventKey(messageId: string, _usage: UsageFact): string {
  return `${messageId}:terminal-usage`;
}

export function createBusinessFactsStore(options?: Partial<BusinessFactsStoreOptions>): BusinessFactsStore {
  const enabled = options?.enabled ?? resolveDaemonDbConfig().kind === 'postgres';
  if (!enabled) {
    const noop = async (): Promise<void> => {};
    return {
      enabled: false,
      upsertProject: noop,
      updateProjectProjection: noop,
      createProject: noop,
      discardProject: noop,
      deleteProject: noop,
      upsertConversation: noop,
      upsertMessage: noop,
      incrementProjectCounter: noop,
      recordProjectEvent: noop,
    };
  }

  const runQuery = options?.query ?? query;
  const runTransaction: TransactionRunner = options?.transaction
    ?? ((work) => transaction((client) => work(client)));
  const principal = options?.principal ?? requireRequestContext;
  const identity = (): Readonly<VerifiedPrincipal> => {
    const value = principal();
    if (!value.tenantId || !value.userId) throw new Error('Business facts require a verified principal');
    return value;
  };

  return {
    enabled: true,
    async upsertProject(fact) {
      const actor = identity();
      const result = await runQuery(
        `INSERT INTO projects
           (id, name, skill_id, design_system_id, tenant_id, creator_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           skill_id = EXCLUDED.skill_id,
           design_system_id = EXCLUDED.design_system_id,
           updated_at = GREATEST(projects.updated_at, EXCLUDED.updated_at)
         WHERE projects.tenant_id = EXCLUDED.tenant_id
           AND projects.creator_id = EXCLUDED.creator_id
         RETURNING id`,
        [fact.id, fact.name, fact.skillId ?? null, fact.designSystemId ?? null,
          actor.tenantId, actor.userId, fact.createdAt, fact.updatedAt],
      );
      if (result.rowCount !== 1) throw new Error('Project fact identity conflict');
    },
    async updateProjectProjection(fact) {
      const result = await runQuery(
        `UPDATE projects SET name = $2, skill_id = $3, design_system_id = $4,
           updated_at = GREATEST(updated_at, $5)
          WHERE id = $1`,
        [fact.id, fact.name, fact.skillId ?? null, fact.designSystemId ?? null, fact.updatedAt],
      );
      if (result.rowCount !== 1) throw new Error('Project fact missing for projection update');
    },
    async createProject(fact, conversationId) {
      const actor = identity();
      await runTransaction(async (client) => {
        const inserted = await client.query(
          `INSERT INTO projects
             (id, name, skill_id, design_system_id, tenant_id, creator_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name,
             skill_id = EXCLUDED.skill_id, design_system_id = EXCLUDED.design_system_id
           WHERE projects.tenant_id = EXCLUDED.tenant_id
             AND projects.creator_id = EXCLUDED.creator_id
           RETURNING id`,
          [fact.id, fact.name, fact.skillId ?? null, fact.designSystemId ?? null,
            actor.tenantId, actor.userId, fact.createdAt, fact.updatedAt],
        );
        if (inserted.rowCount !== 1) throw new Error('Project fact identity conflict');
        if (conversationId) {
          await client.query(
            `INSERT INTO conversations (id, project_id) VALUES ($1, $2)
             ON CONFLICT (id) DO NOTHING`,
            [conversationId, fact.id],
          );
        }
      });
    },
    async discardProject(projectId) {
      const actor = identity();
      await runQuery('DELETE FROM projects WHERE id = $1 AND tenant_id = $2', [projectId, actor.tenantId]);
    },
    async deleteProject(projectId, deletedAt = Date.now()) {
      const actor = identity();
      await runTransaction(async (client) => {
        const result = await client.query<{ tenant_id: string; creator_id: string }>(
          `SELECT tenant_id, creator_id FROM projects WHERE id = $1 FOR UPDATE`,
          [projectId],
        );
        const row = result.rows[0];
        const owner = row ?? (await client.query<{ tenant_id: string; creator_id: string }>(
          `SELECT tenant_id, creator_id FROM deleted_projects WHERE id = $1 FOR UPDATE`,
          [projectId],
        )).rows[0];
        if (!owner) return;
        if (owner.tenant_id !== actor.tenantId) throw new Error('Project fact tenant mismatch');
        if (row) await client.query(
          `INSERT INTO deleted_projects
             (id, name, skill_id, design_system_id, tenant_id, creator_id,
              created_at, updated_at, deleted_at, download_count, published_count)
           SELECT id, name, skill_id, design_system_id, tenant_id, creator_id,
                  created_at, updated_at, $2,
                  download_count, published_count
             FROM projects WHERE id = $1
           ON CONFLICT (id) DO NOTHING`,
          [projectId, deletedAt],
        );
        // Facts tied to a live project are not tombstones. Remove leaf rows first
        // (usage has a RESTRICT FK), then conversations, so no project deletion
        // leaves backend-visible conversation/message residuals.
        await client.query('DELETE FROM message_token_usage WHERE project_id = $1 AND tenant_id = $2',
          [projectId, actor.tenantId]);
        await client.query(
          `DELETE FROM messages WHERE conversation_id IN (
             SELECT id FROM conversations WHERE project_id = $1
           )`, [projectId],
        );
        await client.query('DELETE FROM conversations WHERE project_id = $1', [projectId]);
        await client.query('DELETE FROM projects WHERE id = $1 AND tenant_id = $2', [projectId, actor.tenantId]);
      });
    },
    async upsertConversation(id, projectId) {
      const actor = identity();
      await runQuery(
        `INSERT INTO conversations (id, project_id)
         SELECT $1, id FROM projects WHERE id = $2 AND tenant_id = $3
         ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id`,
        [id, projectId, actor.tenantId],
      );
    },
    async upsertMessage(fact, usage) {
      const actor = identity();
      await runTransaction(async (client) => {
        await client.query(
          `INSERT INTO conversations (id, project_id)
           SELECT $1, id FROM projects WHERE id = $2 AND tenant_id = $3
           ON CONFLICT (id) DO UPDATE SET project_id = EXCLUDED.project_id`,
          [fact.conversationId, fact.projectId, actor.tenantId],
        );
        await client.query(
          `INSERT INTO messages (id, conversation_id, run_status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (id) DO UPDATE SET
             run_status = EXCLUDED.run_status,
             updated_at = GREATEST(messages.updated_at, EXCLUDED.updated_at)
           WHERE messages.conversation_id = EXCLUDED.conversation_id
             AND EXISTS (
               SELECT 1 FROM conversations c
                WHERE c.id = messages.conversation_id AND (
                  EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id AND p.tenant_id = $6)
                  OR EXISTS (SELECT 1 FROM deleted_projects p WHERE p.id = c.project_id AND p.tenant_id = $6)
                )
             )`,
          [fact.id, fact.conversationId, fact.runStatus, fact.createdAt, fact.updatedAt, actor.tenantId],
        );
        if (!usage) return;
        const input = safeCount(usage.inputTokens);
        const output = safeCount(usage.outputTokens);
        const total = safeCount(usage.totalTokens) || input + output;
        await client.query(
          `INSERT INTO message_token_usage
             (event_key, user_id, tenant_id, project_id, conversation_id, message_id, model,
              input_tokens, output_tokens, reasoning_tokens, cache_read_tokens,
              cache_write_tokens, total_tokens, cost_usd, duration_ms, created_at)
           SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16
           WHERE EXISTS (
             SELECT 1 FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE m.id = $6 AND c.id = $5 AND c.project_id = $4 AND (
                EXISTS (SELECT 1 FROM projects p WHERE p.id = c.project_id AND p.tenant_id = $17)
                OR EXISTS (SELECT 1 FROM deleted_projects p WHERE p.id = c.project_id AND p.tenant_id = $17)
              )
           )
           ON CONFLICT (event_key) DO UPDATE SET
             model = CASE WHEN EXCLUDED.model = 'unknown' THEN message_token_usage.model ELSE EXCLUDED.model END,
             input_tokens = GREATEST(message_token_usage.input_tokens, EXCLUDED.input_tokens),
             output_tokens = GREATEST(message_token_usage.output_tokens, EXCLUDED.output_tokens),
             reasoning_tokens = GREATEST(message_token_usage.reasoning_tokens, EXCLUDED.reasoning_tokens),
             cache_read_tokens = GREATEST(message_token_usage.cache_read_tokens, EXCLUDED.cache_read_tokens),
             cache_write_tokens = GREATEST(message_token_usage.cache_write_tokens, EXCLUDED.cache_write_tokens),
             total_tokens = GREATEST(message_token_usage.total_tokens, EXCLUDED.total_tokens),
             cost_usd = COALESCE(EXCLUDED.cost_usd, message_token_usage.cost_usd),
             duration_ms = COALESCE(EXCLUDED.duration_ms, message_token_usage.duration_ms)
           WHERE message_token_usage.message_id = EXCLUDED.message_id
             AND message_token_usage.tenant_id = EXCLUDED.tenant_id`,
          [
            businessUsageEventKey(fact.id, usage), actor.userId, actor.tenantId,
            fact.projectId, fact.conversationId, fact.id, usage.model ?? 'unknown', input, output,
            safeCount(usage.reasoningTokens), safeCount(usage.cacheReadTokens),
            safeCount(usage.cacheWriteTokens), total,
            safeOptionalNonNegative(usage.costUsd), safeOptionalNonNegative(usage.durationMs),
            usage.createdAt, actor.tenantId,
          ],
        );
      });
    },
    async recordProjectEvent(projectId, event, eventKey) {
      const actor = identity();
      if (!eventKey || eventKey.length > 256) throw new Error('Invalid business stats event key');
      const counter = event === 'download' ? 'download_count' : 'published_count';
      const result = await runQuery(
        `WITH inserted AS (
           INSERT INTO business_stat_events (event_key, project_id, event_type, created_at)
           SELECT $1, id, $3, $4 FROM projects WHERE id = $2 AND tenant_id = $5
           ON CONFLICT (event_key) DO NOTHING
           RETURNING project_id
         )
         UPDATE projects SET ${counter} = ${counter} + 1,
                             updated_at = GREATEST(updated_at, $4)
          WHERE id IN (SELECT project_id FROM inserted)`,
        [eventKey, projectId, event, Date.now(), actor.tenantId],
      );
      if (result.rowCount !== 1 && result.rowCount !== 0) throw new Error('Unexpected project event result');
    },
    async incrementProjectCounter(projectId, counter) {
      const actor = identity();
      // counter is a closed typed allowlist, never request input.
      const result = await runQuery(
        `UPDATE projects SET ${counter} = ${counter} + 1, updated_at = GREATEST(updated_at, $3)
          WHERE id = $1 AND tenant_id = $2`,
        [projectId, actor.tenantId, Date.now()],
      );
      if (result.rowCount !== 1) throw new Error('Project fact not found for verified tenant');
    },
  };
}
