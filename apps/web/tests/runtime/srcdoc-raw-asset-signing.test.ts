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
    expect(doc).toContain("window.navigation.addEventListener('navigate'");
    expect(doc).toContain('window.open = function(url)');
    const sandboxShim = doc.match(/<script data-od-sandbox-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(sandboxShim).toBeTruthy();
    expect(() => new Function(sandboxShim!)).not.toThrow();
  });

  it('keeps root-relative navigation and assets inside the signed project preview', () => {
    const html = '<a href="/workflow.html">workflow</a><a href="/#contact">contact</a>'
      + '<form action="/send.html"><button formaction="/confirm.html">send</button></form>'
      + '<img data-unquoted src=/images/plain.png><img src="/images/logo.png" srcset="/images/logo.png 1x, /images/logo@2x.png 2x">'
      + '<style>@import "/styles/theme.css";.hero{background:url(/images/hero.png)}</style>'
      + '<script>location.assign("/next.html"); window.open("/help.html");</script>'
      + '<meta http-equiv="refresh" content="0;url=/done.html">'
      + '<a href="//example.com">external</a><a href="/api/status">api</a>';
    const signed = signProjectRawUrlsInHtml(html, PROJECT, TOKEN);
    expect(signed).toContain(`<a href="${projectRawSignedUrl(PROJECT, 'workflow.html', TOKEN)}">`);
    expect(signed).toContain(`<a href="${projectRawSignedUrl(PROJECT, 'index.html', TOKEN)}#contact">`);
    expect(signed).toContain(`action="${projectRawSignedUrl(PROJECT, 'send.html', TOKEN)}"`);
    expect(signed).toContain(`formaction="${projectRawSignedUrl(PROJECT, 'confirm.html', TOKEN)}"`);
    expect(signed).toContain(`src=${projectRawSignedUrl(PROJECT, 'images/plain.png', TOKEN)}`);
    expect(signed).toContain(`src="${projectRawSignedUrl(PROJECT, 'images/logo.png', TOKEN)}"`);
    expect(signed).toContain(`srcset="${projectRawSignedUrl(PROJECT, 'images/logo.png', TOKEN)} 1x, ${projectRawSignedUrl(PROJECT, 'images/logo.png', TOKEN).replace('logo.png', 'logo@2x.png')} 2x"`);
    expect(signed).toContain(`url(${projectRawSignedUrl(PROJECT, 'images/hero.png', TOKEN)})`);
    expect(signed).toContain(`@import "${projectRawSignedUrl(PROJECT, 'styles/theme.css', TOKEN)}"`);
    expect(signed).toContain('location.assign("/next.html")');
    expect(signed).toContain('window.open("/help.html")');
    expect(signed).toContain(`url=${projectRawSignedUrl(PROJECT, 'done.html', TOKEN)}`);
    expect(signed).toContain('<a href="//example.com">');
    expect(signed).toContain('<a href="/api/status">');
  });

  it('does not inject the signing token into external attributes or ordinary script strings', () => {
    const html = '<a href="https://evil.example/collect?x=url(/private.png)">external</a>'
      + '<a href="https://evil.example/collect?x=<style>url(/nested.png)</style>">nested</a>'
      + '<script>const sample = \'href="/workflow.html" location.assign("/private.png")\';</script>';
    const signed = signProjectRawUrlsInHtml(html, PROJECT, TOKEN);
    expect(signed).toBe(html);
    expect(signed).not.toContain(encodeURIComponent(TOKEN));
  });

  it('blocks dot-segment project URLs instead of letting browser normalization escape the preview', () => {
    const signed = signProjectRawUrlsInHtml(
      '<a href="/../../../../../api/health">unsafe</a><img src="/%2e%2e/secret.png">',
      PROJECT,
      TOKEN,
    );
    expect(signed).toContain('href="#od-invalid-project-path"');
    expect(signed).toContain('src="#od-invalid-project-path"');
  });

  it('respects an authored base URL when buildSrcdoc signs raw assets', () => {
    const doc = buildSrcdoc(
      '<base href="https://cdn.example/site/"><img src="/logo.png">',
      {
        baseHref: projectRawUrl(PROJECT, ''),
        rawAssetSigning: { projectId: PROJECT, token: TOKEN },
      },
    );
    expect(doc).toContain('<base href="https://cdn.example/site/">');
    expect(doc).toContain('<img src="/logo.png">');
    expect(doc).not.toContain(encodeURIComponent(TOKEN));
  });

  it('signs absolute same-origin raw URLs emitted by saved artifacts', () => {
    const origin = 'https://app.example.test';
    const absolute = `${origin}${projectRawUrl(PROJECT, 'assets/font.woff2')}`;
    const html = `<style>@font-face{src:url('${absolute}')}</style>`;
    expect(signProjectRawUrlsInHtml(html, PROJECT, TOKEN, origin)).toContain(
      "/raw-signed/secret%2Ftoken/proj-1/assets/font.woff2",
    );
    expect(signProjectRawUrlsInHtml(html, PROJECT, TOKEN, origin)).not.toContain(absolute);
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
