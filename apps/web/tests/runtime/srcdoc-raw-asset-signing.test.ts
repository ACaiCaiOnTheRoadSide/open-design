import { describe, expect, it } from 'vitest';
import { buildSrcdoc } from '../../src/runtime/srcdoc';
import {
  projectRawUrl,
  projectRawSignedUrl,
  signProjectRawUrlsInHtml,
} from '../../src/providers/registry';

const PROJECT = 'proj-1';
const TOKEN = 'tok_abc';

describe('projectRawSignedUrl', () => {
  it('emits the cookie-free signed path when a token is present', () => {
    expect(projectRawSignedUrl(PROJECT, 'assets/img.png', TOKEN)).toBe(
      `/raw-signed/${TOKEN}/${PROJECT}/assets/img.png`,
    );
  });

  it('falls back to the plain /raw/ URL without a token', () => {
    expect(projectRawSignedUrl(PROJECT, 'assets/img.png', null)).toBe(
      projectRawUrl(PROJECT, 'assets/img.png'),
    );
  });
});

describe('signProjectRawUrlsInHtml', () => {
  it('rewrites every plain raw URL for the project to its signed form', () => {
    const html = [
      `<base href="${projectRawUrl(PROJECT, 'sub/')}">`,
      `<img src="${projectRawUrl(PROJECT, 'sub/a.png')}">`,
      `<a href="${projectRawUrl(PROJECT, 'history.html')}">next</a>`,
    ].join('\n');

    const signed = signProjectRawUrlsInHtml(html, PROJECT, TOKEN);

    expect(signed).not.toContain(`/api/projects/${PROJECT}/raw/`);
    expect(signed).toContain(`/raw-signed/${TOKEN}/${PROJECT}/sub/`);
    expect(signed).toContain(`/raw-signed/${TOKEN}/${PROJECT}/sub/a.png`);
    expect(signed).toContain(`/raw-signed/${TOKEN}/${PROJECT}/history.html`);
  });

  it('leaves other projects and non-raw URLs untouched', () => {
    const html = `<img src="${projectRawUrl('other', 'x.png')}"><a href="/api/projects/${PROJECT}/files">f</a>`;
    expect(signProjectRawUrlsInHtml(html, PROJECT, TOKEN)).toBe(html);
  });

  it('is a no-op without a token', () => {
    const html = `<img src="${projectRawUrl(PROJECT, 'x.png')}">`;
    expect(signProjectRawUrlsInHtml(html, PROJECT, null)).toBe(html);
  });
});

describe('buildSrcdoc rawAssetSigning', () => {
  it('signs the injected base href and body refs in one pass', () => {
    const html = `<img src="child.png"><img src="${projectRawUrl(PROJECT, 'abs.png')}">`;
    const doc = buildSrcdoc(html, {
      baseHref: projectRawUrl(PROJECT, 'dir/'),
      rawAssetSigning: { projectId: PROJECT, token: TOKEN },
    });

    // The <base> the relative child.png resolves against is now signed...
    expect(doc).toContain(`<base href="/raw-signed/${TOKEN}/${PROJECT}/dir/">`);
    // ...and the absolute ref in the body is signed too.
    expect(doc).toContain(`/raw-signed/${TOKEN}/${PROJECT}/abs.png`);
    expect(doc).not.toContain(`/api/projects/${PROJECT}/raw/`);
  });

  it('leaves the plain /raw/ base when no token is available (fallback)', () => {
    const doc = buildSrcdoc('<p>hi</p>', {
      baseHref: projectRawUrl(PROJECT, 'dir/'),
      rawAssetSigning: { projectId: PROJECT, token: null },
    });
    expect(doc).toContain(`<base href="/api/projects/${PROJECT}/raw/dir/">`);
    expect(doc).not.toContain('/raw-signed/');
  });

  it('does not sign when the option is omitted (export/self-contained path)', () => {
    const doc = buildSrcdoc('<p>hi</p>', { baseHref: projectRawUrl(PROJECT, 'dir/') });
    expect(doc).toContain(`<base href="/api/projects/${PROJECT}/raw/dir/">`);
    expect(doc).not.toContain('/raw-signed/');
  });
});
