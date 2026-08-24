// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeQuickMenu } from '../../src/components/ThemeQuickMenu';
import { ACCENT_SWATCHES } from '../../src/state/appearance';

afterEach(cleanup);

describe('ThemeQuickMenu', () => {
  it('supports keyboard theme selection, accent presets, custom color, Escape, and outside dismiss', () => {
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
    fireEvent.change(screen.getByLabelText('Custom theme color'), { target: { value: '#123456' } });
    expect(onAccentColorChange).toHaveBeenLastCalledWith('#123456');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('theme-quick-menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId('theme-quick-menu')).toBeNull();
  });

  it('keeps accent controls reachable under the light-only policy', () => {
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
    expect(screen.getByLabelText('Custom theme color')).toBeTruthy();
  });
});
