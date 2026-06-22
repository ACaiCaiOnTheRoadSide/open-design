// GenUI surface registry — high-level orchestration over store + events
// (spec §10.3). Houses:
//
//   - `schemaDigest()` — stable hex of a JSON Schema (drives F8 cache invalidation)
//   - `requestOrReuseSurface()` — F8 cache lookup → either reuse + emit a
//     `genui_surface_response { respondedBy: 'cache' }` (no broadcast of a
//     new request) or insert a `pending` row + emit a request event.
//   - `respondSurface()` — write user / agent / auto answer, emit response
//     + state-synced events.
//   - `revokeSurface()` — flip cross-conversation rows to `invalidated`.
//
// All side effects are concentrated here; the underlying SQLite writes go
// through `store.ts`, the SSE / ND-JSON event emission goes through the
// caller-provided `GenUIEventSink` from `events.ts`. Tests can swap either.

import { createHash } from 'node:crypto';
import type { AsyncDb } from '../storage/pg-async.js';
import type { GenUISurfaceSpec } from '@open-design/contracts';
import {
  buildStateSyncedEvent,
  buildSurfaceRequestEvent,
  buildSurfaceResponseEvent,
  type GenUIEventSink,
} from './events.js';
import {
  lookupResolved,
  prefillSurface,
  requestSurface,
  respondSurface as respondSurfaceRow,
  revokeSurface as revokeSurfaceRow,
  type RespondSurfaceInput,
  type SurfaceKind,
  type SurfaceRespondedBy,
  type SurfaceRow,
  type SurfaceTier,
} from './store.js';

type SqliteDb = AsyncDb;

// Stable digest of a JSON-Schema-shaped object. Used by `genui_surfaces`
// rows so a schema upgrade auto-invalidates cached answers (spec §10.3.3).
// Canonical key order ensures parsing twice → same digest.
export function schemaDigest(schema: unknown): string {
  if (schema === undefined || schema === null) return '';
  const canonical = canonicalize(schema);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export interface RequestOrReuseInput {
  projectId:        string;
  conversationId?:  string | null | undefined;
  runId:            string;
  pluginSnapshotId: string;
  surface:          GenUISurfaceSpec;
  payload?:         unknown;
  emit?:            GenUIEventSink;
}

export interface RequestOrReuseResult {
  reused:  boolean;
  row:     SurfaceRow;
}

// F8: try cache before broadcasting. On hit at the right tier with a
// matching schema digest and unexpired row, emit a response event with
// `respondedBy: 'cache'` and return the cached row. On miss, insert a
// pending row and emit a request event.
export async function requestOrReuseSurface(
  db: SqliteDb,
  input: RequestOrReuseInput,
): Promise<RequestOrReuseResult> {
  const surface = input.surface;
  const persist: SurfaceTier = surface.persist;
  const digest = surface.schema ? schemaDigest(surface.schema) : null;
  if (persist !== 'run') {
    const cached = await lookupResolved(db, {
      projectId:      input.projectId,
      conversationId: input.conversationId,
      surfaceId:      surface.id,
      persist,
      schemaDigest:   digest,
    });
    if (cached) {
      input.emit?.(
        buildSurfaceResponseEvent({
          surfaceRow:  cached,
          runId:       input.runId,
          respondedBy: 'cache',
        }),
      );
      return { reused: true, row: cached };
    }
  }
  const row = await requestSurface(db, {
    projectId:        input.projectId,
    conversationId:   input.conversationId,
    runId:            input.runId,
    pluginSnapshotId: input.pluginSnapshotId,
    surfaceId:        surface.id,
    kind:             surface.kind,
    persist,
    schemaDigest:     digest,
  });
  input.emit?.(
    buildSurfaceRequestEvent({
      surfaceRow: row,
      runId:      input.runId,
      payload:    input.payload ?? surface,
    }),
  );
  return { reused: false, row };
}

export interface RespondInput extends RespondSurfaceInput {
  runId:        string;
  emit?:        GenUIEventSink;
}

export async function respondSurface(db: SqliteDb, input: RespondInput): Promise<SurfaceRow> {
  const row = await respondSurfaceRow(db, input);
  input.emit?.(
    buildSurfaceResponseEvent({
      surfaceRow:  row,
      runId:       input.runId,
      respondedBy: input.respondedBy as SurfaceRespondedBy,
    }),
  );
  if (row.persist !== 'run') {
    input.emit?.(
      buildStateSyncedEvent({ surfaceRow: row, runId: input.runId }),
    );
  }
  return row;
}

export interface RevokeInput {
  projectId:  string;
  surfaceId:  string;
}

export async function revokeProjectSurface(db: SqliteDb, input: RevokeInput): Promise<number> {
  return revokeSurfaceRow(db, input);
}

export interface PrefillInput {
  projectId:        string;
  pluginSnapshotId: string;
  surfaceId:        string;
  kind:             SurfaceKind;
  persist:          SurfaceTier;
  value:            unknown;
  schema?:          unknown;
  expiresAt?:       number | null;
}

export async function prefillProjectSurface(db: SqliteDb, input: PrefillInput): Promise<SurfaceRow> {
  const digest = input.schema !== undefined ? schemaDigest(input.schema) : null;
  return prefillSurface(db, {
    projectId:        input.projectId,
    pluginSnapshotId: input.pluginSnapshotId,
    surfaceId:        input.surfaceId,
    kind:             input.kind,
    persist:          input.persist,
    value:            input.value,
    schemaDigest:     digest,
    expiresAt:        input.expiresAt ?? null,
  });
}
