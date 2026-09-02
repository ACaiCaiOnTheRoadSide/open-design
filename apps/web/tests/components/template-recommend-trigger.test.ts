import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const triggerSource = readFileSync(
  new URL('../../src/components/TemplateRecommendTrigger.tsx', import.meta.url),
  'utf8',
);
const triggerCss = readFileSync(
  new URL('../../src/components/TemplateRecommendTrigger.module.css', import.meta.url),
  'utf8',
);

describe('template recommendation trigger', () => {
  it('keeps its label and icon legible in explicit and system dark mode', () => {
    expect(triggerSource).toContain('<span>{label}</span>');
    expect(triggerCss).toMatch(
      /:global\(\[data-theme='dark'\]\) \.trigger\.trigger\s*{\s*color: var\(--text-strong\);/,
    );
    expect(triggerCss).toMatch(
      /:global\(html:not\(\[data-theme\]\)\) \.trigger\.trigger\s*{\s*color: var\(--text-strong\);/,
    );
  });
});
