import { describe, expect, it, vi } from 'vitest';
import {
  installOrReuseTemplateHandoff,
  projectInputForInstalledTemplate,
  templateHandoffFromPageUrl,
} from '../../src/runtime/ohmy-inspire-handoff';

const baseSkill = {
  description: 'Template description',
  triggers: [],
  previewType: 'html' as const,
  designSystemRequired: false,
  defaultFor: [],
  upstream: null,
  hasBody: true,
  aggregatesExamples: false,
};

describe('templateHandoffFromPageUrl', () => {
  it('returns the package source and removes the one-shot parameter', () => {
    const result = templateHandoffFromPageUrl(
      'https://design.example.com/studio/?template_url=https%3A%2F%2Finspire.example.com%2Fapi%2Fv1%2Fcatalog%2Fhandoff-download%2Fsigned&template_id=cinematic-video&keep=1',
    );

    expect(result?.sourceUrl).toBe('https://inspire.example.com/api/v1/catalog/handoff-download/signed');
    expect(result?.templateId).toBe('cinematic-video');
    expect(result?.sanitizedUrl).toBe('https://design.example.com/studio/?keep=1');
  });

  it('does not infer an entitlement-bearing template id from the token URL', () => {
    const result = templateHandoffFromPageUrl(
      'https://design.example.com/studio/?template_url=https%3A%2F%2Finspire.example.com%2Fapi%2Fv1%2Fcatalog%2Fhandoff-download%2Fsigned',
    );

    expect(result?.templateId).toBeNull();
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
  const base = baseSkill;

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

describe('installOrReuseTemplateHandoff', () => {
  const handoff = {
    sourceUrl: 'https://inspire.example.com/api/v1/catalog/handoff-download/signed',
    templateId: 'landing-page',
    sanitizedUrl: 'https://design.example.com/studio/',
  };
  const skill = {
    ...baseSkill,
    id: 'landing-page',
    name: 'Landing Page',
    mode: 'prototype' as const,
    examplePrompt: 'Create a landing page.',
  };

  it('reuses an installed template without downloading it again', async () => {
    const install = vi.fn();
    const listInstalled = vi.fn();

    await expect(
      installOrReuseTemplateHandoff(handoff, [skill], install, listInstalled),
    ).resolves.toBe(skill);
    expect(install).not.toHaveBeenCalled();
    expect(listInstalled).not.toHaveBeenCalled();
  });

  it('installs the template without creating a project', async () => {
    const install = vi.fn().mockResolvedValue({ skill });

    await expect(
      installOrReuseTemplateHandoff(handoff, [], install, vi.fn()),
    ).resolves.toBe(skill);
    expect(install).toHaveBeenCalledWith(handoff.sourceUrl);
  });

  it('reuses the template after a concurrent install conflict', async () => {
    const install = vi.fn().mockResolvedValue({
      error: { message: 'A skill named "landing-page" is already installed' },
    });

    await expect(
      installOrReuseTemplateHandoff(handoff, [], install, async () => [skill]),
    ).resolves.toBe(skill);
  });
});
