// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useEffect, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import type { ChatMessage } from '../../src/types';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({ locale: 'en', t: (key: string) => key }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/components/ChatComposer', () => ({
  ChatComposer: forwardRef((props: {
    leadingAccessory?: ReactNode;
    onPendingContentChange?: (pending: boolean) => void;
  }, _ref) => {
    useEffect(() => {
      props.onPendingContentChange?.(false);
    }, [props.onPendingContentChange]);
    return <div>{props.leadingAccessory}<button onClick={() => props.onPendingContentChange?.(true)}>Stage attachment</button></div>;
  }),
}));

vi.mock('../../src/components/AssistantMessage', () => ({
  AssistantMessage: () => <div>Assistant response</div>,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const messages = [{ id: 'message-1', role: 'user', content: 'Hello' }] as ChatMessage[];

function renderPane(onNewConversation: () => void, overrides: Record<string, unknown> = {}) {
  return render(
    <ChatPane
      messages={messages}
      streaming={false}
      error={null}
      projectId="project-1"
      projectFiles={[]}
      onEnsureProject={async () => 'project-1'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onNewConversation={onNewConversation}
      conversations={[]}
      activeConversationId="conversation-1"
      messagesConversationId="conversation-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      {...overrides}
    />,
  );
}

describe('ChatPane reset conversation', () => {
  it('renders beside the composer controls and starts a new conversation', () => {
    const create = vi.fn();
    renderPane(create);
    const reset = screen.getByTestId('chat-composer-new-conversation');
    expect(reset.getAttribute('aria-label')).toBe('chat.resetConversation');
    expect(reset.getAttribute('title')).toBe('chat.resetConversationHint');
    fireEvent.click(reset);
    expect(create).toHaveBeenCalledOnce();
  });

  it('blocks reset and history creation while a run or unsent content is present', () => {
    const create = vi.fn();
    renderPane(create, { streaming: true });
    const reset = screen.getByTestId('chat-composer-new-conversation');
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(reset);
    expect(create).not.toHaveBeenCalled();
    cleanup();
    renderPane(create);
    fireEvent.click(screen.getByText('Stage attachment'));
    expect((screen.getByTestId('chat-composer-new-conversation') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('conversation-history-trigger'));
    expect((screen.getByTestId('conversation-history-new') as HTMLButtonElement).disabled).toBe(true);
  });

  it('blocks reset when the current conversation is already empty or has queued messages', () => {
    const create = vi.fn();
    renderPane(create, { messages: [], queuedItems: [] });
    expect((screen.getByTestId('chat-composer-new-conversation') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    renderPane(create, { queuedItems: [{ id: 'queued-1', prompt: 'Send later', attachments: [], commentAttachments: [] }] });
    expect((screen.getByTestId('chat-composer-new-conversation') as HTMLButtonElement).disabled).toBe(true);
  });
});
