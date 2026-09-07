import { describe, expect, it } from 'vitest';

import {
  emittedRenderableQuestionForm,
  questionFormBodyIsRenderable,
} from '../src/question-form-detect.js';

describe('question-form detection', () => {
  it('accepts the question tool YAML-like fallback inside a text fence', () => {
    const body = [
      '```text',
      'question: 需要把本应用发布到哪里的作品集？',
      'header: 发布目标',
      'options:',
      '  - 中国大陆 (sc.monkeycode-ai.online)',
      '  - 全球 (monkeycode-ai.gallery)',
      '```',
    ].join('\n');

    expect(questionFormBodyIsRenderable(body)).toBe(true);
    expect(emittedRenderableQuestionForm(`<question-form>${body}</question-form>`)).toBe(true);
  });

  it('still rejects incomplete shorthand payloads', () => {
    expect(questionFormBodyIsRenderable('question: Pick one\noptions:')).toBe(false);
  });

  it('accepts the JSON array payload supported by the web parser', () => {
    expect(
      questionFormBodyIsRenderable(
        JSON.stringify([{ id: 'target', prompt: 'Publish where?', options: ['Domestic', 'Global'] }]),
      ),
    ).toBe(true);
  });
});
