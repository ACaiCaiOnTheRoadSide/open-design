import { describe, expect, it } from 'vitest';
import { buildSrcdoc } from '../../src/runtime/srcdoc';
import {
  projectRawSignedUrl,
  projectRawUrl,
  signProjectRawUrlsInHtml,
} from '../../src/providers/registry';

const PROJECT = 'proj-1';
const TOKEN = 'secret/token';

describe('sandbox raw asset signing', () => {
  it('signs same-project raw paths and preserves cross-page relative navigation', () => {
    const doc = buildSrcdoc(
      `<img src="${projectRawUrl(PROJECT, 'pages/a.png')}"><a href="next.html">next</a>`,
      {
        baseHref: projectRawUrl(PROJECT, 'pages/'),
        rawAssetSigning: { projectId: PROJECT, token: TOKEN },
      },
    );
    expect(doc).toContain('/raw-signed/secret%2Ftoken/proj-1/pages/');
    expect(doc).toContain('/raw-signed/secret%2Ftoken/proj-1/pages/a.png');
    expect(doc).toContain('href="next.html"');
    expect(doc).not.toContain(`/api/projects/${PROJECT}/raw/`);
  });

  it('does not leak a token into external URLs containing an internal-looking query value', () => {
    const external = `https://example.com/view?next=${projectRawUrl(PROJECT, 'a.png')}`;
    const html = `<a href="${external}">outside</a>`;
    expect(signProjectRawUrlsInHtml(html, PROJECT, TOKEN)).toBe(html);
    expect(signProjectRawUrlsInHtml(html, PROJECT, TOKEN)).not.toContain('/raw-signed/');
  });

  it('leaves non-raw URLs, other projects, and unsigned fallbacks unchanged', () => {
    const html = `<img src="${projectRawUrl('other', 'x.png')}"><a href="/api/projects/${PROJECT}/files">files</a>`;
    expect(signProjectRawUrlsInHtml(html, PROJECT, TOKEN)).toBe(html);
    expect(signProjectRawUrlsInHtml(html, PROJECT, null)).toBe(html);
    expect(projectRawSignedUrl(PROJECT, 'a b.png', null)).toBe(projectRawUrl(PROJECT, 'a b.png'));
  });

  it('does not sign export/srcdoc output unless explicitly requested', () => {
    const doc = buildSrcdoc('<p>export</p>', { baseHref: projectRawUrl(PROJECT, 'pages/') });
    expect(doc).toContain(`/api/projects/${PROJECT}/raw/pages/`);
    expect(doc).not.toContain(TOKEN);
  });
});
