// Home example-prompt chip filtering — pure derivation contract.
//
// Homepage template taxonomy invariants this suite locks:
//   1. A video / HyperFrames template that only carries an `audio-reactive`
//      tag must NOT leak into the audio example gallery — its home is the
//      Video / HyperFrames chips. (Regression: the audio rule used a bare
//      substring `hasPart('audio')` that matched `audio-reactive`.)
//   2. The generic `od-media-generation` catch-all router must never appear
//      as an example preset under any media chip, so the "Media generation
//      (default scenario)" card neither shows up nor shows up pre-selected.

import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  homeHeroExamplePluginsForChip,
  pluginMatchesExampleChip,
} from '../../src/components/HomeHero';
import { applyFacetSelection } from '../../src/components/plugins-home/facets';

interface MakeArgs {
  id: string;
  title?: string;
  tags?: string[];
  mode?: string;
  surface?: string;
  scenario?: string;
}

function make(args: MakeArgs): InstalledPluginRecord {
  return {
    id: args.id,
    title: args.title ?? args.id,
    version: '0.1.0',
    sourceKind: 'bundled',
    source: '/tmp',
    trust: 'bundled',
    capabilitiesGranted: [],
    manifest: {
      name: args.id,
      version: '0.1.0',
      title: args.title ?? args.id,
      ...(args.tags ? { tags: args.tags } : {}),
      od: {
        kind: 'scenario',
        ...(args.mode ? { mode: args.mode } : {}),
        ...(args.surface ? { surface: args.surface } : {}),
        ...(args.scenario ? { scenario: args.scenario } : {}),
        // Give every fixture a renderable preset query so the
        // `pluginPresetQuery` filter inside homeHeroExamplePluginsForChip
        // keeps it — isolating the chip-match / hidden-id logic under test.
        useCase: { query: `use ${args.id}` },
      },
    },
    fsPath: '/tmp',
    installedAt: 0,
    updatedAt: 0,
  } as unknown as InstalledPluginRecord;
}

// Mirrors plugins/_official/video-templates/hyperframes-brand-sizzle-reel.
const brandSizzleReel = make({
  id: 'video-template-hyperframes-brand-sizzle-reel',
  title: 'HyperFrames: 30-Second Brand Sizzle Reel',
  tags: ['video-template', 'first-party', 'video', 'marketing', 'hyperframes', 'sizzle', 'audio-reactive', 'brand'],
  mode: 'video',
  surface: 'video',
  scenario: 'video',
});

// Mirrors plugins/_official/examples/audio-jingle.
const audioJingle = make({
  id: 'example-audio-jingle',
  title: 'Audio Jingle',
  tags: ['example', 'first-party', 'audio', 'marketing', 'music', 'jingle'],
  mode: 'audio',
  surface: 'audio',
  scenario: 'marketing',
});

// Mirrors plugins/_official/scenarios/od-media-generation (catch-all default).
const mediaGeneration = make({
  id: 'od-media-generation',
  title: 'Media generation (default scenario)',
  tags: ['scenario', 'first-party', 'media-generation', 'image', 'video', 'audio'],
});

// Mirrors plugins/_official/scenarios/od-web-effect-extractor, currently the
// installed catalog's concrete Website clone workflow.
const webEffectExtractor = make({
  id: 'od-web-effect-extractor',
  tags: ['scenario', 'first-party', 'website-recreation', 'webgl', 'canvas', 'shader'],
  mode: 'prototype',
  scenario: 'web-effect-extraction',
});

// Mirrors the identifying taxonomy fields of current bundled templates. The
// table intentionally covers all seven product-visible category chips.
const visibleCategoryFixtures = [
  {
    chipId: 'prototype',
    plugin: make({
      id: 'example-web-prototype',
      tags: ['example', 'first-party', 'prototype', 'web'],
      mode: 'prototype',
    }),
  },
  {
    chipId: 'deck',
    plugin: make({
      id: 'deck-template-product-strategy',
      tags: ['template', 'first-party', 'deck', 'slides'],
      mode: 'deck',
    }),
  },
  {
    chipId: 'document',
    plugin: make({
      id: 'example-annual-report',
      tags: ['example', 'first-party', 'document', 'report'],
    }),
  },
  { chipId: 'web-clone', plugin: webEffectExtractor },
  { chipId: 'audio', plugin: audioJingle },
  {
    chipId: 'live-artifact',
    plugin: make({
      id: 'example-github-dashboard',
      tags: ['example', 'first-party', 'live-artifact', 'dashboard'],
      mode: 'prototype',
    }),
  },
  {
    chipId: 'webgl',
    plugin: make({
      id: 'example-webgl-aurora-veil',
      tags: ['example', 'first-party', 'prototype', 'webgl', 'webgl2', 'shader'],
      mode: 'prototype',
      surface: 'web',
    }),
  },
] as const;

describe('pluginMatchesExampleChip — visible homepage categories', () => {
  it.each(visibleCategoryFixtures)('matches a concrete $chipId template', ({ chipId, plugin }) => {
    expect(pluginMatchesExampleChip(plugin, chipId)).toBe(true);
  });

  it('does not leak the dedicated WebGL example into either prototype classification path', () => {
    const webgl = visibleCategoryFixtures.find(({ chipId }) => chipId === 'webgl')!.plugin;
    expect(pluginMatchesExampleChip(webgl, 'prototype')).toBe(false);
    expect(applyFacetSelection([webgl], {
      category: 'prototype',
      subcategory: null,
    })).toEqual([]);
  });

  it('accepts the explicit web-recreation alias for website workflows', () => {
    expect(pluginMatchesExampleChip(make({
      id: 'od-web-recreation-workflow',
      tags: ['scenario', 'web-recreation'],
      scenario: 'web-recreation',
    }), 'web-clone')).toBe(true);
  });
});

describe('pluginMatchesExampleChip — WebGL chip', () => {
  it('requires exact example/template and webgl/webgl2 tags', () => {
    expect(pluginMatchesExampleChip(make({
      id: 'example-shader-study',
      tags: ['example', 'shader', 'gpu'],
      mode: 'prototype',
    }), 'webgl')).toBe(false);
    expect(pluginMatchesExampleChip(make({
      id: 'example-webgl-named-only',
      tags: ['example', 'generative'],
      mode: 'prototype',
    }), 'webgl')).toBe(false);
  });

  it('rejects the web-effect extraction workflow', () => {
    expect(pluginMatchesExampleChip(webEffectExtractor, 'webgl')).toBe(false);
  });

  it('rejects HyperFrames even when it mentions shader effects', () => {
    expect(pluginMatchesExampleChip(brandSizzleReel, 'webgl')).toBe(false);
  });

  it('keeps only the real WebGL template in the rendered preset derivation', () => {
    const webgl = visibleCategoryFixtures.find(({ chipId }) => chipId === 'webgl')!.plugin;
    expect(homeHeroExamplePluginsForChip(
      'webgl',
      [webgl, webEffectExtractor, brandSizzleReel],
      'en',
    ).map(({ id }) => id)).toEqual(['example-webgl-aurora-veil']);
  });
});

describe('pluginMatchesExampleChip — audio chip', () => {
  it('keeps a genuine audio template under the audio chip', () => {
    expect(pluginMatchesExampleChip(audioJingle, 'audio')).toBe(true);
  });

  it('rejects an audio-reactive HyperFrames video template from the audio chip', () => {
    expect(pluginMatchesExampleChip(brandSizzleReel, 'audio')).toBe(false);
  });

  it('still places that HyperFrames template under the hyperframes chip', () => {
    expect(pluginMatchesExampleChip(brandSizzleReel, 'hyperframes')).toBe(true);
  });
});

describe('homeHeroExamplePluginsForChip — audio chip', () => {
  const installed = [audioJingle, brandSizzleReel, mediaGeneration];

  it('shows the audio jingle but neither the HyperFrames reel nor the media-generation default', () => {
    const ids = homeHeroExamplePluginsForChip('audio', installed, 'en').map((p) => p.id);
    expect(ids).toContain('example-audio-jingle');
    expect(ids).not.toContain('video-template-hyperframes-brand-sizzle-reel');
    expect(ids).not.toContain('od-media-generation');
  });
});
