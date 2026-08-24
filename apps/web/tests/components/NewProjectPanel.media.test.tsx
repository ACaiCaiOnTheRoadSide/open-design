// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NewProjectPanel } from '../../src/components/NewProjectPanel';

describe('NewProjectPanel media provider badges', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      disconnect() {}
      unobserve() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('treats daemon-restored apiKeyConfigured providers as configured', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: '',
          },
        }}
      />,
    );

    expect(document.querySelector('.newproj-working-dir')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    // Model picker is now a combobox — open the popover so the
    // provider group + status badge become visible in the DOM.
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    const openaiGroup = screen.getAllByText('OpenAI')
      .map((node) => node.closest('.ds-picker-group'))
      .find(Boolean);
    expect(openaiGroup?.textContent).toContain('Configured');
    expect(openaiGroup?.textContent).not.toContain('Integrated');
  });

  it('hides provider models until the provider has usable credentials', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByTestId('model-picker-option-gpt-4o-mini-tts')).toBeNull();
    expect(screen.queryByTestId('new-project-media-surface-image')).toBeNull();
    expect(screen.queryByTestId('new-project-media-surface-video')).toBeNull();
    expect(screen.getByTestId('new-project-media-surface-audio')).toBeTruthy();
  });

  it('uses the default audio model without media API credentials', async () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{}}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    await waitFor(() => {
      expect(screen.getByTestId('model-picker-trigger').textContent).toContain('Pick a model');
    });
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Default audio' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'audio',
          audioKind: 'speech',
          audioDuration: 10,
        }),
      }),
    );
  });

  it('does not treat OpenAI OAuth-only markers as usable audio credentials', () => {
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={vi.fn()}
        mediaProviders={{
          openai: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '',
            source: 'oauth-codex',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.click(screen.getByTestId('model-picker-trigger'));

    expect(screen.queryByText('OpenAI')).toBeNull();
    expect(screen.queryByTestId('model-picker-option-gpt-4o-mini-tts')).toBeNull();
  });

  it('keeps retained Audio creation independent from configured visual providers', () => {
    const onCreate = vi.fn();
    render(
      <NewProjectPanel
        skills={[]}
        designSystems={[]}
        defaultDesignSystemId={null}
        templates={[]}
        onDeleteTemplate={vi.fn()}
        promptTemplates={[]}
        onCreate={onCreate}
        mediaProviders={{
          volcengine: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5678',
            baseUrl: '',
          },
        }}
      />,
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Media' }));
    fireEvent.change(screen.getByTestId('new-project-name'), {
      target: { value: 'Configured provider audio' },
    });
    fireEvent.click(screen.getByTestId('create-project'));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          kind: 'audio',
          audioKind: 'speech',
        }),
      }),
    );
  });
});
