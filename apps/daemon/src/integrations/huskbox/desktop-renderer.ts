import type { DesktopRenderSlidesInput, DesktopRenderSlidesResult } from '@open-design/sidecar-proto';

import {
  executeHuskboxWorker,
  FIXED_HUSKBOX_WORKER_COMMAND,
  HUSKBOX_MAX_OUTPUT_BYTES,
  HuskboxInfrastructureError,
  HuskboxSseParser,
  readHuskboxConfig,
  type HuskboxConfig,
} from './client.js';

export type HuskboxDesktopRendererConfig = HuskboxConfig;
export const FIXED_RENDER_COMMAND = FIXED_HUSKBOX_WORKER_COMMAND;
export const readHuskboxDesktopRendererConfig = readHuskboxConfig;

type Fetch = typeof fetch;
type SlideExportFormat = 'pptx' | 'pdf' | 'image';

export type SlideRendererSource = 'desktop' | 'remote-huskbox';

const rendererSources = new WeakMap<Function, SlideRendererSource>();

export function slideRendererSource(
  renderer: ((input: DesktopRenderSlidesInput) => Promise<DesktopRenderSlidesResult>) | null | undefined,
): SlideRendererSource | null {
  if (typeof renderer !== 'function') return null;
  return rendererSources.get(renderer) ?? 'desktop';
}

/** Remote Chromium only supplies raster captures; PPTX keeps the daemon 501 fallback contract. */
export function canRenderSlideExport(
  renderer: ((input: DesktopRenderSlidesInput) => Promise<DesktopRenderSlidesResult>) | null | undefined,
  format: SlideExportFormat,
): boolean {
  return typeof renderer === 'function' && (slideRendererSource(renderer) !== 'remote-huskbox' || format !== 'pptx');
}

function resultFromValue(value: unknown): DesktopRenderSlidesResult | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  if (typeof object.ok === 'boolean' && (Array.isArray(object.slides) || typeof object.error === 'string')) {
    return object as DesktopRenderSlidesResult;
  }
  for (const key of ['result', 'data', 'output']) {
    const nested = resultFromValue(object[key]);
    if (nested) return nested;
  }
  return null;
}

export class HuskboxExecutionStreamParser {
  private readonly parser = new HuskboxSseParser(HUSKBOX_MAX_OUTPUT_BYTES);
  push(text: string): void { this.parser.push(text); }
  finish(): DesktopRenderSlidesResult {
    const output = this.parser.finish();
    for (const line of output.trim().split(/\r?\n/).reverse()) {
      try { const result = resultFromValue(JSON.parse(line)); if (result) return result; } catch { /* continue */ }
    }
    throw new Error('Huskbox execution returned no DesktopRenderSlidesResult');
  }
}

export function parseHuskboxExecutionStream(text: string): DesktopRenderSlidesResult {
  const parser = new HuskboxExecutionStreamParser();
  parser.push(text);
  return parser.finish();
}

export function selectDesktopSlideRenderer(
  desktopRenderer: ((input: DesktopRenderSlidesInput) => Promise<DesktopRenderSlidesResult>) | null | undefined,
  config: HuskboxDesktopRendererConfig | null,
  options: { daemonToken: string; fetch?: Fetch },
) {
  if (desktopRenderer) return desktopRenderer;
  if (!config || !options.daemonToken) return null;
  return createHuskboxDesktopSlideRenderer(config, options);
}

export function createHuskboxDesktopSlideRenderer(
  config: HuskboxDesktopRendererConfig,
  options: { daemonToken: string; fetch?: Fetch },
): (input: DesktopRenderSlidesInput) => Promise<DesktopRenderSlidesResult> {
  const renderer = async (input: DesktopRenderSlidesInput) => {
    const result = await executeHuskboxWorker<DesktopRenderSlidesResult>(config, {
      daemonToken: options.daemonToken,
      fetch: options.fetch,
      input: { ...input, outputDir: undefined },
    });
    if (!result.ok && result.errorCode === 'RENDER_FAILED') {
      throw new HuskboxInfrastructureError(
        'worker',
        result.error || 'Huskbox renderer worker failed',
      );
    }
    return result;
  };
  rendererSources.set(renderer, 'remote-huskbox');
  return renderer;
}
