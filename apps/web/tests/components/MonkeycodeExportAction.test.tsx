// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { MonkeycodeExportAction } from '../../src/components/MonkeycodeExportAction';
import { downloadProjectArchive } from '../../src/runtime/exports';

vi.mock('../../src/runtime/exports', () => ({
  archiveRootFromFilePath: (filePath: string) => filePath.split('/').slice(0, -1).join('/'),
  downloadProjectArchive: vi.fn().mockResolvedValue(true),
}));

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

  it('downloads the existing project ZIP before preparing the MonkeyCode task', async () => {
    render(
      <I18nProvider initial="zh-CN">
        <MonkeycodeExportAction projectId="project-1" filePath="screens/index.html" variant="header" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('chrome-monkeycode-button'));

    await waitFor(() => expect(downloadProjectArchive).toHaveBeenCalledWith({
      projectId: 'project-1',
      fallbackTitle: 'index.html',
      root: 'screens',
    }));
    expect(screen.getByText('请将刚刚下载的设计产物 ZIP 包上传到当前任务。', { exact: false }))
      .toBeInTheDocument();
  });
});
