import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8');

const homeHeroSource = read('../../src/components/HomeHero.tsx');
const aidesignWordmarkSource = read('../../src/components/AIDesignWordmark.tsx');
const entryNavRailSource = read('../../src/components/EntryNavRail.tsx');
const logoSvg = read('../../public/logo.svg');
const brandIconSvg = read('../../public/brand-icon.svg');
const heroLogotypeSvg = read('../../public/aidesign-wordmark.svg');

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

  it('renders the AIDesign wordmark on the Home hero', () => {
    expect(heroLogotypeSvg).toContain('<title id="title">AIDesign</title>');
    expect(heroLogotypeSvg).toContain('#F1BC45');
    expect(heroLogotypeSvg).toContain('#F3C6D8');
    expect(heroLogotypeSvg).toContain('viewBox="0 36 640 266"');
    expect(homeHeroSource).toContain("import { AIDesignWordmark } from './AIDesignWordmark'");
    expect(homeHeroSource).toContain('<AIDesignWordmark />');
    expect(homeHeroSource).not.toContain('aidesignWordmark.src');
    expect(aidesignWordmarkSource).toContain('viewBox="0 36 640 266"');
    expect(aidesignWordmarkSource).toContain('fill="#F1BC45"');
    expect(aidesignWordmarkSource).toContain('fill="#F3C6D8"');
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
