import type { ResearchSource } from '@open-design/contracts/api/research';
import type { FetchLike } from './net.js';

const SEARCH_ENDPOINT = 'https://www.pinterest.com/resource/BaseSearchResource/get/';
const HOME_URL = 'https://www.pinterest.com';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEFAULT_TIMEOUT_MS = 30_000;
const PINTEREST_MAX_PAGE_SIZE = 50;
const RATE_LIMIT_MS = 60_000;
const PINTEREST_IMAGE_HOST_RE = /(^|\.)pinimg\.com$/i;

let lastCallMs = 0;

export class PinterestError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'PinterestError';
  }
}

export interface PinterestSearchInput {
  query: string;
  maxResults?: number;
  /** Injected fetch. Owns proxy routing (direct-first + fallback); defaults to
   *  the global direct fetch. */
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

export interface PinterestSearchOutput {
  sources: ResearchSource[];
}

interface PinterestRawPin {
  id?: unknown;
  images?: { orig?: { url?: string; width?: number; height?: number } };
  auto_alt_text?: string;
}

interface PinterestRawResponse {
  resource_response?: {
    data?: { results?: unknown[] };
  };
}

async function bootstrapCookies(
  doFetch: FetchLike,
  signal?: AbortSignal,
): Promise<string> {
  const resp = await doFetch(HOME_URL, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT },
    redirect: 'manual',
    signal: signal ?? null,
  });
  const setCookies = resp.headers.getSetCookie?.() ?? [];
  return setCookies
    .map((c) => c.split(';')[0]!)
    .filter(Boolean)
    .join('; ');
}

function buildSearchUrl(query: string, pageSize: number): string {
  const sourceUrl = `/search/pins/?q=${encodeURIComponent(query)}&rs=typed`;
  const options = {
    appliedProductFilters: '---',
    auto_correction_disabled: false,
    bookmarks: [] as string[],
    page_size: pageSize,
    query,
    redux_normalize_feed: true,
    rs: 'typed',
    scope: 'pins',
    source_url: sourceUrl,
  };
  const data = JSON.stringify({ options, context: {} });
  const params = new URLSearchParams({
    source_url: sourceUrl,
    data,
    _: String(Date.now()),
  });
  return `${SEARCH_ENDPOINT}?${params.toString().replace(/\+/g, '%20')}`;
}

function parsePins(raw: PinterestRawResponse, maxResults: number): ResearchSource[] {
  const results = raw?.resource_response?.data?.results;
  if (!Array.isArray(results)) return [];

  const sources: ResearchSource[] = [];
  for (const item of results as PinterestRawPin[]) {
    if (sources.length >= maxResults) break;
    const orig = item?.images?.orig;
    const rawSrc = typeof orig?.url === 'string' ? orig.url : '';
    // Provider data is untrusted. Agents commonly download imageUrl, so only
    // expose Pinterest's HTTPS CDN and never create an SSRF primitive.
    let src = '';
    try {
      const parsed = new URL(rawSrc);
      if (parsed.protocol === 'https:' && PINTEREST_IMAGE_HOST_RE.test(parsed.hostname)) src = parsed.href;
    } catch {
      // Invalid/non-absolute URLs are ignored.
    }
    if (!src) continue;

    const pinId = item.id != null ? String(item.id) : '';
    const url = pinId
      ? `https://www.pinterest.com/pin/${pinId}/`
      : src;
    const alt = typeof item.auto_alt_text === 'string' ? item.auto_alt_text.trim() : '';
    const width = typeof orig?.width === 'number' ? orig.width : 0;
    const height = typeof orig?.height === 'number' ? orig.height : 0;

    sources.push({
      title: alt || `Pinterest Pin ${pinId}`,
      url,
      snippet: alt,
      provider: 'pinterest',
      ...(src ? { imageUrl: src } : {}),
      ...((width && height) ? { resolution: [width, height] } : {}),
    });
  }
  return sources;
}

export async function pinterestSearch(
  input: PinterestSearchInput,
): Promise<PinterestSearchOutput> {
  const now = Date.now();
  if (now - lastCallMs < RATE_LIMIT_MS) {
    const waitSec = Math.ceil((RATE_LIMIT_MS - (now - lastCallMs)) / 1000);
    throw new PinterestError(
      `Pinterest rate limit: please wait ${waitSec}s before the next search`,
      429,
    );
  }
  if (!input.query?.trim()) {
    throw new PinterestError('query is required');
  }
  const query = input.query.trim();
  const maxResults = Math.max(1, Math.min(input.maxResults ?? 10, PINTEREST_MAX_PAGE_SIZE));
  const doFetch: FetchLike = input.fetchImpl ?? ((url, init) => fetch(url, init));

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  const onCallerAbort = () => ctrl.abort();
  if (input.signal) {
    input.signal.addEventListener('abort', onCallerAbort, { once: true });
  }
  let resp: Response;
  try {
    const cookies = await bootstrapCookies(doFetch, ctrl.signal);

    const searchUrl = buildSearchUrl(query, maxResults);
    resp = await doFetch(searchUrl, {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        'x-pinterest-pws-handler': 'www/pin/[id].js',
        ...(cookies ? { cookie: cookies } : {}),
      },
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new PinterestError(
      `Pinterest request failed: ${(err as Error).message || String(err)}`,
    );
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', onCallerAbort);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new PinterestError(
      `Pinterest ${resp.status}: ${text.slice(0, 200) || 'no body'}`,
      resp.status,
    );
  }

  const json = (await resp.json()) as PinterestRawResponse;
  const sources = parsePins(json, maxResults);
  lastCallMs = Date.now();
  return { sources };
}
