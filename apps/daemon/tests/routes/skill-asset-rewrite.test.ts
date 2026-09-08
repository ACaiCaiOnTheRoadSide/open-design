import { describe, expect, it } from 'vitest';
import {
  rewriteSkillAssetUrls,
  rewriteSkillCssAssetUrls,
} from '../../src/routes/static-resource.js';

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

  it('rewrites sibling skill asset references with scopes bound to each target', () => {
    const html = `<img src='../open-design-landing/assets/hero.png' /><a href="../skill-two/assets/guide.pdf"></a>`;
    expect(rewriteSkillAssetUrls(html, 'foo', (skillId) => `?previewScope=${skillId}-scope`)).toBe(
      `<img src='/api/skills/open-design-landing/assets/hero.png?previewScope=open-design-landing-scope' /><a href="/api/skills/skill-two/assets/guide.pdf?previewScope=skill-two-scope"></a>`,
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

describe('rewriteSkillCssAssetUrls', () => {
  it('scopes nested relative resources against the stylesheet directory', () => {
    const css = `@font-face{src:url('./inter/font.woff2?v=2#face')} .hero{background:url(../images/hero.png)}`;
    expect(rewriteSkillCssAssetUrls(
      css,
      'motion',
      'fonts/local.css',
      '?previewScope=scope-1',
    )).toBe(
      `@font-face{src:url('/api/skills/motion/assets/fonts/inter/font.woff2?v=2&previewScope=scope-1#face')} .hero{background:url(/api/skills/motion/assets/images/hero.png?previewScope=scope-1)}`,
    );
  });

  it('leaves absolute, data, and escaping URLs untouched', () => {
    const css = `.a{src:url(data:font/woff2;base64,AAAA)}.b{src:url('/fonts/x.woff2')}.c{src:url('../../../secret')}`;
    expect(rewriteSkillCssAssetUrls(css, 'motion', 'fonts/local.css', '?previewScope=x')).toBe(css);
  });
});
