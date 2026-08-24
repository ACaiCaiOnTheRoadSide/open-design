import { describe, expect, it } from 'vitest';
import { WHITE_LABEL_SAAS } from '../../src/features/whiteLabel';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { isNativeVisualGenerationSkill } from '../../src/runtime/design-toolbox';
import type { SkillSummary } from '../../src/types';

function skill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: 'skill', name: 'skill', description: '', triggers: [], mode: 'prototype',
    previewType: 'html', designSystemRequired: false, defaultFor: [], upstream: null,
    hasBody: true, examplePrompt: '', aggregatesExamples: false,
    ...overrides,
  };
}

describe('white-label SaaS policy', () => {
  it('uses one deployment switch for completed onboarding and private telemetry defaults', () => {
    expect(WHITE_LABEL_SAAS).toBe(true);
    expect(DEFAULT_CONFIG.onboardingCompleted).toBe(true);
    expect(DEFAULT_CONFIG.telemetry).toEqual({ metrics: false, content: false });
    expect(DEFAULT_CONFIG.privacyDecisionAt).not.toBeNull();
  });

  it('hides only built-in native visual skills and preserves user/community visual skills', () => {
    expect(isNativeVisualGenerationSkill(skill({ source: 'built-in', category: 'image-generation' }))).toBe(true);
    expect(isNativeVisualGenerationSkill(skill({ source: 'built-in', mode: 'video' }))).toBe(true);
    expect(isNativeVisualGenerationSkill(skill({ source: 'user', mode: 'image' }))).toBe(false);
    expect(isNativeVisualGenerationSkill(skill({ source: 'built-in', mode: 'audio' }))).toBe(false);
  });
});
