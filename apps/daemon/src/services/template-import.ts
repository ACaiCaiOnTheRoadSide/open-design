import { safeExternalFetch } from '../plugins/plugin-asset-cache.js';
import { parseFrontmatter } from '../design-systems/frontmatter.js';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ENTRIES = 10_000;
const HANDOFF_PATH_RE = /\/api\/v1\/catalog\/handoff-download\/[^/]+$/;

export interface TemplateArchiveFile {
  name: string;
  content: Buffer;
}

export interface PreparedTemplateArchive {
  files: TemplateArchiveFile[];
  templateId: string | null;
  title: string | null;
  prompt: string | null;
  skillPath: string | null;
}

const CATALOG_PREVIEW_PATH_RE = /^(?:preview\.(?:gif|jpe?g|mp4|png|webp)|previews\/)/i;

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function composeTemplateSkillInstructions(
  existingSkillBody: string | null | undefined,
  skillMarkdown: string,
  title?: string | null,
): string | undefined {
  const instructions = parseFrontmatter(skillMarkdown).body.trim();
  if (!instructions) return existingSkillBody?.trim() || undefined;
  const existing = existingSkillBody?.trim() ?? '';
  const heading = `## Selected template instructions${title?.trim() ? ` — ${title.trim()}` : ''}`;
  return `${existing}${existing ? '\n\n---\n\n' : ''}${heading}\n\n${instructions}`;
}

export function prepareTemplateArchive(
  archiveFiles: TemplateArchiveFile[],
): PreparedTemplateArchive {
  const metadataFile = archiveFiles.find((file) => file.name === 'template.json');
  let metadata: Record<string, unknown> = {};
  if (metadataFile) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(metadataFile.content.toString('utf8'));
    } catch {
      throw new Error('template archive contains invalid template.json');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('template archive contains invalid template.json');
    }
    metadata = parsed as Record<string, unknown>;
  }

  const skillFile = archiveFiles.find((file) => file.name === 'SKILL.md');
  const skillMetadata = skillFile
    ? parseFrontmatter(skillFile.content.toString('utf8')).data
    : {};
  const files = archiveFiles.filter(
    (file) => file.name !== 'template.json' && !CATALOG_PREVIEW_PATH_RE.test(file.name),
  );
  return {
    files,
    templateId: nonEmptyString(metadata.id) ?? nonEmptyString(skillMetadata.name),
    title: nonEmptyString(metadata.title)
      ?? nonEmptyString(metadata.name)
      ?? nonEmptyString(skillMetadata.title)
      ?? nonEmptyString(skillMetadata.name),
    prompt: nonEmptyString(metadata.prompt) ?? nonEmptyString(metadata.examplePrompt),
    skillPath: skillFile ? skillFile.name : null,
  };
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

function isSafeArchivePath(rawPath: string): boolean {
  if (!rawPath || rawPath.includes('\0')) return false;
  const normalized = rawPath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split('/').some((segment) => segment === '..');
}

function openZip(archive: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(
      archive,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error('could not open template ZIP'));
        else resolve(zip);
      },
    );
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | null> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(null);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function openEntryStream(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error('could not read template ZIP entry'));
      else resolve(stream);
    });
  });
}

async function readZipFiles(archive: Buffer): Promise<TemplateArchiveFile[]> {
  const zip = await openZip(archive);
  const files: TemplateArchiveFile[] = [];
  let entries = 0;
  let totalBytes = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      entries += 1;
      if (entries > MAX_ARCHIVE_ENTRIES) {
        throw new Error(`template archive contains more than ${MAX_ARCHIVE_ENTRIES} entries`);
      }
      if (!isSafeArchivePath(entry.fileName)) {
        throw new Error('template archive contains an unsafe path');
      }
      const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
      if (unixType === 0o120000) {
        throw new Error('template archive contains a symbolic link');
      }
      const isDirectory = entry.fileName.endsWith('/')
        || unixType === 0o040000
        || (entry.externalFileAttributes & 0x10) !== 0;
      if (isDirectory) continue;
      if (entry.uncompressedSize > MAX_ARCHIVE_BYTES - totalBytes) {
        throw new Error('extracted template archive exceeds 50 MiB');
      }

      const chunks: Buffer[] = [];
      const stream = await openEntryStream(zip, entry);
      for await (const rawChunk of stream) {
        const chunk = Buffer.from(rawChunk);
        totalBytes += chunk.length;
        if (totalBytes > MAX_ARCHIVE_BYTES) {
          throw new Error('extracted template archive exceeds 50 MiB');
        }
        chunks.push(chunk);
      }
      files.push({ name: entry.fileName, content: Buffer.concat(chunks) });
    }
  } finally {
    zip.close();
  }
  if (files.length === 0) throw new Error('template archive contains no files');
  return files;
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
  return readZipFiles(Buffer.concat(chunks));
}
