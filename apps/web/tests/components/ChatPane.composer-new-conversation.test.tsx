// @vitest-environment jsdom

// The composer-bar new-conversation button: ChatPane composes it into
// ChatComposer's leadingAccessory slot (immediately right of the "+" menu),
// wired to the same onNewConversation handler and newConversationDisabled
// flag as the header "+" and the history menu's "New" entry.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const trackComposerBarClickMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/i18n', () => ({
  useT: () => (key: string) => key,
}));

// Render the leadingAccessory slot so the button under test shows up, and
// surface onPendingContentChange so tests can simulate staged content; the
// rest of the composer is irrelevant here.
vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef(
    (
      {
        leadingAccessory,
        onPendingContentChange,
      }: {
        leadingAccessory?: ReactNode;
        onPendingContentChange?: (hasPendingContent: boolean) => void;
      },
      _ref,
    ) => (
      <div data-testid="composer">
        {leadingAccessory}
        <button
          data-testid="mock-stage-content"
          onClick={() => onPendingContentChange?.(true)}
        />
      </div>
    ),
  ),
}));

vi.mock('../../src/analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/events')>();
  return {
    ...actual,
    trackComposerBarClick: trackComposerBarClickMock,
  };
});

import { ChatPane } from '../../src/components/ChatPane';

function renderChatPane(overrides: Partial<Parameters<typeof ChatPane>[0]> = {}) {
  return render(
    <ChatPane
      messages={[]}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      conversations={[]}
      activeConversationId={null}
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      {...overrides}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ChatPane composer new-conversation button', () => {
  it('stays hidden when no onNewConversation handler is wired', () => {
    renderChatPane();
    expect(screen.queryByTestId('chat-composer-new-conversation')).toBeNull();
  });

  it('routes the click to onNewConversation and tracks it as new_chat', () => {
    const onNewConversation = vi.fn();
    renderChatPane({ onNewConversation });
    fireEvent.click(screen.getByTestId('chat-composer-new-conversation'));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(trackComposerBarClickMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        element: 'new_chat',
        area: 'chat_composer',
        project_id: 'project-1',
      }),
    );
  });

  it('does not fire the handler or analytics while disabled', () => {
    const onNewConversation = vi.fn();
    renderChatPane({ onNewConversation, newConversationDisabled: true });
    const button = screen.getByTestId<HTMLButtonElement>('chat-composer-new-conversation');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onNewConversation).not.toHaveBeenCalled();
    expect(trackComposerBarClickMock).not.toHaveBeenCalled();
  });

  it('blocks while the composer reports unsent staged content', () => {
    const onNewConversation = vi.fn();
    renderChatPane({ onNewConversation });
    const button = screen.getByTestId<HTMLButtonElement>('chat-composer-new-conversation');
    expect(button.disabled).toBe(false);
    fireEvent.click(screen.getByTestId('mock-stage-content'));
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onNewConversation).not.toHaveBeenCalled();
  });

  it('blocks while sends are queued behind the busy run', () => {
    const onNewConversation = vi.fn();
    renderChatPane({
      onNewConversation,
      queuedItems: [{ id: 'q-1', prompt: 'queued prompt' }],
    });
    const button = screen.getByTestId<HTMLButtonElement>('chat-composer-new-conversation');
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(onNewConversation).not.toHaveBeenCalled();
  });
});
