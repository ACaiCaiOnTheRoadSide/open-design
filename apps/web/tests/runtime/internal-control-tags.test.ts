import { describe, expect, it } from 'vitest';

import { stripInternalControlTags } from '../../src/runtime/internal-control-tags';

describe('stripInternalControlTags', () => {
  it('removes internal title markup while preserving its text and the answer', () => {
    expect(
      stripInternalControlTags('<od-title>生成奶牛猫图片</od-title>\n图片已生成。'),
    ).toBe('生成奶牛猫图片\n图片已生成。');
  });

  it('shows text after a complete opening tag but hides partial tag tokens while streaming', () => {
    expect(stripInternalControlTags('准备中\n<od-title>生成奶牛猫', true)).toBe('准备中\n生成奶牛猫');
    for (const partial of ['<', '<o', '<od', '<od-', '<od-ti', '</', '</o']) {
      expect(stripInternalControlTags(`准备中\n${partial}`, true)).toBe('准备中\n');
    }
  });

  it('removes orphan, attributed, and unknown od tag markup without losing text', () => {
    expect(stripInternalControlTags('图片已生成。</od-title>')).toBe('图片已生成。');
    expect(stripInternalControlTags('<od-summary>摘要</od-summary>')).toBe('摘要');
    expect(stripInternalControlTags('<od-title data-label="a > b">标题</od-title>')).toBe('标题');
  });

  it('leaves normal markup and exact od-card tags unchanged', () => {
    const content = '<strong>完成</strong>\n<od-card data-label="a > b">{"type":"memory"}</od-card>';
    expect(stripInternalControlTags(content)).toBe(content);
    expect(stripInternalControlTags('<od-card-extra>说明</od-card-extra>')).toBe('说明');
  });
});
