import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('template recommendation client', () => {
  it('posts the hosted API contract and unwraps the backend envelope', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: {
        recommendations: [{ id: 'landing', kind: 'design-template', name: 'Landing', reason: 'fit', confidence: 0.9 }],
        degraded: false,
        index_version: 'v1',
      } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { recommendTemplates } = await import('../../src/state/templateRecommend');

    const result = await recommendTemplates({
      prompt: 'Build a landing page',
      surface: 'home',
      locale: 'en',
      excludeIds: ['seen'],
      topN: 5,
    });

    expect(result?.recommendations[0]?.id).toBe('landing');
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/templates/recommend', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        prompt: 'Build a landing page',
        surface: 'home',
        locale: 'en',
        exclude_ids: ['seen'],
        top_n: 5,
      }),
    }));
  });

  it('prefers an unsent draft and detects filtered-empty project results', async () => {
    const client = await import('../../src/state/templateRecommend');
    expect(client.preferredTemplateRecommendationPrompt('  new brief  ', 'old brief')).toBe('new brief');
    expect(client.preferredTemplateRecommendationPrompt(' ', ' old brief ')).toBe('old brief');
    expect(client.designTemplateRecommendations({
      recommendations: [{ id: 'plugin', kind: 'plugin', name: 'Plugin', reason: 'x', confidence: 1 }],
      degraded: false,
      index_version: 'test',
    })).toEqual([]);
  });

  it('marks the optional entry unavailable when the hosted route is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const client = await import('../../src/state/templateRecommend');
    await expect(client.recommendTemplates({ prompt: 'test' })).resolves.toBeNull();
    expect(client.templateRecommendUnavailable()).toBe(true);
  });
});
