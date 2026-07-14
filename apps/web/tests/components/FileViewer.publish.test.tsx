// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFile } from '../../src/types';

import { FileViewer } from '../../src/components/FileViewer';

const SOURCE =
  '<!doctype html><html><head><title>季度业务汇报</title></head><body><h1>Hero</h1></body></html>';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('FileViewer showcase publish', () => {
  it('gates publish behind a host-rendered consent notice, then delegates with no metadata', async () => {
    const onPublishViaAgent = vi.fn(async () => true);

    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={SOURCE}
        onPublishViaAgent={onPublishViaAgent}
      />,
    );

    fireEvent.click(screen.getByTestId('chrome-publish-button'));

    // Consent is the HOST's job: publishing is public and effectively
    // irreversible, so the notice must render here rather than depend on the
    // model reproducing it. Nothing is delegated until the user accepts.
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    expect(within(dialog).getByText(/public showcase wall/)).toBeTruthy();
    expect(onPublishViaAgent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('chrome-publish-confirm'));

    await waitFor(() => expect(onPublishViaAgent).toHaveBeenCalledTimes(1));
    // No metadata: the agent gathers it with its own <question-form>.
    expect(onPublishViaAgent).toHaveBeenCalledWith();
    await waitFor(() => screen.getByText('Handed to the AI — answer the publish details in the chat.'));
  });

  it('tells the user the chat is busy when the agent declines', async () => {
    // handlePublishViaAgent returns false while a turn is streaming.
    const onPublishViaAgent = vi.fn(async () => false);

    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={SOURCE}
        onPublishViaAgent={onPublishViaAgent}
      />,
    );

    fireEvent.click(screen.getByTestId('chrome-publish-button'));
    fireEvent.click(await waitFor(() => screen.getByTestId('chrome-publish-confirm')));

    await waitFor(() => expect(onPublishViaAgent).toHaveBeenCalledTimes(1));
    // Must NOT claim success, and must not borrow the export copy.
    await waitFor(() => screen.getByText('The AI is busy — wait for the current turn to finish.'));
    expect(screen.queryByText(/Handed to the AI/)).toBeNull();
  });

  it('does not publish when the user cancels the consent dialog', async () => {
    const onPublishViaAgent = vi.fn(async () => true);

    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={SOURCE}
        onPublishViaAgent={onPublishViaAgent}
      />,
    );

    fireEvent.click(screen.getByTestId('chrome-publish-button'));
    const dialog = await waitFor(() => screen.getByRole('dialog'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(onPublishViaAgent).not.toHaveBeenCalled();
  });

  it('hides the publish button when the host wires no publish handler', () => {
    render(
      <FileViewer
        projectId="project-1"
        projectKind="prototype"
        file={htmlPreviewFile()}
        liveHtml={SOURCE}
      />,
    );

    expect(screen.queryByTestId('chrome-publish-button')).toBeNull();
  });
});

function htmlPreviewFile(): ProjectFile {
  return {
    name: 'preview.html',
    path: 'preview.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    mime: 'text/html',
    kind: 'html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Preview',
      entry: 'preview.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}
