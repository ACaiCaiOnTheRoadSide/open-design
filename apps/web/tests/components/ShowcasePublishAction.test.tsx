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
    expect(await screen.findByText('发布到案例墙')).toBeTruthy();
    expect(onPublish).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('继续发布'));
    await waitFor(() => expect(onPublish).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('已交给 AI 发布,请在对话里填写发布信息。')).toBeTruthy();
  });
});
