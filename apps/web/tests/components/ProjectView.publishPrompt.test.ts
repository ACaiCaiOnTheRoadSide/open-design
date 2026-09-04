import { describe, expect, it } from 'vitest';

import { buildShowcasePublishPrompt } from '../../src/components/ProjectView';

describe('buildShowcasePublishPrompt', () => {
  it('forces the skill curl flow instead of an OpenDesign CLI publish command', () => {
    const prompt = buildShowcasePublishPrompt('od-project-123');

    expect(prompt).toContain('client_id for this project is "od-project-123"');
    expect(prompt).toContain('execute the curl multipart POST specified in Step 8 directly');
    expect(prompt).toContain('Do not call od publish, od deploy');
    expect(prompt).toContain('or any command through OD_BIN for publishing');
  });
});
