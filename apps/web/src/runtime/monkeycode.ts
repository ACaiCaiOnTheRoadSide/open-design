const DEFAULT_BASE_URL = 'https://monkeycode-ai.com';
export const MONKEYCODE_TASK_CONTENT_MAX = 10_000;
const MONKEYCODE_TASK_URL_MAX = 100_000;

let baseUrl: string | null = null;
let configPromise: Promise<void> | null = null;

function validBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Load environment-specific handoff address from the hosted backend. */
export function ensureSiteConfig(): Promise<void> {
  if (configPromise) return configPromise;
  configPromise = fetch('/api/v1/site-config', { credentials: 'same-origin' })
    .then(async (response) => {
      if (!response.ok) return;
      const payload = await response.json() as { data?: { monkeycode_url?: unknown } };
      baseUrl = validBaseUrl(payload.data?.monkeycode_url);
    })
    .catch(() => undefined);
  return configPromise;
}

export function buildMonkeycodeTaskUrl(prompt: string): string | null {
  const tasksUrl = `${baseUrl ?? DEFAULT_BASE_URL}/console/tasks`;
  const bytes = new TextEncoder().encode(prompt);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const url = `${tasksUrl}#od-task=${encoded}`;
  return url.length <= MONKEYCODE_TASK_URL_MAX ? url : null;
}

export async function uploadProjectArchiveToOss(projectId: string, filePath: string): Promise<string> {
  const parts = filePath.split('/').filter(Boolean);
  const root = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const response = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/archive/upload-oss${root ? `?root=${encodeURIComponent(root)}` : ''}`,
    { method: 'POST' },
  );
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200);
    throw new Error(`upload-oss failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const payload = await response.json() as { url?: string };
  if (!payload.url) throw new Error('upload-oss response has no url');
  return payload.url;
}
