// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeModeToggle } from '../../src/components/ThemeModeToggle';

afterEach(cleanup);

describe('ThemeModeToggle', () => {
  it('switches from light to dark with an explicit moon control', () => {
    const onChange = vi.fn();
    render(<ThemeModeToggle theme="light" onChange={onChange} />);

    const button = screen.getByTestId('theme-mode-toggle');
    expect(button.getAttribute('aria-label')).toBe('Dark');
    expect(button.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('switches from dark to light', () => {
    const onChange = vi.fn();
    render(<ThemeModeToggle theme="dark" onChange={onChange} />);

    const button = screen.getByTestId('theme-mode-toggle');
    expect(button.getAttribute('aria-label')).toBe('Light');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith('light');
  });
});
