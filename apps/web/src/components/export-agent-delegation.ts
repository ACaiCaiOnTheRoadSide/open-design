import type { ImageExportFormat } from '../runtime/exports';

export const DELEGATED_EXPORT = 'delegated' as const;
export type DelegatedExportResult = typeof DELEGATED_EXPORT;

export interface PptxAgentExportRequest {
  fileName: string;
  title?: string;
  editable: boolean;
}

export interface ImageAgentExportRequest {
  fileName: string;
  title?: string;
  format: ImageExportFormat;
}

export interface PdfAgentExportRequest {
  fileName: string;
  title?: string;
  deck: boolean;
}

function safeArtifactBase(title: string | undefined, fileName: string): string {
  const candidate = title?.trim() || fileName.split('/').pop() || 'export';
  const withoutExtension = candidate.replace(/\.(?:html?|pptx|pdf|png|jpe?g|webp)$/i, '');
  const safe = withoutExtension
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return safe || 'export';
}

function quoted(value: string): string {
  return JSON.stringify(value);
}

function hasCjk(value: string): boolean {
  return /[\u3400-\u9fff]/u.test(value);
}

export function buildPptxAgentExport(request: PptxAgentExportRequest): {
  outputName: string;
  prompt: string;
  skillIds: string[];
} {
  const base = safeArtifactBase(request.title, request.fileName);
  const marker = request.editable
    ? (hasCjk(base) ? '可编辑版' : 'editable')
    : (hasCjk(base) ? '截图版' : 'screenshot');
  const outputName = `${base}-${marker}.pptx`;
  const mode = request.editable ? '--editable' : 'screenshot';
  return {
    outputName,
    skillIds: ['html-to-pptx'],
    prompt:
      `Export the existing HTML deck ${quoted(request.fileName)} with the html-to-pptx skill in ${mode} mode. ` +
      "Follow the skill exactly. Prepare Chromium only with the skill's bundled scripts/setup-env.sh; " +
      'do not improvise npm, apk, Playwright, or browser installation. ' +
      `Write the result inside the project directory with the exact safe filename ${quoted(outputName)}. ` +
      'An older export or a file from the other mode does not satisfy this request: render it again. ' +
      'Report the exact output filename and slide count only after the file exists and is non-empty. ' +
      'On failure, report the actual error and do not claim success or create a substitute artifact.',
  };
}

export function buildImageAgentExport(request: ImageAgentExportRequest): {
  outputName: string;
  prompt: string;
  skillIds: string[];
} {
  const base = safeArtifactBase(request.title, request.fileName);
  const extension = request.format === 'jpeg' ? 'jpg' : request.format;
  const marker = hasCjk(base) ? '整页图' : 'full-page';
  const outputName = `${base}-${marker}.${extension}`;
  return {
    outputName,
    skillIds: ['html-to-image'],
    prompt:
      `Export the existing HTML artifact ${quoted(request.fileName)} with the html-to-image skill as ${request.format}. ` +
      "Follow the skill exactly. Prepare Chromium only with the skill's bundled scripts/setup-env.sh; " +
      'do not improvise npm, apk, Playwright, or browser installation. ' +
      `Write the result inside the project directory with the exact safe filename ${quoted(outputName)}. ` +
      'Capture the whole scrollable page; for a deck stitch every slide, never only the viewport. ' +
      'Render again even if an older image or another format exists. ' +
      'Report the exact output filename and dimensions only after the file exists and is non-empty. ' +
      'On failure, report the actual error and do not claim success or create a substitute artifact.',
  };
}

export function buildPdfAgentExport(request: PdfAgentExportRequest): {
  outputName: string;
  prompt: string;
  skillIds: string[];
} {
  const base = safeArtifactBase(request.title, request.fileName);
  const outputName = `${base}.pdf`;
  return {
    outputName,
    skillIds: ['html-to-image'],
    prompt:
      `Export the existing HTML artifact ${quoted(request.fileName)} with the html-to-image skill as PDF. ` +
      "Follow the skill exactly. Prepare Chromium only with the skill's bundled scripts/setup-env.sh; " +
      'do not improvise npm, apk, Playwright, or browser installation. ' +
      `Write the result inside the project directory with the exact safe filename ${quoted(outputName)}. ` +
      (request.deck
        ? 'Preserve every slide as its own PDF page. '
        : 'Preserve the complete scrollable page, not only the visible viewport. ') +
      'Report the exact output filename and page count only after the file exists and is non-empty. ' +
      'On failure, report the actual error and do not claim success or create a substitute artifact.',
  };
}
