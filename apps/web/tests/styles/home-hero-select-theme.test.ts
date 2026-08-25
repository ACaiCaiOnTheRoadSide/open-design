import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const homeHeroCss = readFileSync(new URL('../../src/styles/home/home-hero.css', import.meta.url), 'utf8');

function cssDeclarations(selector: string): string {
  const blocks: string[] = [];
  const rulePattern = /([^{}]+)\{([^}]*)\}/g;
  const cssWithoutComments = homeHeroCss.replace(/\/\*[\s\S]*?\*\//g, '');
  let match: RegExpExecArray | null;
  while ((match = rulePattern.exec(cssWithoutComments)) !== null) {
    const selectors = (match[1] ?? '').split(',').map((item) => item.trim());
    if (selectors.includes(selector)) blocks.push(match[2] ?? '');
  }
  if (blocks.length === 0) throw new Error(`Missing CSS block for ${selector}`);
  return blocks.join('\n');
}

function ruleValue(block: string, property: string): string {
  const matches = [...block.matchAll(new RegExp(`(?:^|[;\\n])\\s*${property}:\\s*([^;]+);`, 'g'))];
  const match = matches.at(-1);
  if (!match) throw new Error(`Missing CSS property ${property}`);
  return match[1]!.trim();
}

describe('HomeHero footer select theme styles', () => {
  it('uses theme-aware dropdown backgrounds instead of light-only white panels', () => {
    for (const selector of [
      '.home-hero__footer-select-menu',
      '.home-hero__footer-select-search',
      '.home-hero__footer-select-search input',
      '.home-hero__footer-select-search input:focus',
    ]) {
      const background = ruleValue(cssDeclarations(selector), 'background');
      expect(background, selector).not.toBe('#fff');
      expect(background, selector).toMatch(/var\(--bg-panel\)/);
    }
  });

  it('inverts monochrome model logos in dark dropdown panels', () => {
    for (const icon of ['openai', 'dalle', 'grok', 'elevenlabs', 'suno']) {
      const selector = `[data-theme="dark"] .home-hero__model-option-icon--${icon} img`;
      expect(ruleValue(cssDeclarations(selector), 'filter'), selector)
        .toBe('invert(1) brightness(1.2)');
      expect(homeHeroCss).toContain(
        `html:not([data-theme="light"]) .home-hero__model-option-icon--${icon} img`,
      );
    }
  });

  it('uses the configurable accent for Home selection and action highlights', () => {
    expect(ruleValue(cssDeclarations('.home-hero__type-pill.is-active'), 'color'))
      .toBe('var(--accent)');
    expect(ruleValue(
      cssDeclarations(".home-hero__footer-option--select[data-field-name='template'].has-selection"),
      'background-color',
    )).toBe('var(--accent-tint)');
    expect(ruleValue(
      cssDeclarations('.home-hero__template-option.has-selection .home-hero__footer-select-label'),
      'color',
    )).toBe('var(--accent)');
    expect(ruleValue(cssDeclarations('.home-hero__submit'), '--home-hero-submit-fg'))
      .toContain('var(--accent)');
  });
});
