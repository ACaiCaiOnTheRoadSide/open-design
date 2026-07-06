import * as fs from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

interface OSSObjectMeta {
  key: string;
  size: number;
  etag: string;
}

async function listOSSObjects(
  backendUrl: string,
  daemonToken: string,
  projectId: string,
): Promise<OSSObjectMeta[]> {
  const prefix = `projects/${projectId}/files/`;
  const url = `${backendUrl.replace(/\/$/, '')}/api/internal/media/list?prefix=${encodeURIComponent(prefix)}`;
  const resp = await fetch(url, {
    headers: { authorization: `Bearer ${daemonToken}` },
  });
  if (!resp.ok) return [];
  const body = (await resp.json()) as { objects?: OSSObjectMeta[] };
  return body.objects ?? [];
}

async function walkProjectFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkProjectFiles(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

export async function syncProjectToOSS(
  projectDir: string,
  projectId: string,
): Promise<number> {
  const backendUrl = process.env.OD_BACKEND_URL;
  const daemonToken = process.env.OD_API_TOKEN;
  if (!backendUrl || !daemonToken) return 0;

  const ossObjects = await listOSSObjects(backendUrl, daemonToken, projectId);
  const ossByName = new Map<string, OSSObjectMeta>();
  const prefix = `projects/${projectId}/files/`;
  for (const obj of ossObjects) {
    const name = obj.key.startsWith(prefix) ? obj.key.slice(prefix.length) : obj.key;
    ossByName.set(name, obj);
  }

  const localFiles = await walkProjectFiles(projectDir);
  let uploaded = 0;

  for (const absPath of localFiles) {
    const relativePath = path.relative(projectDir, absPath);
    const fileStat = await stat(absPath);
    const ossObj = ossByName.get(relativePath);
    if (ossObj && ossObj.size === fileStat.size) continue;

    try {
      const fileBytes = await readFile(absPath);
      const filename = relativePath;
      const form = new FormData();
      form.append('projectId', projectId);
      form.append('filename', filename);
      form.append('file', new Blob([fileBytes]), filename);
      const resp = await fetch(
        `${backendUrl.replace(/\/$/, '')}/api/internal/media/store`,
        { method: 'POST', headers: { authorization: `Bearer ${daemonToken}` }, body: form },
      );
      if (resp.ok) uploaded++;
    } catch (err: any) {
      console.error(`[project-sync] upload "${relativePath}" failed: ${err?.message || err}`);
    }
  }

  if (uploaded > 0) {
    console.error(`[project-sync] uploaded ${uploaded} file(s) for project ${projectId}`);
  }
  return uploaded;
}

export async function syncProjectFromOSS(
  projectDir: string,
  projectId: string,
): Promise<number> {
  const backendUrl = process.env.OD_BACKEND_URL;
  const daemonToken = process.env.OD_API_TOKEN;
  if (!backendUrl || !daemonToken) return 0;

  const ossObjects = await listOSSObjects(backendUrl, daemonToken, projectId);
  const prefix = `projects/${projectId}/files/`;
  let downloaded = 0;

  for (const obj of ossObjects) {
    const relativePath = obj.key.startsWith(prefix) ? obj.key.slice(prefix.length) : obj.key;
    if (!relativePath || relativePath.includes('..')) continue;

    const absPath = path.join(projectDir, relativePath);
    try {
      const fileStat = await stat(absPath);
      if (fileStat.size === obj.size) continue;
    } catch {
      // File doesn't exist locally — need to download.
    }

    try {
      const fetchUrl = `${backendUrl.replace(/\/$/, '')}/api/internal/media/fetch?key=${encodeURIComponent(obj.key)}`;
      const resp = await fetch(fetchUrl, {
        headers: { authorization: `Bearer ${daemonToken}` },
      });
      if (!resp.ok) continue;
      const bytes = Buffer.from(await resp.arrayBuffer());
      await mkdir(path.dirname(absPath), { recursive: true });
      await writeFile(absPath, bytes);
      downloaded++;
    } catch (err: any) {
      console.error(`[project-sync] download "${relativePath}" failed: ${err?.message || err}`);
    }
  }

  if (downloaded > 0) {
    console.error(`[project-sync] downloaded ${downloaded} file(s) for project ${projectId}`);
  }
  return downloaded;
}
