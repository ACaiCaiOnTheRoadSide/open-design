// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LanguageMenu } from '../../src/components/LanguageMenu';
import { I18nProvider, LOCALES } from '../../src/i18n';

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.lang = 'en';
  document.documentElement.dir = 'ltr';
});

describe('LanguageMenu', () => {
  it('exposes every locale and switches the interface immediately', () => {
    render(
      <I18nProvider initial="en">
        <LanguageMenu compact placement="down" align="end" />
      </I18nProvider>,
    );

    const trigger = screen.getByRole('button', { name: 'English' });
    fireEvent.click(trigger);

    expect(screen.getAllByRole('menuitemradio')).toHaveLength(LOCALES.length);
    fireEvent.click(screen.getByRole('menuitemradio', { name: /简体中文/ }));

    expect(document.documentElement.lang).toBe('zh-CN');
    expect(screen.queryByRole('menuitemradio')).toBeNull();
    expect(screen.getByRole('button', { name: '简体中文' })).toBeTruthy();
  });
});
