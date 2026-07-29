import { writeFile } from 'node:fs/promises';
import { apiTokenFromEnv } from '../../api-token-auth.js';
import { executeHuskboxWorker, readHuskboxConfig, type HuskboxConfig } from './client.js';
import type { BrandBrowserResult } from './desktop-render-worker.js';

export interface HuskboxBrandBrowserOptions {
  config?: HuskboxConfig | null;
  daemonToken?: string;
  fetch?: typeof fetch;
}

export function validBrandBrowserUrl(value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; }
}

function context(options: HuskboxBrandBrowserOptions): { config: HuskboxConfig; daemonToken: string } | null {
  const config = options.config === undefined ? readHuskboxConfig() : options.config;
  const daemonToken = options.daemonToken === undefined ? apiTokenFromEnv() : options.daemonToken;
  return config && daemonToken ? { config, daemonToken } : null;
}

/** Whether a brand render can actually be submitted without doing network I/O. */
export function hasHuskboxBrandBrowserContext(options: HuskboxBrandBrowserOptions = {}): boolean {
  return context(options) !== null;
}

export async function huskboxBrandDumpDom(url: string, options: HuskboxBrandBrowserOptions = {}): Promise<string | null> {
  if (!validBrandBrowserUrl(url)) return null;
  const ctx = context(options);
  if (!ctx) return null;
  const result = await executeHuskboxWorker<BrandBrowserResult>(ctx.config, {
    daemonToken: ctx.daemonToken, fetch: options.fetch, input: { kind: 'dump-dom', url }, maxOutputBytes: 4 * 1024 * 1024,
  });
  return result.ok && result.kind === 'dump-dom' ? result.html : null;
}

export async function huskboxBrandScreenshot(url: string, outPath: string, options: HuskboxBrandBrowserOptions = {}): Promise<boolean> {
  if (!validBrandBrowserUrl(url)) return false;
  const ctx = context(options);
  if (!ctx) return false;
  const result = await executeHuskboxWorker<BrandBrowserResult>(ctx.config, {
    daemonToken: ctx.daemonToken, fetch: options.fetch, input: { kind: 'screenshot', url }, maxOutputBytes: 14 * 1024 * 1024,
  });
  if (!result.ok || result.kind !== 'screenshot' || result.bytes > 10 * 1024 * 1024) return false;
  const bytes = Buffer.from(result.data, 'base64');
  if (bytes.length !== result.bytes || bytes.length > 10 * 1024 * 1024) return false;
  await writeFile(outPath, bytes);
  return true;
}
