import { describe, expect, it } from 'vitest';
import {
  projectInputForInstalledTemplate,
  templateHandoffFromPageUrl,
} from '../../src/runtime/ohmy-inspire-handoff';

describe('templateHandoffFromPageUrl', () => {
  it('returns the package source and removes the one-shot parameter', () => {
    const result = templateHandoffFromPageUrl(
      'https://design.example.com/studio/?template_url=https%3A%2F%2Finspire.example.com%2Ftemplate.zip&template_id=cinematic-video&keep=1',
    );

    expect(result?.sourceUrl).toBe('https://inspire.example.com/template.zip');
    expect(result?.templateId).toBe('cinematic-video');
    expect(result?.sanitizedUrl).toBe('https://design.example.com/studio/?keep=1');
  });

  it('derives the template id from a signed handoff URL', () => {
    const result = templateHandoffFromPageUrl(
      'https://design.example.com/studio/?template_url=https%3A%2F%2Finspire.example.com%2Fapi%2Fv1%2Fcatalog%2Ftemplates%2Fcinematic-video%2Fhandoff-download%3Ftoken%3Dsigned',
    );

    expect(result?.templateId).toBe('cinematic-video');
  });

  it('rejects non-http template URLs', () => {
    expect(
      templateHandoffFromPageUrl(
        'https://design.example.com/studio/?template_url=javascript%3Aalert(1)',
      ),
    ).toBeNull();
  });
});

describe('projectInputForInstalledTemplate', () => {
  const base = {
    description: 'Template description',
    triggers: [],
    previewType: 'html',
    designSystemRequired: false,
    defaultFor: [],
    upstream: null,
    hasBody: true,
    aggregatesExamples: false,
  };

  it('creates native media metadata for a video template', () => {
    const input = projectInputForInstalledTemplate({
      ...base,
      id: 'cinematic-video',
      name: 'Cinematic Video',
      mode: 'video',
      surface: 'video',
      examplePrompt: 'A tracking shot through a rainy city.',
    });

    expect(input.skillId).toBe('cinematic-video');
    expect(input.metadata).toMatchObject({
      kind: 'video',
      promptTemplate: {
        id: 'cinematic-video',
        surface: 'video',
        prompt: 'A tracking shot through a rainy city.',
      },
    });
  });

  it('keeps deck and prototype templates on their native project kinds', () => {
    expect(projectInputForInstalledTemplate({
      ...base,
      id: 'pitch-deck',
      name: 'Pitch Deck',
      mode: 'deck',
      examplePrompt: 'Create a pitch deck.',
    }).metadata.kind).toBe('deck');
    expect(projectInputForInstalledTemplate({
      ...base,
      id: 'landing-page',
      name: 'Landing Page',
      mode: 'prototype',
      examplePrompt: 'Create a landing page.',
    }).metadata.kind).toBe('prototype');
  });
});
