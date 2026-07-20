import path from 'node:path';
import { rm } from 'node:fs/promises';
import { isSafeId, removeProjectDir } from './projects.js';
import { dropState as dropProjectSyncState } from './sync/engine.js';
import { deleteMemoryEntriesByProject } from './memory.js';

/**
 * Best-effort sweep of the per-project data that lives OUTSIDE
 * PROJECTS_DIR/<id> and outside the DB cascade — the four residual classes
 * that would otherwise leak forever on project delete:
 *
 *   artifacts/<projectId>/<runId>/   critique transcripts (server.ts)
 *   runs/<runId>/                    run event logs (runtimes/runs.ts)
 *   sync/<projectId>.json            sync engine state (cold eviction only
 *                                    reclaims synced projects)
 *   memory/<tenant>/<id>.md          project-scoped memory entries
 *
 * Shared by every delete path (HTTP DELETE /api/projects/:id and the
 * routine-creation rollback in server.ts) so a new delete path cannot
 * silently reintroduce the leak. Callers must have already verified
 * ownership and removed the project row; failures here are logged, never
 * thrown — the project is already gone, and failing the delete would leave
 * the UI claiming it still exists.
 *
 * Known residual gaps (by construction, documented rather than hidden):
 * - runIds comes from surviving messages rows; runs whose messages never
 *   persisted (spawn failure) or whose conversation was deleted earlier are
 *   not discoverable — a durable runId→projectId registry would be needed.
 * - ARTIFACTS_DIR is a shared keyspace (`${stamp}-${slug}` saved artifacts,
 *   projectless critique runs keyed by runId); removeProjectDir's isSafeId
 *   check guards traversal but not a deliberately colliding project id.
 */
export async function cleanupProjectResiduals(opts: {
  projectId: string;
  runIds: string[];
  artifactsDir: string;
  runtimeDataDir: string;
}): Promise<void> {
  const { projectId, runIds, artifactsDir, runtimeDataDir } = opts;
  const tasks: Array<{ label: string; run: () => Promise<unknown> }> = [
    {
      label: 'artifacts',
      // removeProjectDir (not a raw rm) so the id gets isSafeId validation
      // even when a future caller skips its own check.
      run: () => removeProjectDir(artifactsDir, projectId),
    },
    ...runIds.filter(isSafeId).map((runId) => ({
      label: `runs/${runId}`,
      run: () => rm(path.join(runtimeDataDir, 'runs', runId), { recursive: true, force: true }),
    })),
    { label: 'sync-state', run: () => dropProjectSyncState(projectId) },
    { label: 'memory', run: () => deleteMemoryEntriesByProject(runtimeDataDir, projectId) },
  ];
  await Promise.all(
    tasks.map(({ label, run }) =>
      run().catch((err) => {
        console.warn(
          `[project-delete] residual cleanup failed (${label}) for ${projectId}: ${err?.message || err}`,
        );
      }),
    ),
  );
}
