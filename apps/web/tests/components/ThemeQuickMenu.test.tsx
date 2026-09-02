// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeQuickMenu } from '../../src/components/ThemeQuickMenu';
import { ACCENT_SWATCHES } from '../../src/state/appearance';

afterEach(cleanup);

describe('ThemeQuickMenu', () => {
  it('supports keyboard theme selection, accent presets, Escape, and outside dismiss', () => {
    const onThemeChange = vi.fn();
    const onAccentColorChange = vi.fn();
    render(
      <ThemeQuickMenu
        config={{ theme: 'light', accentColor: '#1A74FF' }}
        onThemeChange={onThemeChange}
        onAccentColorChange={onAccentColorChange}
      />,
    );

    const trigger = screen.getByTestId('theme-quick-menu-trigger');
    fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const themeRadios = screen.getAllByRole('radio').slice(0, 3);
    expect(themeRadios.map((radio) => radio.textContent)).toEqual(['System', 'Light', 'Dark']);

    fireEvent.keyDown(themeRadios[1]!, { key: 'ArrowRight' });
    expect(onThemeChange).toHaveBeenCalledWith('dark');
    expect(document.activeElement).toBe(themeRadios[2]);

    const colorRadios = screen.getAllByRole('radio').slice(3);
    expect(colorRadios).toHaveLength(ACCENT_SWATCHES.length);
    fireEvent.click(screen.getByRole('radio', { name: '#F04142' }));
    expect(onAccentColorChange).toHaveBeenCalledWith('#F04142');
    expect(screen.queryByLabelText('Custom theme color')).toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('theme-quick-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('theme-quick-menu')).toBeNull();
  });

  it('can show only accent controls when mode switching has a separate button', () => {
    render(
      <ThemeQuickMenu
        config={{ theme: 'light', accentColor: '#353535' }}
        onThemeChange={vi.fn()}
        onAccentColorChange={vi.fn()}
        showThemeModes={false}
      />,
    );
    fireEvent.click(screen.getByTestId('theme-quick-menu-trigger'));
    expect(screen.queryByText('System')).toBeNull();
    expect(screen.getAllByRole('radio')).toHaveLength(ACCENT_SWATCHES.length);
    expect(screen.queryByLabelText('Custom theme color')).toBeNull();
  });
});
