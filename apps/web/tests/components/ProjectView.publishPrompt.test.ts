import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildShowcasePublishPrompt } from '../../src/components/ProjectView';

describe('buildShowcasePublishPrompt', () => {
  it('forces the skill curl flow instead of an OpenDesign CLI publish command', () => {
    const prompt = buildShowcasePublishPrompt('od-project-123');

    expect(prompt).toContain('client_id for this project is "od-project-123"');
    expect(prompt).toContain('emit one complete <question-form> JSON block as assistant text');
    expect(prompt).toContain('Do not call the native question or AskUserQuestion tools');
    expect(prompt).toContain('do not print placeholder text for a pending question');
    expect(prompt).toContain('execute the curl multipart POST specified in Step 8 directly');
    expect(prompt).toContain('Do not call od publish, od deploy');
    expect(prompt).toContain('or any command through OD_BIN for publishing');
  });

  it('keeps the publish skill on the renderable question-form protocol', () => {
    const skill = readFileSync(
      new URL('../../../../skills/publish-website/SKILL.md', import.meta.url),
      'utf8',
    );
    const forms = [...skill.matchAll(/<question-form\b[^>]*>\s*(\{.*?\})\s*<\/question-form>/gs)];

    expect(forms.length).toBeGreaterThan(0);
    expect(skill).not.toContain('use the `question` tool');
    expect(skill).not.toContain('`question` tool call');
    for (const form of forms) expect(() => JSON.parse(form[1]!)).not.toThrow();
  });
});
