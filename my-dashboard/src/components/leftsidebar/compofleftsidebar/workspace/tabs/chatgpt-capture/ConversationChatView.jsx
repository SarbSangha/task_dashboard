import { useMemo } from 'react';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ChatMessageCard from './ChatMessageCard';
import { formatDayLabel } from './chatgptCaptureUtils';

export default function ConversationChatView({
  messages,
  eventsById,
  storedAttachments,
  ownerName,
  conversationModel,
  onOpenWorkspace,
  loading,
  error,
  truncated,
  totalEvents,
}) {
  // Group consecutive messages by day for subtle time separators (Today /
  // Yesterday / date), so the timestamp context isn't repeated on every line.
  const groups = useMemo(() => {
    const result = [];
    let current = null;
    for (const message of messages || []) {
      const label = formatDayLabel(message.timestamp);
      if (!current || current.label !== label) {
        current = { label, messages: [] };
        result.push(current);
      }
      current.messages.push(message);
    }
    return result;
  }, [messages]);

  if (loading) {
    return (
      <div className="chatgpt-capture-chat-view" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="chatgpt-capture-chat-turn-skeleton">
            <SkeletonBlock width={28} height={28} rounded />
            <div style={{ flex: 1 }}>
              <SkeletonBlock width="30%" height={12} />
              <SkeletonBlock width="80%" height={14} style={{ marginTop: 8 }} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="chatgpt-capture-alert">{error}</div>;
  }

  return (
    <div className="chatgpt-capture-chat-view cgpt-chat-view">
      {truncated && (
        <p className="chatgpt-capture-inline-note">
          Showing the most recent messages from {totalEvents} captured events for this conversation.
        </p>
      )}

      {(!messages || messages.length === 0) ? (
        <div className="chatgpt-capture-empty-state compact">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">💬</span>
          <strong>No messages captured</strong>
          <p>Conversation data will appear here once prompts and responses are captured.</p>
        </div>
      ) : (
        <div className="cgpt-chat-column">
          {groups.map((group) => (
            <section key={`${group.label}-${group.messages[0]?.id}`} className="cgpt-chat-daygroup">
              <div className="cgpt-chat-daydivider"><span>{group.label}</span></div>
              {group.messages.map((message) => (
                <ChatMessageCard
                  key={message.id}
                  message={message}
                  ownerName={ownerName}
                  eventsById={eventsById}
                  storedAttachments={storedAttachments}
                  conversationModel={conversationModel}
                  onOpenWorkspace={onOpenWorkspace}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
