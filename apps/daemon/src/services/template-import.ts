import { lstat, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { safeExternalFetch } from '../plugins/plugin-asset-cache.js';
import { extractPluginZipToFolder } from './plugin-installation.js';

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const HANDOFF_PATH_RE = /\/api\/v1\/catalog\/handoff-download\/[^/]+$/;

export interface TemplateArchiveFile {
  name: string;
  content: Buffer;
}

export function isTemplateHandoffUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && HANDOFF_PATH_RE.test(url.pathname);
  } catch {
    return false;
  }
}

export async function downloadTemplateArchive(
  rawUrl: string,
  fetcher: (url: string) => Promise<Response> = safeExternalFetch,
): Promise<TemplateArchiveFile[]> {
  if (!isTemplateHandoffUrl(rawUrl)) {
    throw new Error('template source must be a fixed HTTPS handoff URL');
  }
  const response = await fetcher(rawUrl);
  if (!response.ok || !response.body) {
    throw new Error(`template download failed: ${response.status} ${response.statusText}`.trim());
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error('template archive exceeds 50 MiB');
    }
    chunks.push(chunk);
  }

  const archive = Buffer.concat(chunks);
  const extractRoot = await mkdtemp(path.join(os.tmpdir(), 'od-template-import-'));
  try {
    await extractPluginZipToFolder(archive, extractRoot, MAX_ARCHIVE_BYTES);
    const files: TemplateArchiveFile[] = [];
    async function collect(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const target = path.join(dir, entry.name);
        const stats = await lstat(target);
        if (stats.isSymbolicLink()) throw new Error('template archive contains a symbolic link');
        if (stats.isDirectory()) {
          await collect(target);
          continue;
        }
        if (!stats.isFile()) throw new Error('template archive contains an unsupported entry');
        files.push({
          name: path.relative(extractRoot, target).split(path.sep).join('/'),
          content: await readFile(target),
        });
        if (files.length > MAX_ARCHIVE_ENTRIES) {
          throw new Error(`template archive contains more than ${MAX_ARCHIVE_ENTRIES} files`);
        }
      }
    }
    await collect(extractRoot);
    if (files.length === 0) throw new Error('template archive contains no files');
    return files;
  } finally {
    await rm(extractRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}
