export interface OhMyInspireCatalogTemplate {
  id: string;
  name: string;
  localizedName?: { en?: string; zh?: string };
  description: string;
  localizedDescription?: { en?: string; zh?: string };
  mode?: string;
  category?: string;
  preview_type?: string;
  preview_url?: string;
}

export interface OhMyInspireCatalogTemplateDetail extends OhMyInspireCatalogTemplate {
  download_url?: string;
}

type CatalogEnvelope<T> = {
  code?: number | string;
  message?: unknown;
  data?: T;
};

export class OhMyInspireCatalogError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'OhMyInspireCatalogError';
  }
}

function catalogData<T>(payload: CatalogEnvelope<T> | T): T {
  if (payload && typeof payload === 'object' && 'code' in payload) {
    const envelope = payload as CatalogEnvelope<T>;
    if (envelope.code !== undefined && envelope.code !== 0 && envelope.code !== '0') {
      throw new Error(typeof envelope.message === 'string' ? envelope.message : 'OhMyInspire catalog request failed.');
    }
    if (envelope.data !== undefined) return envelope.data;
  }
  return payload as T;
}

async function requestCatalog<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/v1/catalog${path}`, {
    credentials: 'include',
    ...(signal ? { signal } : {}),
  });
  const payload = await response.json() as CatalogEnvelope<T> | T;
  if (!response.ok) {
    const envelope = payload as CatalogEnvelope<T>;
    throw new Error(typeof envelope.message === 'string' ? envelope.message : response.statusText || 'OhMyInspire catalog request failed.');
  }
  return catalogData(payload);
}

export async function fetchOhMyInspireTemplates(signal?: AbortSignal): Promise<OhMyInspireCatalogTemplate[]> {
  const page = await requestCatalog<{ items?: OhMyInspireCatalogTemplate[] }>(
    '/templates?mode=all&page=1&page_size=20',
    signal,
  );
  return Array.isArray(page.items) ? page.items : [];
}

export function fetchOhMyInspireTemplateDetail(
  id: string,
  signal?: AbortSignal,
): Promise<OhMyInspireCatalogTemplateDetail> {
  return requestCatalog<OhMyInspireCatalogTemplateDetail>(
    `/templates/${encodeURIComponent(id)}`,
    signal,
  );
}

export async function downloadOhMyInspireTemplate(
  id: string,
  confirmCharge = false,
): Promise<Blob> {
  const response = await fetch(
    `/api/v1/catalog/templates/${encodeURIComponent(id)}/download`,
    {
      credentials: 'include',
      headers: confirmCharge ? { 'X-Confirm-Template-Charge': '1' } : undefined,
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as CatalogEnvelope<unknown> | null;
    throw new OhMyInspireCatalogError(
      typeof payload?.message === 'string'
        ? payload.message
        : response.statusText || 'OhMyInspire template download failed.',
      payload?.code === undefined ? undefined : String(payload.code),
      response.status,
    );
  }
  return response.blob();
}

export function ohMyInspireCatalogPreviewUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed || !trimmed.startsWith('/api/v1/catalog/')) return null;
  return trimmed;
}

export function ohMyInspireTemplateTitle(template: OhMyInspireCatalogTemplate, locale: string): string {
  if (locale.startsWith('zh')) return template.localizedName?.zh?.trim() || template.name;
  return template.localizedName?.en?.trim() || template.name;
}

export function ohMyInspireTemplateDescription(template: OhMyInspireCatalogTemplate, locale: string): string {
  if (locale.startsWith('zh')) return template.localizedDescription?.zh?.trim() || template.description;
  return template.localizedDescription?.en?.trim() || template.description;
}

export function isOhMyInspireHandoffUrl(value: string | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
      && /\/api\/v1\/catalog\/handoff-download\/[^/]+$/.test(url.pathname);
  } catch {
    return false;
  }
}
