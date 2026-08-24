// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { SideChatTab, type ActiveConversationChatState } from '../../src/components/workspace/SideChatTab';

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: (props: { sendDisabled?: boolean; onSelectDesignReference?: (text: string) => void }) => (
    <button
      type="button"
      disabled={props.sendDisabled}
      onClick={() => {
        props.onSelectDesignReference?.('[design reference selected — ref-1 — One]');
        props.onSelectDesignReference?.('[design reference selected — ref-1 — One]');
      }}
    >
      choose reference
    </button>
  ),
}));

vi.mock('../../src/components/workspace/useConversationChat', () => ({
  useConversationChat: () => ({
    messages: [], streaming: false, loading: false, sendDisabled: false, error: null,
    onSend: vi.fn(), onRetry: vi.fn(), onStop: vi.fn(),
  }),
}));

afterEach(() => cleanup());

function renderSideChat(chat: ActiveConversationChatState) {
  return render(
    <I18nProvider initial="en">
      <SideChatTab
        projectId="project-1"
        conversationId="conversation-1"
        config={DEFAULT_CONFIG}
        agentsById={new Map()}
        locale="en"
        projectFiles={[]}
        conversations={[{
          id: 'conversation-1', projectId: 'project-1', title: 'Chat',
          createdAt: 0, updatedAt: 0, messageCount: 0, sessionMode: 'design',
        }]}
        activeConversationChat={chat}
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        onRenameConversation={vi.fn()}
        onNewConversation={vi.fn()}
      />
    </I18nProvider>,
  );
}

describe('SideChatTab design reference submission gate', () => {
  it('coalesces duplicate selection callbacks into one send', () => {
    const onSend = vi.fn();
    renderSideChat({
      conversationId: 'conversation-1', messages: [], streaming: false,
      loading: false, sendDisabled: false, error: null, onSend, onStop: vi.fn(),
    });
    fireEvent.click(screen.getByRole('button', { name: 'choose reference' }));
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('does not send while streaming, loading, or explicitly disabled', () => {
    for (const busy of [
      { streaming: true, loading: false, sendDisabled: false },
      { streaming: false, loading: true, sendDisabled: false },
      { streaming: false, loading: false, sendDisabled: true },
    ]) {
      const onSend = vi.fn();
      const view = renderSideChat({
        conversationId: 'conversation-1', messages: [], error: null,
        ...busy, onSend, onStop: vi.fn(),
      });
      expect(screen.getByRole('button', { name: 'choose reference' })).toBeDisabled();
      expect(onSend).not.toHaveBeenCalled();
      view.unmount();
    }
  });
});
