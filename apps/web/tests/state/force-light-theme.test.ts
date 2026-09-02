// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAppearanceToDocument } from '../../src/state/appearance';
import { DEFAULT_CONFIG, loadConfig } from '../../src/state/config';
import type { AppConfig } from '../../src/types';

const STORAGE_KEY = 'open-design:config';
const store = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: vi.fn((key: string) => store.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => store.set(key, value)),
  removeItem: vi.fn((key: string) => store.delete(key)),
  clear: vi.fn(() => store.clear()),
});

function persist(config: Partial<AppConfig>): void {
  store.set(STORAGE_KEY, JSON.stringify(config));
}

describe('theme preference — persisted config', () => {
  beforeEach(() => store.clear());

  it('defaults a fresh install to the system theme', () => {
    expect(DEFAULT_CONFIG.theme).toBe('system');
    expect(loadConfig().theme).toBe('system');
  });

  it('preserves a persisted dark theme and unrelated appearance settings', () => {
    persist({ theme: 'dark', accentColor: '#4F46E5' });
    const config = loadConfig();
    expect(config.theme).toBe('dark');
    expect(config.accentColor).toBe('#4f46e5');
  });

  it('falls back to system for an invalid persisted theme', () => {
    persist({ theme: 'unsupported' as AppConfig['theme'] });
    expect(loadConfig().theme).toBe('system');
  });
});

describe('theme preference — document', () => {
  afterEach(() => document.documentElement.removeAttribute('data-theme'));

  it('stamps an explicit dark theme on the root element', () => {
    applyAppearanceToDocument({ theme: 'dark', accentColor: '#059669' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves system mode to prefers-color-scheme', () => {
    document.documentElement.setAttribute('data-theme', 'dark');
    applyAppearanceToDocument({ theme: 'system', accentColor: '#059669' });
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

describe('theme preference — pre-hydration script', () => {
  const layoutPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../app/layout.tsx');

  function runThemeInitScript(): void {
    const source = readFileSync(layoutPath, 'utf8');
    const match = /const themeInitScript = `([^`]*)`;/.exec(source);
    if (!match?.[1]) throw new Error('themeInitScript not found in app/layout.tsx');
    // eslint-disable-next-line no-new-func
    new Function(match[1])();
  }

  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    store.clear();
  });

  it('paints a saved dark preference before hydration', () => {
    persist({ theme: 'dark' });
    runThemeInitScript();
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('keeps system mode attribute-free before hydration', () => {
    document.documentElement.setAttribute('data-theme', 'light');
    persist({ theme: 'system' });
    runThemeInitScript();
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});
