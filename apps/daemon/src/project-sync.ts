import { readdir } from 'node:fs/promises';
import { c as tarCreate } from 'tar';

/**
 * syncProjectToOSS packs the whole project directory into a tar.gz (archive
 * root = `<projectId>/`, matching what the sandbox restore step and the
 * daemon's own restore-archive endpoint expect) and pushes it to the backend's
 * store-archive endpoint, which overwrites `projects/<id>/files.tar.gz` on OSS.
 *
 * This runs before every agent round and is the ONLY daemon → sandbox file
 * sync channel: the sandbox restores this exact key at round start, so the
 * archive must already contain everything on the daemon's disk — including
 * attachments the user uploaded seconds ago. Per-file OSS objects
 * (`projects/<id>/files/<name>`) are the media-generation store and take no
 * part in project sync.
 *
 * Returns 1 when an archive was pushed, 0 when skipped (no backend configured
 * or the project directory is missing/empty). An empty directory is skipped
 * on purpose: the daemon disk may not have been rehydrated from the archive
 * yet (fresh pod), and pushing an empty tar would wipe a still-valid archive.
 */
export async function syncProjectToOSS(
  projectDir: string,
  projectId: string,
): Promise<number> {
  const backendUrl = process.env.OD_BACKEND_URL;
  const daemonToken = process.env.OD_API_TOKEN;
  if (!backendUrl || !daemonToken) return 0;

  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return 0;
  }
  if (entries.length === 0) return 0;

  const chunks: Buffer[] = [];
  const stream = tarCreate(
    { gzip: true, cwd: projectDir, prefix: projectId, portable: true },
    entries,
  );
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  const body = Buffer.concat(chunks);

  const url = `${backendUrl.replace(/\/$/, '')}/api/internal/media/store-archive?projectId=${encodeURIComponent(projectId)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${daemonToken}`,
      'content-type': 'application/gzip',
    },
    body,
  });
  if (!resp.ok) {
    throw new Error(`store-archive: HTTP ${resp.status}`);
  }
  console.error(
    `[project-sync] pushed archive for project ${projectId} (${body.length} bytes, ${entries.length} top-level entries)`,
  );
  return 1;
}
