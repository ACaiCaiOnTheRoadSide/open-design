import { describe, expect, it } from 'vitest';
import { rewriteSkillAssetUrls } from '../../src/server.js';

describe('rewriteSkillAssetUrls', () => {
  it('rewrites ./assets/<file> img sources to the daemon route', () => {
    const html = `<img src='./assets/hero.png' alt='' />`;
    expect(rewriteSkillAssetUrls(html, 'open-design-landing')).toBe(
      `<img src='/api/skills/open-design-landing/assets/hero.png' alt='' />`,
    );
  });

  it('handles double quotes and the no-leading-dot variant', () => {
    const html = `<img src="assets/cta.png"><a href="./assets/diagram.svg"></a>`;
    expect(rewriteSkillAssetUrls(html, 'foo')).toBe(
      `<img src="/api/skills/foo/assets/cta.png"><a href="/api/skills/foo/assets/diagram.svg"></a>`,
    );
  });

  it('rewrites sibling skill asset references', () => {
    const html = `<img src='../open-design-landing/assets/hero.png' /><a href="../skill-two/assets/guide.pdf"></a>`;
    expect(rewriteSkillAssetUrls(html, 'foo')).toBe(
      `<img src='/api/skills/open-design-landing/assets/hero.png' /><a href="/api/skills/skill-two/assets/guide.pdf"></a>`,
    );
  });

  it('leaves absolute and fragment URLs untouched', () => {
    const html = `<a href='https://example.com/assets/x.png'></a><a href='#assets'></a><img src='/assets/hero.png' />`;
    expect(rewriteSkillAssetUrls(html, 'foo')).toBe(html);
  });

  it('URL-encodes current and sibling skill ids in rewritten routes', () => {
    const html = `<img src='./assets/hero.png' /><img src="../foo bar/assets/hero.png" />`;
    expect(rewriteSkillAssetUrls(html, '../oops')).toBe(
      `<img src='/api/skills/..%2Foops/assets/hero.png' /><img src="/api/skills/foo%20bar/assets/hero.png" />`,
    );
  });

  it('attaches a preview scope to font and video asset URLs', () => {
    const html = `<style>@font-face{src:url('./assets/font.woff2')}</style><video src="./assets/background.mp4"></video>`;
    expect(rewriteSkillAssetUrls(html, 'motion', '?previewScope=scope-1')).toBe(
      `<style>@font-face{src:url('/api/skills/motion/assets/font.woff2?previewScope=scope-1')}</style><video src="/api/skills/motion/assets/background.mp4?previewScope=scope-1"></video>`,
    );
  });

  it('returns non-string input unchanged', () => {
    expect(rewriteSkillAssetUrls('', 'foo')).toBe('');
  });
});
