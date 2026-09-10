export interface OhMyInspireCatalogTemplate {
  id: string;
  name: string;
  localizedName?: { en?: string; zh?: string };
  description: string;
  localizedDescription?: { en?: string; zh?: string };
  mode?: string;
  category?: string;
  preview?: { type?: string; path?: string };
  preview_type?: string;
  preview_url?: string;
  card_preview?: {
    type: 'image' | 'video';
    poster_url: string;
    video_url?: string;
    width: number;
    height: number;
  };
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

interface OhMyInspireCatalogPage {
  items?: OhMyInspireCatalogTemplate[];
  total_pages?: number;
}

export async function fetchOhMyInspireTemplates(signal?: AbortSignal): Promise<OhMyInspireCatalogTemplate[]> {
  const page = await requestCatalog<OhMyInspireCatalogPage>(
    '/templates?mode=all&page=1&page_size=20',
    signal,
  );
  return Array.isArray(page.items) ? page.items : [];
}

export async function fetchAllOhMyInspireTemplates(signal?: AbortSignal): Promise<OhMyInspireCatalogTemplate[]> {
  const pageSize = 100;
  const firstPage = await requestCatalog<OhMyInspireCatalogPage>(
    `/templates?mode=all&page=1&page_size=${pageSize}`,
    signal,
  );
  if (!Array.isArray(firstPage.items)) {
    throw new Error('OhMyInspire catalog response is missing items.');
  }
  const totalPages = Math.max(1, Math.min(50, Math.trunc(firstPage.total_pages ?? 1)));
  const remainingPages = await Promise.all(
    Array.from({ length: totalPages - 1 }, (_, index) => requestCatalog<OhMyInspireCatalogPage>(
      `/templates?mode=all&page=${index + 2}&page_size=${pageSize}`,
      signal,
    )),
  );
  return [firstPage, ...remainingPages].flatMap((page) => (
    Array.isArray(page.items) ? page.items : []
  ));
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
  if (!trimmed) return null;
  if (trimmed.startsWith('/api/v1/catalog/')) return trimmed;
  if (trimmed.startsWith('/openapi/v1/catalog/')) {
    return `/api/v1/catalog/${trimmed.slice('/openapi/v1/catalog/'.length)}`;
  }
  if (/^\/gpt-image-2\/[A-Za-z0-9._-]+\.webp$/.test(trimmed)) {
    return `/api/v1/catalog/raw-preview${trimmed}`;
  }
  return null;
}

export function ohMyInspirePreviewMayAnimate(template: OhMyInspireCatalogTemplate): boolean {
  const type = (template.preview?.type ?? template.preview_type ?? '').trim().toLowerCase();
  if (['gif', 'webp', 'image/gif', 'image/webp'].includes(type)) return true;
  return [template.preview?.path, template.preview_url].some((value) => {
    const path = value?.split(/[?#]/, 1)[0]?.toLowerCase() ?? '';
    return /\.(?:gif|webp)$/.test(path);
  });
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
