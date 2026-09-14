// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const template = vi.hoisted(() => ({
  id: 'landing-page-template',
  name: 'Landing page template',
  description: 'Create a focused landing page.',
  mode: 'prototype',
  category: 'website',
}));

vi.mock('../../src/runtime/ohmy-inspire-catalog', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../src/runtime/ohmy-inspire-catalog')>(),
  fetchAllOhMyInspireTemplates: vi.fn().mockResolvedValue([template]),
}));

vi.mock('../../src/components/home-hero/PlaceholderCarousel', () => ({
  PlaceholderCarousel: () => null,
}));

import { HomeHero } from '../../src/components/HomeHero';

afterEach(() => {
  cleanup();
});

describe('HomeHero template library', () => {
  it('collapses after a template is selected successfully', async () => {
    const onPickOhMyInspireTemplate = vi.fn().mockResolvedValue(true);

    render(
      <HomeHero
        prompt=""
        onPromptChange={() => undefined}
        onSubmit={() => undefined}
        activePluginTitle={null}
        activeChipId={null}
        onClearActivePlugin={() => undefined}
        pluginOptions={[]}
        pluginsLoading={false}
        pendingPluginId={null}
        pendingChipId={null}
        onPickPlugin={() => undefined}
        onPickOhMyInspireTemplate={onPickOhMyInspireTemplate}
        onPickChip={() => undefined}
        onClearActiveChip={() => undefined}
        contextItemCount={0}
        error={null}
      />,
    );

    await screen.findByTestId('home-hero-ohmyinspire-preset');
    fireEvent.click(screen.getByTestId('home-hero-template-expand'));
    expect(screen.getByTestId('home-hero-template-library')).toHaveClass('is-expanded');

    const expandedPreset = screen.getByTestId('home-hero-ohmyinspire-preset');
    const useButton = expandedPreset.querySelector<HTMLButtonElement>('.home-hero__plugin-preset-preview-action');
    expect(useButton).toBeTruthy();
    fireEvent.click(useButton!);

    await waitFor(() => {
      expect(onPickOhMyInspireTemplate).toHaveBeenCalledWith(template);
      expect(screen.getByTestId('home-hero-template-library')).not.toHaveClass('is-expanded');
      expect(screen.getByTestId('home-hero-template-expand')).toHaveAttribute('aria-expanded', 'false');
    });
  });
});
