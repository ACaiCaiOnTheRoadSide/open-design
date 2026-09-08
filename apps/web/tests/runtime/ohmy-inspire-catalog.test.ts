import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadOhMyInspireTemplate,
  fetchOhMyInspireTemplateDetail,
  fetchOhMyInspireTemplates,
  isOhMyInspireHandoffUrl,
  ohMyInspireCatalogPreviewUrl,
} from '../../src/runtime/ohmy-inspire-catalog';

describe('OhMyInspire catalog client', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads the first 20 templates through the authenticated same-origin proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: { items: [{ id: 'deck-1', name: 'Deck', description: '' }] },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchOhMyInspireTemplates()).resolves.toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/catalog/templates?mode=all&page=1&page_size=20',
      { credentials: 'include' },
    );
  });

  it('loads detail without exposing an upstream token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 0,
      data: {
        id: 'template/a',
        name: 'Template',
        description: '',
        download_url: 'https://inspire.example/api/v1/catalog/handoff-download/signed',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    const detail = await fetchOhMyInspireTemplateDetail('template/a');
    expect(detail.download_url).toContain('/handoff-download/');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/catalog/templates/template%2Fa',
      { credentials: 'include' },
    );
  });

  it('keeps previews on the authenticated same-origin catalog proxy', () => {
    expect(ohMyInspireCatalogPreviewUrl('/api/v1/catalog/templates/deck/preview')).toBe(
      '/api/v1/catalog/templates/deck/preview',
    );
    expect(ohMyInspireCatalogPreviewUrl('https://tracker.example/preview')).toBeNull();
  });

  it('downloads through the backend and sends explicit charge confirmation only after consent', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('zip', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await downloadOhMyInspireTemplate('paid/template', true);
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/catalog/templates/paid%2Ftemplate/download',
      {
        credentials: 'include',
        headers: { 'X-Confirm-Template-Charge': '1' },
      },
    );
  });

  it('accepts only fixed HTTPS handoff URLs', () => {
    expect(isOhMyInspireHandoffUrl(
      'https://inspire.example/api/v1/catalog/handoff-download/signed',
    )).toBe(true);
    expect(isOhMyInspireHandoffUrl('/api/v1/catalog/handoff-download/signed')).toBe(false);
    expect(isOhMyInspireHandoffUrl(
      'https://inspire.example/api/v1/catalog/handoff-download/signed?token=leaked',
    )).toBe(false);
  });
});
