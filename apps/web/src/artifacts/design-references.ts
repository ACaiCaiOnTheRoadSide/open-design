/**
 * Parser for inline <design-references>...</design-references> blocks the
 * agent emits to show the user a grid of design reference images found via
 * web search. The user clicks one to select it as the visual direction.
 *
 * Body must be JSON with an `items` array. Example:
 *
 *   <design-references>
 *   {
 *     "items": [
 *       { "id": "ref_1", "title": "Minimal cards", "image": "/api/artifacts/.../ref1.png",
 *         "description": "White bg, large spacing, rounded cards" }
 *     ]
 *   }
 *   </design-references>
 */

export interface DesignReferenceItem {
  id: string;
  title: string;
  image: string;
  description?: string;
}

export interface DesignReferences {
  items: DesignReferenceItem[];
  pageSize?: number;
}

export type DesignRefSegment =
  | { kind: 'text'; text: string }
  | { kind: 'design-references'; refs: DesignReferences; raw: string };

const OPEN_RE = /<design-references\b[^>]*>/i;
const CLOSE_TAG = '</design-references>';

export function splitOnDesignReferences(input: string): DesignRefSegment[] {
  const out: DesignRefSegment[] = [];
  let cursor = 0;
  while (cursor < input.length) {
    const slice = input.slice(cursor);
    const m = OPEN_RE.exec(slice);
    if (!m) {
      out.push({ kind: 'text', text: slice });
      break;
    }
    const openStart = cursor + m.index;
    const openEnd = openStart + m[0].length;
    const closeIdx = findCloseTag(input, openEnd);
    if (closeIdx === -1) {
      out.push({ kind: 'text', text: slice });
      break;
    }
    if (openStart > cursor) {
      out.push({ kind: 'text', text: input.slice(cursor, openStart) });
    }
    const body = input.slice(openEnd, closeIdx);
    const refs = tryParseRefs(body);
    const blockEnd = closeIdx + CLOSE_TAG.length;
    if (refs) {
      out.push({ kind: 'design-references', refs, raw: input.slice(openStart, blockEnd) });
    } else {
      out.push({ kind: 'text', text: input.slice(openStart, blockEnd) });
    }
    cursor = blockEnd;
  }
  return out;
}

export function stripTrailingOpenDesignReferences(
  input: string,
): { text: string; hadOpenBlock: boolean } {
  let cursor = 0;
  while (cursor < input.length) {
    const slice = input.slice(cursor);
    const m = OPEN_RE.exec(slice);
    if (!m) break;
    const openStart = cursor + m.index;
    const openEnd = openStart + m[0].length;
    const closeIdx = findCloseTag(input, openEnd);
    if (closeIdx === -1) {
      return { text: input.slice(0, openStart), hadOpenBlock: true };
    }
    cursor = closeIdx + CLOSE_TAG.length;
  }
  return { text: input, hadOpenBlock: false };
}

function findCloseTag(input: string, from: number): number {
  const lower = CLOSE_TAG.toLowerCase();
  const len = CLOSE_TAG.length;
  const max = input.length - len;
  for (let i = from; i <= max; i++) {
    if (input.slice(i, i + len).toLowerCase() === lower) return i;
  }
  return -1;
}

function tryParseRefs(body: string): DesignReferences | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  const stripped = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  let data: unknown;
  try {
    data = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  const rawItems = Array.isArray(obj.items) ? obj.items : null;
  if (!rawItems || rawItems.length === 0) return null;
  const items: DesignReferenceItem[] = [];
  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const image = typeof item.image === 'string' ? item.image.trim() : '';
    if (!id || !title || !image) continue;
    const description = typeof item.description === 'string' ? item.description.trim() : undefined;
    items.push({ id, title, image, ...(description ? { description } : {}) });
  }
  if (items.length === 0) return null;
  const pageSize = typeof obj.pageSize === 'number' && obj.pageSize > 0 ? obj.pageSize : undefined;
  return { items, ...(pageSize ? { pageSize } : {}) };
}

export function formatDesignReferenceSelection(item: DesignReferenceItem): string {
  return `[design reference selected — ${item.id} — ${item.title}]`;
}

export const DESIGN_REF_SELECTION_RE = /\[design reference selected — ([^—]+?) — /;
