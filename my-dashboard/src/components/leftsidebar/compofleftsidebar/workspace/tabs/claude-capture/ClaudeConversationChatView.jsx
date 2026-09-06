import { useMemo } from 'react';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ClaudeMessageCard from './ClaudeMessageCard';
import { formatDayLabel } from './claudeCaptureUtils';

// Local copy of chatgpt-capture/ConversationChatView.jsx's day-grouping
// shell, rendering ClaudeMessageCard instead of ChatMessageCard (no
// Generation Workspace link - Claude capture has no generated-output-asset
// layer, see CAPTURE_CONTRACT.md's known-gaps; INPUT file attachments are
// captured and rendered via storedAttachments below).
export default function ClaudeConversationChatView({ messages, storedAttachments, conversationModel, loading, error }) {
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
      {(!messages || messages.length === 0) ? (
        <div className="chatgpt-capture-empty-state compact">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">💬</span>
          <strong>No messages captured</strong>
          <p>
            Only lifecycle activity (opened/renamed) was recorded for this conversation - no
            prompt or response was sent while capture was running.
          </p>
        </div>
      ) : (
        <div className="cgpt-chat-column">
          {groups.map((group) => (
            <section key={`${group.label}-${group.messages[0]?.id}`} className="cgpt-chat-daygroup">
              <div className="cgpt-chat-daydivider"><span>{group.label}</span></div>
              {group.messages.map((message) => (
                <ClaudeMessageCard
                  key={message.id}
                  message={message}
                  storedAttachments={storedAttachments}
                  conversationModel={conversationModel}
                />
              ))}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
