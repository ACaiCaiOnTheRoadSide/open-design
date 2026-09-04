// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { MonkeycodeExportAction } from '../../src/components/MonkeycodeExportAction';

const handoff = vi.hoisted(() => ({
  buildMonkeycodeTaskUrl: vi.fn((prompt: string) => `https://mc.example.com/console/tasks#od-task=${encodeURIComponent(prompt)}`),
  ensureSiteConfig: vi.fn().mockResolvedValue(undefined),
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../src/runtime/monkeycode', () => ({
  buildMonkeycodeTaskUrl: handoff.buildMonkeycodeTaskUrl,
  ensureSiteConfig: handoff.ensureSiteConfig,
}));

vi.mock('../../src/lib/copy-to-clipboard', () => ({
  copyToClipboard: handoff.copyToClipboard,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  handoff.buildMonkeycodeTaskUrl.mockClear();
  handoff.ensureSiteConfig.mockClear();
  handoff.copyToClipboard.mockClear();
});

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

  it('opens MonkeyCode directly with the authenticated project archive URL in the prompt', async () => {
    const replace = vi.fn();
    const popup = {
      opener: window,
      location: { replace },
      close: vi.fn(),
    };
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    render(
      <I18nProvider initial="zh-CN">
        <MonkeycodeExportAction projectId="project / 1" filePath="screens/index.html" variant="header" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('chrome-monkeycode-button'));

    expect(open).toHaveBeenCalledWith('about:blank', '_blank');
    expect(popup.opener).toBeNull();
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));

    const prompt = handoff.buildMonkeycodeTaskUrl.mock.calls[0]?.[0];
    expect(prompt).toContain('请下载以下设计产物 ZIP 包并用于当前任务：');
    expect(prompt).toContain('http://localhost:3000/api/projects/project%20%2F%201/archive?root=screens');
    expect(handoff.copyToClipboard).toHaveBeenCalledWith(prompt);
    expect(replace).toHaveBeenCalledWith(expect.stringContaining('https://mc.example.com/console/tasks#od-task='));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.queryByText('确认开发提示词')).not.toBeInTheDocument();
  });
});
