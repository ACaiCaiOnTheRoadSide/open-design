import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { searchResearch, ResearchError } from '../src/research/index.js';

const TAVILY_ENV_KEYS = ['OD_TAVILY_API_KEY', 'TAVILY_API_KEY'];
type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

describe('research search', () => {
  const originalEnv = Object.fromEntries(
    TAVILY_ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  let projectRoot: string | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const key of TAVILY_ENV_KEYS) {
      if (originalEnv[key] == null) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    const dir = projectRoot;
    projectRoot = null;
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function tempProjectRoot() {
    projectRoot = await mkdtemp(path.join(tmpdir(), 'od-research-project-'));
    return projectRoot;
  }

  it('requires a Tavily API key', async () => {
    for (const key of TAVILY_ENV_KEYS) delete process.env[key];

    await expect(
      searchResearch({ projectRoot: await tempProjectRoot(), query: 'EV trends' }),
    ).rejects.toMatchObject({
      code: 'TAVILY_API_KEY_MISSING',
      status: 400,
    } satisfies Partial<ResearchError>);
  });

  it('supports Pinterest while discarding non-CDN image URLs', async () => {
    const fetchMock = vi.fn(async (input: FetchInput) => {
      if (String(input) === 'https://www.pinterest.com') {
        return new Response('', { status: 200 });
      }
      return new Response(JSON.stringify({
        resource_response: { data: { results: [
          { id: '1', auto_alt_text: 'safe', images: { orig: { url: 'https://i.pinimg.com/736x/a/b/c.jpg', width: 736, height: 900 } } },
          { id: '2', auto_alt_text: 'ssrf', images: { orig: { url: 'http://127.0.0.1/admin', width: 1, height: 1 } } },
        ] } },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const findings = await searchResearch({
      projectRoot: await tempProjectRoot(),
      query: 'editorial dashboard',
      providers: ['pinterest'],
      maxSources: 20,
      fetchImpl: fetchMock,
    });

    expect(findings.provider).toBe('pinterest');
    expect(findings.sources).toEqual([expect.objectContaining({
      url: 'https://www.pinterest.com/pin/1/',
      imageUrl: 'https://i.pinimg.com/736x/a/b/c.jpg',
      resolution: [736, 900],
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1]?.[0])).toMatch(/^https:\/\/www\.pinterest\.com\/resource\/BaseSearchResource\/get\//);
  });

  it('uses shallow Tavily search and normalizes JSON findings', async () => {
    process.env.OD_TAVILY_API_KEY = 'tvly-test';
    const fetchMock = vi.fn(async (_input: FetchInput, _init?: FetchInit) =>
      new Response(
        JSON.stringify({
          answer: 'EV sales are growing.',
          results: [
            {
              title: 'EV report',
              url: 'https://example.com/ev',
              content: 'EV adoption increased in 2025.',
              published_date: '2025-05-01',
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const findings = await searchResearch({
      projectRoot: await tempProjectRoot(),
      query: 'EV market 2025 trends',
      maxSources: 50,
    });

    expect(findings).toMatchObject({
      query: 'EV market 2025 trends',
      summary: 'EV sales are growing.',
      provider: 'tavily',
      depth: 'shallow',
      sources: [
        {
          title: 'EV report',
          url: 'https://example.com/ev',
          snippet: 'EV adoption increased in 2025.',
          provider: 'tavily',
          publishedAt: '2025-05-01',
        },
      ],
    });
    const [, init] = fetchMock.mock.calls[0] as [FetchInput, FetchInit];
    const body = JSON.parse(String(init!.body));
    expect(body).toMatchObject({
      query: 'EV market 2025 trends',
      search_depth: 'basic',
      max_results: 20,
      include_answer: true,
      include_raw_content: false,
    });
  });
});
