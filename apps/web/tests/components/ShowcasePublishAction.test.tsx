// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialogHost } from '../../src/components/confirm-dialog-host';
import { ShowcasePublishAction } from '../../src/components/ShowcasePublishAction';
import { I18nProvider } from '../../src/i18n';

afterEach(cleanup);

describe('ShowcasePublishAction', () => {
  it('asks for public-publish consent before delegating', async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    render(
      <I18nProvider initial="zh-CN">
        <ConfirmDialogHost />
        <ShowcasePublishAction onPublish={onPublish} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('chrome-publish-button'));
    fireEvent.click(await screen.findByText('发布到 Showcase'));
    expect(await screen.findByText('发布到案例墙')).toBeTruthy();
    expect(onPublish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('继续发布'));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('已交给 AI 发布,请在对话里填写发布信息。')).toBeTruthy();
  });

  it('offers a private OhMyInspire template publish target', async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    const onPublishOhMyInspire = vi.fn().mockResolvedValue(true);
    render(
      <I18nProvider initial="zh-CN">
        <ConfirmDialogHost />
        <ShowcasePublishAction onPublish={onPublish} onPublishOhMyInspire={onPublishOhMyInspire} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('chrome-publish-button'));
    fireEvent.click(await screen.findByText('发布到 OhMyInspire'));
    expect(await screen.findByText('模板将保存到 OhMyInspire「我的模板」中，默认为草稿，之后可由你选择公开。')).toBeTruthy();
    fireEvent.click(screen.getByText('发布模板'));
    await waitFor(() => expect(onPublishOhMyInspire).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('已发布到 OhMyInspire「我的模板」')).toBeTruthy();
    expect(onPublish).not.toHaveBeenCalled();
  });

  it('surfaces an OhMyInspire publish failure reason', async () => {
    const onPublish = vi.fn().mockResolvedValue(true);
    const onPublishOhMyInspire = vi.fn().mockRejectedValue(new Error('integration is disabled'));
    render(
      <I18nProvider initial="zh-CN">
        <ConfirmDialogHost />
        <ShowcasePublishAction onPublish={onPublish} onPublishOhMyInspire={onPublishOhMyInspire} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('chrome-publish-button'));
    fireEvent.click(await screen.findByText('发布到 OhMyInspire'));
    fireEvent.click(await screen.findByText('发布模板'));

    expect(await screen.findByText('发布到 OhMyInspire 失败')).toBeTruthy();
    expect(screen.getByText('integration is disabled')).toBeTruthy();
  });
});
