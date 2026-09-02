import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokensCss = readFileSync(
  new URL('../../src/styles/tokens.css', import.meta.url),
  'utf8',
);
const homeHeroCss = readFileSync(
  new URL('../../src/styles/home/home-hero.css', import.meta.url),
  'utf8',
);
const chatCss = readFileSync(
  new URL('../../src/styles/chat.css', import.meta.url),
  'utf8',
);

function cssBlock(source: string, selector: string, from = 0): string {
  const start = source.indexOf(selector, from);
  if (start < 0) throw new Error(`Missing CSS selector ${selector}`);
  const open = source.indexOf('{', start + selector.length);
  let depth = 1;
  for (let index = open + 1; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(open + 1, index);
  }
  throw new Error(`Unclosed CSS block ${selector}`);
}

function cssVar(block: string, name: string): string {
  const value = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6});`).exec(block)?.[1];
  if (!value) throw new Error(`Missing CSS variable ${name}`);
  return value;
}

function relativeLuminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/g)!.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045
      ? value / 12.92
      : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('dark text hierarchy', () => {
  it('keeps secondary text readable on dark panels in explicit and system themes', () => {
    const explicitDark = cssBlock(tokensCss, '[data-theme="dark"]');
    const systemDark = cssBlock(tokensCss, 'html:not([data-theme])');
    const panel = cssVar(explicitDark, '--bg-panel');

    for (const token of ['--text-soft', '--text-faint']) {
      const explicitValue = cssVar(explicitDark, token);
      expect(cssVar(systemDark, token)).toBe(explicitValue);
      expect(contrastRatio(explicitValue, panel)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('uses the readable secondary tiers for composer placeholder copy', () => {
    expect(cssBlock(homeHeroCss, '.home-hero__lexical .composer-input-placeholder'))
      .toContain('color: var(--text-soft);');
    expect(cssBlock(homeHeroCss, '.home-hero__lexical .home-hero__carousel'))
      .toContain('color: var(--text-soft);');
    expect(cssBlock(chatCss, '\n.composer-input-placeholder'))
      .toContain('color: var(--text-faint);');
  });
});
