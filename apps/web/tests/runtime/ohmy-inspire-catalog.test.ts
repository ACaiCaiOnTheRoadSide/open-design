import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadOhMyInspireTemplate,
  fetchAllOhMyInspireTemplates,
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

  it('loads every catalog page for the home taxonomy', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { items: [{ id: 'one', name: 'One', description: '' }], total_pages: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        data: { items: [{ id: 'two', name: 'Two', description: '' }], total_pages: 2 },
      }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAllOhMyInspireTemplates()).resolves.toHaveLength(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1,
      '/api/v1/catalog/templates?mode=all&page=1&page_size=100',
      { credentials: 'include' },
    );
    expect(fetchMock).toHaveBeenNthCalledWith(2,
      '/api/v1/catalog/templates?mode=all&page=2&page_size=100',
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
    expect(ohMyInspireCatalogPreviewUrl(
      '/openapi/v1/catalog/previews/deck/preview.webp',
    )).toBe('/api/v1/catalog/previews/deck/preview.webp');
    expect(ohMyInspireCatalogPreviewUrl('/gpt-image-2/case544.webp')).toBe(
      '/api/v1/catalog/raw-preview/gpt-image-2/case544.webp',
    );
    expect(ohMyInspireCatalogPreviewUrl('/gpt-image-2/../secret.webp')).toBeNull();
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
