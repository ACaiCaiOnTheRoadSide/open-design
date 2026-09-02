import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const homeHeroSource = read('../../src/components/HomeHero.tsx');
const aidesignWordmarkSource = read('../../src/components/AIDesignWordmark.tsx');
const homeHeroCss = read('../../src/styles/home/home-hero.css');
const entryNavRailSource = read('../../src/components/EntryNavRail.tsx');
const logoSvg = read('../../public/logo.svg');
const brandIconSvg = read('../../public/brand-icon.svg');

// The current OpenDesign brand glyph is the ink superellipse tile introduced
// with the landing-page rebrand (landing PR #3444): its outline starts with
// this path command in every export of the mark.
const CURRENT_GLYPH_PATH_PREFIX = 'M41 0.726562';
// The retired glyph was a 444x444 dark tile (#202020) whose cursor arrow was
// drawn as a separate path starting at this command.
const RETIRED_GLYPH_MARKERS = ['#202020', 'M212.059', 'width="444"'];

describe('Home logo assets', () => {
  it('ships the current brand glyph in the public logo assets', () => {
    expect(logoSvg).toContain(CURRENT_GLYPH_PATH_PREFIX);
    expect(brandIconSvg).toContain(CURRENT_GLYPH_PATH_PREFIX);
    for (const marker of RETIRED_GLYPH_MARKERS) {
      expect(logoSvg).not.toContain(marker);
      expect(brandIconSvg).not.toContain(marker);
    }
  });

  it('keeps brand-icon.svg maskable (theme color comes from CSS)', () => {
    expect(brandIconSvg).toContain('currentColor');
  });

  it('centers the desktop title and composer on the viewport', () => {
    expect(homeHeroCss).toMatch(
      /@media \(min-width: 1281px\) \{[\s\S]*?\.home-view \{[\s\S]*?transform: none;/,
    );
    expect(homeHeroCss).toContain('width: min(820px, calc(100vw - 620px));');
    expect(homeHeroCss).toContain('left: calc(50% - 710px);');
  });

  it('renders the complete OhMyDesign wordmark on the Home hero', () => {
    expect(homeHeroSource).toContain("import { AIDesignWordmark } from './AIDesignWordmark'");
    expect(homeHeroSource).toContain('<AIDesignWordmark />');
    expect(homeHeroSource).not.toContain('aidesignWordmark.src');
    expect(aidesignWordmarkSource).toContain('<title id="ohmydesign-wordmark-title">OhMyDesign</title>');
    expect(aidesignWordmarkSource).toContain('viewBox="20 140 472 200"');
    expect(aidesignWordmarkSource).toContain('translate(30 180) scale(0.50 0.58)');
    expect(aidesignWordmarkSource).toContain('var(--home-logo-ink, #3156C8)');
    expect(aidesignWordmarkSource).not.toContain('crater-pattern');
    expect(aidesignWordmarkSource).not.toContain('lunar-texture');
    expect(aidesignWordmarkSource).toContain('var(--home-logo-paint, var(--home-logo-ink, #3156C8))');
    expect(aidesignWordmarkSource).toContain('var(--home-logo-star-primary, #F1BC45)');
    expect(aidesignWordmarkSource).toContain('var(--home-logo-star-secondary, #F3C6D8)');
    expect(homeHeroCss).toMatch(
      /\[data-theme='dark'\] \.home-hero__title-logo\s*{[\s\S]*?--home-logo-ink: #f0eee8;[\s\S]*?--home-logo-paint: var\(--home-logo-ink\);/,
    );
    expect(homeHeroCss).toMatch(
      /html:not\(\[data-theme\]\) \.home-hero__title-logo\s*{[\s\S]*?--home-logo-ink: #f0eee8;[\s\S]*?--home-logo-paint: var\(--home-logo-ink\);/,
    );
    expect(aidesignWordmarkSource).toContain('home-hero__title-star--primary');
    expect(aidesignWordmarkSource).toContain('home-hero__title-star--secondary');
    expect(homeHeroCss).toMatch(
      /\[data-theme='dark'\] \.home-hero__title-logo\s*{[\s\S]*?--home-logo-star-primary: #e8b84a;[\s\S]*?--home-logo-star-secondary: #ef8354;/,
    );
    expect(homeHeroCss).toContain('animation: home-logo-star-twinkle 2.8s ease-in-out infinite;');
    expect(homeHeroCss).toContain('drop-shadow(0 0 18px rgba(255, 174, 28, 0.56))');
    expect(homeHeroCss).toContain('drop-shadow(0 0 15px rgba(244, 153, 19, 0.5))');
    expect(homeHeroSource).toContain('home-hero__logo-particle');
    expect(homeHeroSource).toContain('home-hero__logo-bird');
    expect(homeHeroSource).not.toContain("t('homeHero.subtitlePrefix')");
    expect(homeHeroSource).not.toContain('src="/app-icon.svg"');

    // #6156 cut the rail's signed-out brand header entirely — with no cloud
    // identity the rail now starts at the search box, and expand/collapse moved
    // to the workspace tabs bar's pinned Home toggle. So the rail carries no
    // brand mark at all; what still matters is that it never falls back to the
    // retired raster app icon.
    expect(entryNavRailSource).not.toContain('src="/app-icon.svg"');
  });
});
