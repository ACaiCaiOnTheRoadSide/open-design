// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsDialog } from '../../src/components/SettingsDialog';
import { DEFAULT_CONFIG } from '../../src/state/config';
import type { AgentInfo, AppConfig } from '../../src/types';

describe('SettingsDialog media providers', () => {
  it('hides visual-only providers while retaining every Audio and Research provider', () => {
    renderDialog(DEFAULT_CONFIG);

    expect(screen.queryByRole('tab', { name: /HyperFrames/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Nano Banana/ })).toBeNull();
    expect(screen.queryByRole('tab', { name: /Midjourney/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /OpenAI/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Volcengine/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Tavily/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /SenseAudio/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: /SenseAudio/ }));
    expect(screen.getAllByText('Audio').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Image ·|Video ·|· Image|· Video/)).toBeNull();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows saved masked media provider keys like Composio does', () => {
    renderDialog({
      ...DEFAULT_CONFIG,
      mediaProviders: {
        senseaudio: {
          apiKey: '',
          apiKeyConfigured: true,
          apiKeyTail: '1234',
          baseUrl: '',
        },
      },
    });

    expect(document.querySelector('.field-status-badge--inline')?.textContent).toBe('Configured');
    expect(screen.getByLabelText('SenseAudio API key').getAttribute('placeholder')).toBe(
      'Enter a new key to replace the saved key',
    );
  });

  it('shows daemon fallback notice and reloads media providers from daemon', async () => {
    const reloadMock = vi.fn(async () => ({
      senseaudio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
      },
    }));
    renderDialog(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {},
      },
      {
        mediaProvidersNotice:
          'Could not load media provider settings from the local daemon. Using browser-saved settings for now.',
        onReloadMediaProviders: reloadMock,
      },
    );

    expect(
      screen.getByText(
        'Could not load media provider settings from the local daemon. Using browser-saved settings for now.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Provider settings refreshed.')).toBeTruthy();
    });

    // The redesigned section shows one detail card at a time; select the
    // SenseAudio pill to inspect the daemon-refreshed entry.
    fireEvent.click(screen.getByRole('tab', { name: /SenseAudio/ }));
    expect(document.querySelector('.field-status-badge--inline')?.textContent).toBe('Configured');
    expect((screen.getByLabelText('SenseAudio Base URL') as HTMLInputElement).value).toBe(
      'https://daemon.example/v1',
    );
  });

  it('shows loading while reloading, then clears the success flash after a short delay', async () => {
    vi.useFakeTimers();
    const reloadMock = vi.fn(
      () =>
        new Promise<AppConfig['mediaProviders']>((resolve) => {
          setTimeout(() => {
            resolve({
              senseaudio: {
                apiKey: '',
                apiKeyConfigured: true,
                apiKeyTail: '9876',
                baseUrl: 'https://daemon.example/v1',
              },
            });
          }, 50);
        }),
    );
    renderDialog(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {},
      },
      {
        mediaProvidersNotice:
          'Could not load media provider settings from the local daemon. Using browser-saved settings for now.',
        onReloadMediaProviders: reloadMock,
      },
    );

    const reloadButton = screen.getByRole('button', { name: 'Refresh providers' });
    fireEvent.click(reloadButton);

    expect(reloadMock).toHaveBeenCalledTimes(1);
    expect((screen.getByRole('button', { name: 'Loading…' }) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(screen.getByText('Provider settings refreshed.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh providers' })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.queryByText('Provider settings refreshed.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Refresh providers' })).toBeTruthy();
  });

  it('shows a sticky error when reloading media providers from daemon fails', async () => {
    const reloadMock = vi.fn(async () => null);
    renderDialog(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {},
      },
      {
        mediaProvidersNotice:
          'Could not load media provider settings from the local daemon. Using browser-saved settings for now.',
        onReloadMediaProviders: reloadMock,
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(
        screen.getByText('Could not refresh provider settings.'),
      ).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: 'Refresh providers' })).toBeTruthy();
  });

  it('refreshes daemon-backed providers while keeping untouched local-only providers when daemon reload returns a partial provider set', async () => {
    const reloadMock = vi.fn(async () => ({
      senseaudio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
      },
    }));
    renderDialog(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          senseaudio: {
            apiKey: 'sk-local-senseaudio',
            baseUrl: 'https://local-senseaudio.example/v1',
          },
          fal: {
            apiKey: 'sk-local-fal',
            baseUrl: 'https://queue.fal.run',
            model: 'fal-ai/imagen4/preview',
          },
        },
      },
      {
        mediaProvidersNotice:
          'Could not load media provider settings from the local daemon. Using browser-saved settings for now.',
        onReloadMediaProviders: reloadMock,
      },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Provider settings refreshed.')).toBeTruthy();
    });

    // Both senseaudio and fal start configured, so the default detail card is
    // Fal.ai (configured providers sort alphabetically). Switch to SenseAudio to
    // verify the daemon-refreshed values.
    fireEvent.click(screen.getByRole('tab', { name: /SenseAudio/ }));
    expect((screen.getByLabelText('SenseAudio Base URL') as HTMLInputElement).value).toBe(
      'https://daemon.example/v1',
    );
    expect((screen.getByLabelText('SenseAudio API key') as HTMLInputElement).value).toBe('');
    expect(document.querySelector('.field-status-badge--inline')?.textContent).toBe('Configured');
    // Fal.ai is a non-integrated (coming-soon) provider and no longer has
    // editable input fields in the UI; its config is preserved in state via
    // mergeDaemonMediaProviders (covered by state/config.test.ts).
  });

  it('preserves saved media keys when clearing only a non-secret field', async () => {
    const onPersist = vi.fn();
    renderDialog(
      {
        ...saveableConfig(),
        mediaProviders: {
          senseaudio: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://custom.example/v1',
          },
        },
      },
      { onPersist },
    );

    fireEvent.change(screen.getByLabelText('SenseAudio Base URL'), { target: { value: '' } });

    await waitFor(() => {
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaProviders: {
            senseaudio: {
              apiKey: '',
              apiKeyConfigured: true,
              apiKeyTail: '1234',
              baseUrl: '',
            },
          },
        }),
        expect.objectContaining({ forceMediaProviderSync: true }),
      );
    });
  });

  it('does not overwrite a local pending media-provider edit when daemon reload returns saved state', async () => {
    const reloadMock = vi.fn(async () => ({
      senseaudio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
      },
    }));
    renderDialog(
      {
        ...DEFAULT_CONFIG,
        mediaProviders: {
          senseaudio: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://saved.example/v1',
          },
        },
      },
      {
        mediaProvidersNotice:
          'Could not load media provider settings from the local daemon. Using browser-saved settings for now.',
        onReloadMediaProviders: reloadMock,
      },
    );

    fireEvent.change(screen.getByLabelText('SenseAudio API key'), {
      target: { value: 'sk-local-pending' },
    });
    fireEvent.change(screen.getByLabelText('SenseAudio Base URL'), {
      target: { value: 'https://local-pending.example/v1' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
    });
    expect((screen.getByLabelText('SenseAudio API key') as HTMLInputElement).value).toBe('sk-local-pending');
    expect((screen.getByLabelText('SenseAudio Base URL') as HTMLInputElement).value).toBe(
      'https://local-pending.example/v1',
    );
  });

  it('stops preserving a provider on reload after its media autosave succeeds', async () => {
    const reloadMock = vi.fn(async () => ({
      senseaudio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon.example/v1',
      },
    }));
    const onPersist = vi.fn(async () => undefined);
    renderDialog(
      {
        ...saveableConfig(),
        mediaProviders: {
          senseaudio: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://saved.example/v1',
          },
        },
      },
      {
        onPersist,
        onReloadMediaProviders: reloadMock,
      },
    );

    fireEvent.change(screen.getByLabelText('SenseAudio API key'), {
      target: { value: 'sk-local-saved' },
    });
    fireEvent.change(screen.getByLabelText('SenseAudio Base URL'), {
      target: { value: 'https://local-saved.example/v1' },
    });

    await waitFor(() => {
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaProviders: {
            senseaudio: {
              apiKey: 'sk-local-saved',
              apiKeyConfigured: true,
              apiKeyTail: '1234',
              baseUrl: 'https://local-saved.example/v1',
            },
          },
        }),
        expect.objectContaining({ forceMediaProviderSync: true }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));

    await waitFor(() => {
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Provider settings refreshed.')).toBeTruthy();
    });

    expect((screen.getByLabelText('SenseAudio API key') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('SenseAudio Base URL') as HTMLInputElement).value).toBe(
      'https://daemon.example/v1',
    );
    expect(document.querySelector('.field-status-badge--inline')?.textContent).toBe('Configured');
  });

  it('keeps newer pending provider edits during reload when an older media autosave resolves', async () => {
    vi.useFakeTimers();
    const reloadMock = vi.fn(async () => ({
      senseaudio: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '9876',
        baseUrl: 'https://daemon-senseaudio.example/v1',
      },
      aihubmix: {
        apiKey: '',
        apiKeyConfigured: true,
        apiKeyTail: '4444',
        baseUrl: 'https://daemon-aihubmix.example/v1',
        model: 'tts-1',
      },
    }));
    let resolveFirstPersist: (() => void) | null = null;
    const firstPersist = new Promise<void>((resolve) => {
      resolveFirstPersist = resolve;
    });
    const onPersist = vi.fn()
      .mockImplementationOnce(() => firstPersist)
      .mockImplementation(async () => undefined);
    renderDialog(
      {
        ...saveableConfig(),
        mediaProviders: {
          senseaudio: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://saved-senseaudio.example/v1',
          },
          aihubmix: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5555',
            baseUrl: 'https://saved-aihubmix.example/v1',
            model: 'tts-1',
          },
        },
      },
      {
        onPersist,
        onReloadMediaProviders: reloadMock,
      },
    );

    // One detail card renders at a time; select SenseAudio first (the default
    // selection is AIHubMix, alphabetically first among configured).
    fireEvent.click(screen.getByRole('tab', { name: /SenseAudio/ }));
    fireEvent.change(screen.getByLabelText('SenseAudio API key'), {
      target: { value: 'sk-senseaudio-first-save' },
    });
    fireEvent.change(screen.getByLabelText('SenseAudio Base URL'), {
      target: { value: 'https://local-senseaudio.example/v1' },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(onPersist).toHaveBeenCalledTimes(1);

    // Switch the card to AIHubMix for the newer pending edits.
    fireEvent.click(screen.getByRole('tab', { name: /AIHubMix/ }));
    fireEvent.change(screen.getByLabelText('AIHubMix API key'), {
      target: { value: 'sk-aihubmix-pending' },
    });
    fireEvent.change(screen.getByLabelText('AIHubMix Base URL'), {
      target: { value: 'https://local-aihubmix.example/v1' },
    });

    await act(async () => {
      resolveFirstPersist?.();
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Refresh providers' }));
      await Promise.resolve();
    });
    expect(reloadMock).toHaveBeenCalledTimes(1);

    expect((screen.getByLabelText('AIHubMix API key') as HTMLInputElement).value).toBe(
      'sk-aihubmix-pending',
    );
    expect((screen.getByLabelText('AIHubMix Base URL') as HTMLInputElement).value).toBe(
      'https://local-aihubmix.example/v1',
    );
  });

  it('clears saved media keys only through the explicit Clear action', async () => {
    const onPersist = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDialog(
      {
        ...saveableConfig(),
        mediaProviders: {
          senseaudio: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '1234',
            baseUrl: 'https://custom.example/v1',
          },
        },
      },
      { onPersist },
    );

    // Select the SenseAudio pill and confirm its detail card is showing before
    // hitting the card's Clear action (the card renders one provider at a
    // time, with the provider name as the card heading).
    fireEvent.click(screen.getByRole('tab', { name: /SenseAudio/ }));
    expect(screen.getByRole('heading', { name: 'SenseAudio' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear configuration' }));

    await waitFor(() => {
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({ mediaProviders: {} }),
        expect.objectContaining({ forceMediaProviderSync: true }),
      );
    });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });

  it('clears saved marker state and custom model fields together for custom-model providers', async () => {
    const onPersist = vi.fn();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDialog(
      {
        ...saveableConfig(),
        mediaProviders: {
          aihubmix: {
            apiKey: '',
            apiKeyConfigured: true,
            apiKeyTail: '5555',
            baseUrl: 'https://gateway.example.com',
            model: 'tts-1',
          },
        },
      },
      { onPersist },
    );

    // AIHubMix is the only configured provider, so it is the default
    // detail card; select its pill explicitly and verify the card heading.
    fireEvent.click(screen.getByRole('tab', { name: /AIHubMix/ }));
    expect(screen.getByRole('heading', { name: 'AIHubMix' })).toBeTruthy();

    expect(document.querySelector('.field-status-badge--inline')?.textContent).toBe('Configured');
    expect(screen.getByLabelText('AIHubMix API key').getAttribute('placeholder')).toBe(
      'Enter a new key to replace the saved key',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Clear configuration' }));

    await waitFor(() => {
      expect(onPersist).toHaveBeenCalledWith(
        expect.objectContaining({ mediaProviders: {} }),
        expect.objectContaining({ forceMediaProviderSync: true }),
      );
    });

    expect((screen.getByLabelText('AIHubMix Model') as HTMLInputElement).value).toBe('');
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    confirmSpy.mockRestore();
  });
});

function renderDialog(
  initial: AppConfig,
  options?: {
    mediaProvidersNotice?: string | null;
    onReloadMediaProviders?: () => Promise<AppConfig['mediaProviders'] | null>;
    onPersist?: (cfg: AppConfig, options?: { forceMediaProviderSync?: boolean }) => void;
  },
) {
  return render(
    <SettingsDialog
      initial={initial}
      agents={SAVEABLE_AGENTS}
      daemonLive
      appVersionInfo={null}
      initialSection="media"
      onPersist={options?.onPersist ?? vi.fn()}
      onPersistComposioKey={vi.fn()}
      onClose={vi.fn()}
      onRefreshAgents={vi.fn()}
      mediaProvidersNotice={options?.mediaProvidersNotice}
      onReloadMediaProviders={options?.onReloadMediaProviders}
    />,
  );
}

const SAVEABLE_AGENTS: AgentInfo[] = [
  {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    available: true,
  },
];

function saveableConfig(): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    agentId: 'codex',
  };
}
