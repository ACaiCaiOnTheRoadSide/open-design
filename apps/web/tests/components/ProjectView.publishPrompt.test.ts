import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  buildOhMyInspirePublishPrompt,
  buildShowcasePublishPrompt,
} from '../../src/components/ProjectView';

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

  it('spells out the publish origins at the point of use', () => {
    const skill = readFileSync(
      new URL('../../../../skills/publish-website/SKILL.md', import.meta.url),
      'utf8',
    );

    // A publish runs across several question-form turns, so the turn that
    // finally posts may have lost the Step 1c target. When the command only
    // carried a bare `<API_BASE>` slot, a model filling that slot invented
    // `publish.tatakai.studio` and reported a DNS failure. Every command that
    // leaves the machine must carry a literal origin instead.
    expect(skill).toContain('https://ugc-submit.sc.monkeycode-ai.online/v1/create');
    expect(skill).toContain('https://ugc-submit.sc.monkeycode-ai.online/v1/status');
    expect(skill).toContain('https://ugc-submit.sc.monkeycode-ai.online/v1/recall');
    expect(skill).not.toMatch(/^\s*"?<API_BASE>?\/v1\//m);
  });
});

describe('buildOhMyInspirePublishPrompt', () => {
  it('delegates packaging and upload to the dedicated skill', () => {
    const prompt = buildOhMyInspirePublishPrompt('project-123');

    expect(prompt).toContain('publish-ohmyinspire skill');
    expect(prompt).toContain('project id is "project-123"');
    expect(prompt).toContain('Never upload the raw OpenDesign project archive');
    expect(prompt).toContain('report the actual API result');
  });

  it('defines a validated OhMyInspire package instead of a raw project zip', () => {
    const skill = readFileSync(
      new URL('../../../../skills/publish-ohmyinspire/SKILL.md', import.meta.url),
      'utf8',
    );

    expect(skill).toContain('`template.json` at the archive root');
    expect(skill).toContain('`SKILL.md` at the archive root');
    expect(skill).toContain('`skillPath`: `SKILL.md`');
    expect(skill).toContain('POST "$OD_DAEMON_URL/api/tools/ohmyinspire/templates"');
    expect(skill).toContain('Never upload the raw project ZIP');
  });
});
