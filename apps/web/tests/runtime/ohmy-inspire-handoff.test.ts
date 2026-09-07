import { describe, expect, it } from 'vitest';
import { templateHandoffFromPageUrl } from '../../src/runtime/ohmy-inspire-handoff';

describe('templateHandoffFromPageUrl', () => {
  it('creates a localized prompt and removes the one-shot parameter', () => {
    const result = templateHandoffFromPageUrl(
      'https://design.example.com/studio/?template_url=https%3A%2F%2Finspire.example.com%2Ftemplate.zip&keep=1',
      'zh-CN',
    );

    expect(result?.prompt).toContain('https://inspire.example.com/template.zip');
    expect(result?.prompt).toContain('SKILL.md');
    expect(result?.sanitizedUrl).toBe('https://design.example.com/studio/?keep=1');
  });

  it('rejects non-http template URLs', () => {
    expect(
      templateHandoffFromPageUrl(
        'https://design.example.com/studio/?template_url=javascript%3Aalert(1)',
        'en',
      ),
    ).toBeNull();
  });
});
