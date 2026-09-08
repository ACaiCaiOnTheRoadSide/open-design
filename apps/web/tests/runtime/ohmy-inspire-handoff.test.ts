import { describe, expect, it } from 'vitest';
import {
  projectInputForInstalledTemplate,
  templateHandoffFromPageUrl,
  templateHandoffTrialPrompt,
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

describe('templateHandoffTrialPrompt', () => {
  it('prioritizes SKILL.md while supporting templates without one', () => {
    expect(templateHandoffTrialPrompt('en')).toContain('If SKILL.md is available, follow it first');
    expect(templateHandoffTrialPrompt('en')).toContain('otherwise use the other available instructions and resources');
    expect(templateHandoffTrialPrompt('zh-CN')).toContain('如有 SKILL.md，请优先按照其中的要求实现');
    expect(templateHandoffTrialPrompt('zh-CN')).toContain('否则参考其他可用的说明文件与资源');
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
