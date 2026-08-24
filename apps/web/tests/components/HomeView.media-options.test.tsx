// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const workspaceContextMock = vi.hoisted(() => ({
  state: {
    context: null,
    resourceReadIdentity: null,
    loading: false,
    identityChangePending: false,
    failure: 'unsupported' as 'unsupported' | 'unavailable' | undefined,
  },
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

vi.mock('../../src/collab/useWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/collab/useWorkspaceContext')>();
  return {
    ...actual,
    useWorkspaceContext: () => workspaceContextMock.state,
  };
});

import { HomeView } from '../../src/components/HomeView';
import { createPluginUseHandoff } from '../../src/components/home-hero/plugin-authoring';
import type { DesignSystemSummary, PromptTemplateSummary } from '../../src/types';
// HomeHero's prompt input migrated from a <textarea> + highlight overlay to the
// same Lexical contenteditable the project composer uses. It still has
// data-testid="home-hero-input" but has no `.value`, so we drive it through the
// Lexical-aware helper (real editor.update) and read it back via the serializer.
import { homeHeroPromptText, setHomeHeroPrompt } from '../helpers/home-hero-lexical';

const MEDIA_PLUGIN = pluginRecord('od-media-generation', 'Media generation');
const PROTOTYPE_PLUGIN = pluginRecord('example-web-prototype', 'Web prototype');
const HYPERFRAMES_PLUGIN = pluginRecord('example-hyperframes', 'HyperFrames');
const COMMUNITY_IMAGE_PLUGIN = pluginRecord('community-image-template', 'Community image template');

const PROMPT_TEMPLATES: PromptTemplateSummary[] = [
  {
    id: 'image-product',
    surface: 'image',
    title: 'Image product concept',
    summary: 'A polished product image prompt.',
    category: 'product',
    model: 'gpt-image-2',
    aspect: '16:9',
    source: { repo: 'open-design/image-prompts', license: 'MIT' },
  },
  {
    id: 'video-reveal',
    surface: 'video',
    title: 'Video reveal',
    summary: 'A short reveal video prompt.',
    category: 'product',
    model: 'doubao-seedance-2-0-260128',
    aspect: '16:9',
    source: { repo: 'open-design/video-prompts', license: 'MIT' },
  },
  {
    id: 'hyperframes-caption',
    surface: 'video',
    title: 'HyperFrames captions',
    summary: 'A caption-led HyperFrames prompt.',
    category: 'motion',
    model: 'hyperframes-html',
    aspect: '16:9',
    source: { repo: 'heygen-com/hyperframes', license: 'MIT' },
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
  workspaceContextMock.state = {
    context: null,
    resourceReadIdentity: null,
    loading: false,
    identityChangePending: false,
    failure: 'unsupported',
  };
});

describe('HomeView media composer options', () => {
  it('shows the Home composer mode picker and still defaults to Design mode', async () => {
    stubFetch();
    const onSubmit = vi.fn();
    renderHome({ onSubmit });

    await screen.findByTestId('home-hero-input');

    // 设计 is the app default AND the default SELECTION: the composer opens with
    // the Design pill showing, so the mode the request will run in is stated on
    // screen rather than hidden behind a neutral glyph. The submitted payload
    // carries design either way.
    expect(screen.getByTestId('composer-mode-trigger').getAttribute('aria-label')).toBe('Mode: Design');
    expect(screen.getByTestId('composer-mode-clear')).toBeTruthy();

    await setHomePrompt('Create a clean loading animation');
    await submitHome();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'Create a clean loading animation',
      conversationMode: 'design',
    });
  });

  it('renders the design-system popover outside the prompt editor (not clipped by it)', async () => {
    stubFetch();
    renderHome();

    await clickHomeRailChip('prototype');
    await openOption('designSystem');

    // The shared DesignSystemPicker portals its popover to document.body, so it
    // can never be clipped by the prompt editor's (or footer row's) overflow.
    const popover = screen.getByTestId('project-ds-picker-popover');
    expect(screen.getByTestId('home-hero-input').contains(popover)).toBe(false);
    expect(document.body.contains(popover)).toBe(true);
  });

  it('hides native visual templates while retaining Audio and the persistent design-system picker', async () => {
    stubFetch();
    renderHome();

    expect(screen.getByTestId('home-hero-design-system-trigger')).toBeTruthy();
    const trigger = await screen.findByTestId('home-hero-template-trigger');
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    expect(screen.queryByTestId('home-hero-template-wedge-image')).toBeNull();
    expect(screen.queryByTestId('home-hero-template-wedge-video')).toBeNull();
    expect(screen.queryByTestId('home-hero-template-wedge-hyperframes')).toBeNull();
    expect(screen.getByTestId('home-hero-template-wedge-audio')).toBeTruthy();
    expect(screen.getByTestId('home-hero-template-wedge-prototype')).toBeTruthy();

    fireEvent.click(screen.getByTestId('home-hero-template-wedge-audio'));
    await waitFor(() => expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Audio'));
    expect(promptIsEmpty()).toBe(true);
    expect(screen.queryByTestId('home-hero-footer-option-model')).toBeNull();
    expect(screen.queryByTestId('home-hero-footer-option-ratio')).toBeNull();
    expect(screen.queryByTestId('home-hero-footer-option-duration')).toBeNull();
  });

  it('falls a persisted hidden visual draft back to the default Prototype design', async () => {
    window.localStorage.setItem(
      'open-design:home-composer:chip',
      JSON.stringify({ chipId: 'image', pluginId: 'od-media-generation', projectKind: 'image' }),
    );
    stubFetch();
    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
    });
    expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('Image');
  });

  it('falls a persisted untyped native media draft back to Prototype', async () => {
    window.localStorage.setItem(
      'open-design:home-composer:chip',
      JSON.stringify({ chipId: null, pluginId: 'od-media-generation', projectKind: null }),
    );
    stubFetch();
    renderHome();

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
    });
    expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('Image');
  });

  it('falls an untyped native media plugin handoff back to Prototype', async () => {
    stubFetch();
    renderHome({
      promptHandoff: createPluginUseHandoff(1, 'od-media-generation', { action: 'use' }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Prototype');
    });
    expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('Image');
  });

  it('preserves non-native visual plugin handoffs from Community', async () => {
    const fetchMock = stubFetch();
    renderHome({
      promptHandoff: createPluginUseHandoff(1, COMMUNITY_IMAGE_PLUGIN.id, {
        action: 'use',
        chipId: 'image',
        projectKind: 'image',
      }),
    });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => (
        typeof url === 'string'
        && url.includes(`/api/plugins/${COMMUNITY_IMAGE_PLUGIN.id}/apply`)
      ))).toBe(true);
    });
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/example-web-prototype/apply')
    ))).toBe(false);
  });

  it('includes only published user-created design systems in the Home style picker', async () => {
    stubFetch();
    renderHome({
      designSystems: [
        designSystem('user:acme-draft', 'Acme Draft System', 'user', 'draft'),
        designSystem('user:acme-published', 'Acme Published System', 'user', 'published'),
        designSystem('neutral-modern', 'Neutral Modern', 'built-in', 'published'),
      ],
    });

    await clickHomeRailChip('prototype');
    await openOption('designSystem');

    // The shared picker is a flat searchable list (no group headers). Home still
    // filters to selectable systems: a published user system shows, a draft one
    // does not, and built-in presets show.
    const popover = screen.getByTestId('project-ds-picker-popover');
    expect(within(popover).getByRole('option', { name: /Acme Published System/i })).toBeTruthy();
    expect(within(popover).queryByRole('option', { name: /Acme Draft System/i })).toBeNull();
    expect(within(popover).getByRole('option', { name: /Neutral Modern/i })).toBeTruthy();
  });

  it('opens the Home style picker without duplicate group key warnings', async () => {
    stubFetch();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      renderHome({
        defaultDesignSystemId: 'official-default',
        designSystems: [
          designSystem('official-default', 'Official Default', 'built-in', 'published'),
          designSystem('official-alt', 'Official Alt', 'built-in', 'published'),
        ],
      });

      await clickHomeRailChip('prototype');
      await openOption('designSystem');

      const messages = consoleError.mock.calls.map((call) => call.map(String).join(' '));
      expect(messages.some((message) => message.includes('Encountered two children with the same key'))).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('selects retained Audio without opening the replacement dialog', async () => {
    stubFetch();
    renderHome();

    await clickHomeRailChip('audio');
    await waitFor(() => expect(screen.getByTestId('home-hero-template-trigger').textContent).toContain('Audio'));
    expect(screen.queryByText('Replace current prompt?')).toBeNull();
  });
  it('keeps the prompt empty for Audio and never injects inline slot widgets', async () => {
    stubFetch();
    renderHome();

    // Audio type / model / duration / voice are no longer footer pills — the
    // agent asks for them during the run. The composer just stays empty.
    await clickHomeRailChip('audio');
    await waitFor(() => expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('None'));
    expect(promptIsEmpty()).toBe(true);
    expect(screen.queryByTestId('home-hero-footer-option-audioType')).toBeNull();
    expect(screen.queryByTestId('home-hero-footer-option-duration')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-prompt')).toBeNull();
    expect(screen.queryByTestId('home-hero-prompt-slot-text')).toBeNull();
  });

  it('hides the full selector grid for the retained Audio surface', async () => {
    stubFetch();
    renderHome();

    await clickHomeRailChip('audio');
    expect(screen.queryByRole('combobox', { name: 'Duration' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Template' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Model' })).toBeNull();
  });
  it('includes the selected design system in the submitted payload and omits asked-for media fields', async () => {
    stubFetch();
    const onSubmit = vi.fn();
    renderHome({
      onSubmit,
      designSystems: [
        designSystem('editorial-noir', 'Editorial Noir', 'built-in', 'published'),
        designSystem('brand-alpha', 'Brand Alpha', 'user', 'published'),
      ],
    });

    await clickHomeRailChip('prototype');
    await waitFor(() => expect(screen.getByTestId('home-hero-template-trigger').textContent).not.toContain('None'));
    await chooseOption('designSystem', 'brand-alpha', 'Brand Alpha');
    setHomePrompt('Create a polished prototype.');
    await submitHome();

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
        prompt: 'Create a polished prototype.',
        designSystemId: 'brand-alpha',
        projectKind: 'prototype',
      }));
    });
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      projectMetadata: expect.objectContaining({ kind: 'prototype' }),
    }));
  });

  it('does not wait for rich Workspace context after a directory-scoped plugin was selected', async () => {
    const fetchMock = stubFetch({ teamMediaPlugin: true });
    const onSubmit = vi.fn();
    const props = homeProps({ onSubmit });
    const view = render(<HomeView {...props} />);

    await clickHomeRailChip('audio');
    await setHomePrompt('Create a directory-scoped launch teaser.');
    workspaceContextMock.state = {
      context: null,
      resourceReadIdentity: null,
      loading: true,
      identityChangePending: false,
      failure: undefined,
    };
    view.rerender(<HomeView {...props} />);
    await submitHome();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const localApply = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string'
      && url.includes('/api/plugins/od-media-generation/apply')
    )).at(-1);
    expect(localApply).toBeTruthy();
    expect(new Headers(localApply?.[1]?.headers).has('x-od-workspace-id')).toBe(false);
  });

  it('keeps bundled plugins usable when identity is pending and the directory is empty', async () => {
    const fetchMock = stubFetch({ emptyWorkspaceDirectory: true });
    const onSubmit = vi.fn();
    const props = homeProps({ onSubmit });
    const view = render(<HomeView {...props} />);

    await clickHomeRailChip('audio');
    await setHomePrompt('Create a launch teaser after signing out.');
    const applyCountBeforeSubmit = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    )).length;
    workspaceContextMock.state = {
      context: null,
      resourceReadIdentity: null,
      loading: false,
      identityChangePending: true,
      failure: undefined,
    };
    view.rerender(<HomeView {...props} />);
    await submitHome();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const applyCountAfterSubmit = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    )).length;
    expect(applyCountAfterSubmit).toBe(applyCountBeforeSubmit + 1);
    const submittedApply = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    )).at(-1);
    expect(new Headers(submittedApply?.[1]?.headers).has('x-od-workspace-id')).toBe(false);
  });

  it('does not wait for directory discovery when applying a bundled plugin', async () => {
    const fetchMock = stubFetch({ workspaceDirectoryStatus: 503 });
    const onSubmit = vi.fn();
    const props = homeProps({ onSubmit });
    const view = render(<HomeView {...props} />);

    await clickHomeRailChip('audio');
    await setHomePrompt('Create a local launch teaser while identity is unavailable.');
    workspaceContextMock.state = {
      context: null,
      resourceReadIdentity: null,
      loading: true,
      identityChangePending: true,
      failure: 'unavailable',
    };
    view.rerender(<HomeView {...props} />);
    const directoryReadsBeforeSubmit = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url === '/api/workspace/directory'
    )).length;
    await submitHome();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const directoryReadsAfterSubmit = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url === '/api/workspace/directory'
    )).length;
    expect(directoryReadsAfterSubmit).toBe(directoryReadsBeforeSubmit);
    const submittedApply = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    )).at(-1);
    expect(new Headers(submittedApply?.[1]?.headers).has('x-od-workspace-id')).toBe(false);
  });

  it('does not expose a team plugin for unscoped apply while workspace identity is pending', async () => {
    const fetchMock = stubFetch({
      emptyWorkspaceDirectory: true,
      teamMediaPlugin: true,
    });
    workspaceContextMock.state = {
      context: null,
      resourceReadIdentity: null,
      loading: false,
      identityChangePending: true,
      failure: undefined,
    };
    renderHome();

    await screen.findByTestId('home-hero-input');
    expect((screen.getByTestId('home-hero-template-trigger') as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    ))).toBe(false);
  });

  it('keeps a locally catalogued plugin usable until local reconciliation removes it', async () => {
    const fetchMock = stubFetch({
      emptyWorkspaceDirectory: true,
      teamMediaPlugin: true,
    });
    workspaceContextMock.state = {
      context: null,
      resourceReadIdentity: null,
      loading: false,
      identityChangePending: false,
      failure: undefined,
    };
    renderHome();

    await clickHomeRailChip('audio');

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-submit').getAttribute('aria-busy')).toBe('false');
    });
    const apply = fetchMock.mock.calls.find(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    ));
    expect(apply).toBeTruthy();
    expect(new Headers(apply?.[1]?.headers).has('x-od-workspace-id')).toBe(false);
  });

  it('preserves od-media-generation required inputs when submitting retained Audio', async () => {
    const fetchMock = stubFetch();
    const onSubmit = vi.fn();
    renderHome({ onSubmit });

    await clickHomeRailChip('audio');
    await setHomePrompt('Create a concise audio identity for a product.');
    await submitHome();

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const applyCall = fetchMock.mock.calls.filter(([url]) => (
      typeof url === 'string' && url.includes('/api/plugins/od-media-generation/apply')
    )).at(-1);
    expect(applyCall).toBeTruthy();
    expect(JSON.parse(String(applyCall?.[1]?.body)).inputs).toMatchObject({
      mediaKind: 'audio',
      subject: "the user's brief",
      style: 'clear, polished, modern',
      aspect: '16:9',
    });
    expect(JSON.parse(String(applyCall?.[1]?.body)).inputs).not.toHaveProperty('ratio');
  });
});

function renderHome(overrides: Partial<React.ComponentProps<typeof HomeView>> = {}) {
  return render(<HomeView {...homeProps(overrides)} />);
}

function homeProps(overrides: Partial<React.ComponentProps<typeof HomeView>> = {}): React.ComponentProps<typeof HomeView> {
  return {
    projects: [],
    onSubmit: () => undefined,
    onOpenProject: () => undefined,
    onViewAllProjects: () => undefined,
    promptTemplates: PROMPT_TEMPLATES,
    ...overrides,
  };
}

function stubFetch(options: {
  elevenLabsVoices?: Array<{ voiceId: string; name: string; category?: string }>;
  elevenLabsVoiceError?: string;
  emptyWorkspaceDirectory?: boolean;
  teamMediaPlugin?: boolean;
  workspaceDirectoryStatus?: number;
} = {}) {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
  const mediaPlugin = options.teamMediaPlugin
    ? { ...MEDIA_PLUGIN, source: 'team:plugin:workspace-a:od-media-generation' }
    : MEDIA_PLUGIN;
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    if (typeof url === 'string' && url === '/api/plugins') {
      return json({
        plugins: [mediaPlugin, PROTOTYPE_PLUGIN, HYPERFRAMES_PLUGIN, COMMUNITY_IMAGE_PLUGIN],
      });
    }
    if (typeof url === 'string' && url === '/api/mcp/servers') {
      return json({ servers: [], templates: [] });
    }
    if (typeof url === 'string' && url === '/api/workspace/directory') {
      if (options.workspaceDirectoryStatus) {
        return json({ error: 'workspace_unavailable' }, options.workspaceDirectoryStatus);
      }
      return json({
        items: options.emptyWorkspaceDirectory
          ? []
          : [{
              workspaceId: 'workspace-cold',
              workspaceName: 'Cold workspace',
              workspaceType: 'team',
              workspaceMemberId: 'member-cold',
              role: 'member',
              memberStatus: 'active',
              lifecycleState: 'active',
            }],
        activeWorkspaceId: null,
      });
    }
    if (typeof url === 'string' && url.includes('/apply')) {
      const pluginId = url.split('/api/plugins/')[1]?.split('/apply')[0] ?? 'od-media-generation';
      if (pluginId === 'od-media-generation') {
        const body = JSON.parse(String(init?.body ?? '{}')) as { inputs?: Record<string, unknown> };
        const inputs = body.inputs ?? {};
        if (!inputs.subject) {
          return json({ error: 'missing_inputs', fields: ['subject'] }, 422);
        }
      }
      return json(applyResult(pluginId));
    }
    if (typeof url === 'string' && url === '/api/media/providers/elevenlabs/voices?limit=100') {
      if (options.elevenLabsVoiceError) {
        return json({ error: options.elevenLabsVoiceError }, 400);
      }
      return json({
        voices: options.elevenLabsVoices ?? [
          { voiceId: 'voice-rachel', name: 'Rachel', category: 'premade' },
        ],
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function openOption(name: string) {
  // The design-system picker moved out of the footer to the persistent row
  // below the composer; it renders the shared DesignSystemPicker, whose popover
  // is portaled to document.body as `project-ds-picker-popover`. Any other
  // footer field still opens from the inline FooterSelectOption `-menu`.
  if (name === 'designSystem') {
    fireEvent.click(await screen.findByTestId('home-hero-design-system-trigger'));
    await waitFor(() => expect(screen.getByTestId('project-ds-picker-popover')).toBeTruthy());
    return;
  }
  fireEvent.click(await screen.findByTestId(`home-hero-footer-option-${name}`));
  await waitFor(() => expect(screen.getByTestId(`home-hero-footer-option-${name}-menu`)).toBeTruthy());
}

async function clickHomeRailChip(id: string) {
  // #5517 removed the inline template rail from Home: every scenario template
  // is picked from the composer footer's radial Template picker. Wait until the
  // trigger and the wedge are enabled first — plugins load asynchronously, so
  // both are briefly disabled after mount.
  const trigger = await screen.findByTestId('home-hero-template-trigger');
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  const wedgeId = `home-hero-template-wedge-${id}`;
  await waitFor(() =>
    expect(screen.getByTestId(wedgeId).getAttribute('aria-disabled')).not.toBe('true'),
  );
  fireEvent.click(screen.getByTestId(wedgeId));
}

// Drive the Lexical editor and let the OnChange -> onPromptChange -> setPrompt
// state flush settle (the submit path reads HomeView's React `prompt` state, not
// the contenteditable DOM). Lexical fires the change listener synchronously under
// the helper's `discrete: true`, but the React state update lands a microtask
// later, so we await one tick inside act().
async function setHomePrompt(value: string) {
  setHomeHeroPrompt(value);
  await act(async () => {
    await Promise.resolve();
  });
}

async function submitHome() {
  await waitFor(() => expect((screen.getByTestId('home-hero-submit') as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByTestId('home-hero-submit'));
}

// An empty Lexical editor serializes its placeholder <br> as a lone '\n', so the
// composer's clear-empty convention is `text.trim() === ''` (formerly the
// textarea's `.value === ''`).
function promptIsEmpty(): boolean {
  return homeHeroPromptText().trim() === '';
}

async function chooseOption(name: string, value: string, label = value) {
  await openOption(name);
  if (name === 'designSystem') {
    // The shared DesignSystemPicker selects on mouseDown from its portaled list.
    const popover = screen.getByTestId('project-ds-picker-popover');
    const option = within(popover).getAllByRole('option').find((item) => {
      const text = item.textContent ?? '';
      return text.includes(label) || text.includes(value);
    });
    if (!option) throw new Error(`No option "${label}" for ${name}`);
    fireEvent.mouseDown(option);
    return;
  }
  // The inline `<select>` prompt-widget path (home-hero-prompt-option-*-select)
  // is gone; selection now always happens via the footer options menu.
  const menu = screen.getByTestId(`home-hero-footer-option-${name}-menu`);
  const option = within(menu).getAllByRole('option').find((item) => {
    const text = item.textContent ?? '';
    return text.includes(label) || text.includes(value);
  });
  if (!option) throw new Error(`No option "${label}" for ${name}`);
  fireEvent.click(option);
}

function pluginRecord(id: string, title: string) {
  return {
    id,
    title,
    version: '0.1.0',
    trust: 'bundled' as const,
    sourceKind: 'bundled' as const,
    source: `/tmp/${id}`,
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title,
      version: '0.1.0',
      description: title,
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        useCase: { query: 'Create media.' },
        inputs: [],
      },
    },
  };
}

function designSystem(
  id: string,
  title: string,
  source: DesignSystemSummary['source'],
  status: DesignSystemSummary['status'],
): DesignSystemSummary {
  return {
    id,
    title,
    source,
    status,
    category: source === 'user' ? 'Brand' : 'Starter',
    summary: `${title} summary.`,
    swatches: ['#111111', '#ffffff'],
    surface: 'web',
    isEditable: source === 'user',
  };
}

function applyResult(pluginId: string) {
  return {
    query: 'Create media.',
    contextItems: [],
    inputs: [],
    assets: [],
    mcpServers: [],
    trust: 'trusted',
    capabilitiesGranted: ['prompt:inject'],
    capabilitiesRequired: ['prompt:inject'],
    projectMetadata: {},
    appliedPlugin: {
      snapshotId: `snap-${pluginId}`,
      pluginId,
      pluginVersion: '0.1.0',
      manifestSourceDigest: 'a'.repeat(64),
      inputs: {},
      resolvedContext: { items: [] },
      capabilitiesGranted: ['prompt:inject'],
      capabilitiesRequired: ['prompt:inject'],
      assetsStaged: [],
      taskKind: 'new-generation',
      appliedAt: 0,
      connectorsRequired: [],
      connectorsResolved: [],
      mcpServers: [],
      status: 'fresh',
    },
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
