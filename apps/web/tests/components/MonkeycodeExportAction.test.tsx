// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { MonkeycodeExportAction } from '../../src/components/MonkeycodeExportAction';

afterEach(cleanup);

describe('MonkeycodeExportAction', () => {
  it('renders as a visible header action', () => {
    render(
      <I18nProvider initial="zh-CN">
        <MonkeycodeExportAction projectId="project-1" filePath="index.html" variant="header" />
      </I18nProvider>,
    );

    const button = screen.getByTestId('chrome-monkeycode-button');
    expect(button).toHaveTextContent('导入到 MonkeyCode 开发');
    expect(button.className).toContain('chrome-action');
  });
});
