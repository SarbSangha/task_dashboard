import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ChatAttachmentGallery from '../../../../../common/chat/ChatAttachmentGallery';
import EventDetailPanel from './EventDetailPanel';
import {
  formatRelativeTime,
  matchStoredAttachments,
  sanitizeResponseText,
  toGalleryAttachment,
} from './chatgptCaptureUtils';

const ROLE_META = {
  user: { icon: '👤', label: null },
  assistant: { icon: '🤖', label: 'ChatGPT' },
  system: { icon: '📎', label: 'System' },
};

function AttachmentSection({ label, icon, attachments }) {
  if (!attachments.length) return null;
  return (
    <div className="chatgpt-capture-chat-media">
      <span className="chatgpt-capture-chat-media-label">{icon} {label}</span>
      <ChatAttachmentGallery attachments={attachments.map(toGalleryAttachment)} />
    </div>
  );
}

function ChatMessage({ message, ownerName, eventsById, storedAttachments }) {
  const [expanded, setExpanded] = useState(false);
  const roleMeta = ROLE_META[message.role] || ROLE_META.system;
  const displayName = message.role === 'user' ? (ownerName || 'User') : (roleMeta.label || message.model || 'ChatGPT');
  const sourceEvents = (message.sourceEventIds || []).map((id) => eventsById.get(id)).filter(Boolean);

  // Real, previewable files (matched by filename against what was actually
  // uploaded to R2 - see chatgptCaptureUtils.matchStoredAttachments) vs.
  // placeholders the network layer observed a filename for but never got
  // bytes for (a file type the DOM capture doesn't handle yet, or the
  // upload failed - best-effort, not lossless, see
  // content-chatgpt-attachment-capture.js).
  const kind = message.role === 'assistant' ? 'output' : 'input';
  const matched = useMemo(
    () => matchStoredAttachments(message.attachments, storedAttachments).filter((item) => item.kind === kind),
    [message.attachments, storedAttachments, kind]
  );
  const matchedImages = useMemo(() => matched.filter((item) => (item.mimeType || '').startsWith('image/')), [matched]);
  const matchedFiles = useMemo(() => matched.filter((item) => !(item.mimeType || '').startsWith('image/')), [matched]);
  const matchedFileNames = useMemo(() => new Set(matched.map((item) => item.fileName)), [matched]);
  const unmatchedPlaceholders = (message.attachments || []).filter((item) => !matchedFileNames.has(item.label));

  const displayText = message.role === 'assistant' ? sanitizeResponseText(message.text) : message.text;

  return (
    <div className={`chatgpt-capture-chat-turn role-${message.role}`}>
      <div className="chatgpt-capture-chat-turn-head">
        <span className="chatgpt-capture-chat-turn-avatar" aria-hidden="true">{roleMeta.icon}</span>
        <span className="chatgpt-capture-chat-turn-role">{displayName}</span>
        {message.edited && <span className="chatgpt-capture-badge tone-warning">Edited</span>}
        <span className="chatgpt-capture-chat-turn-time">{formatRelativeTime(message.timestamp)}</span>
      </div>

      <div className="chatgpt-capture-chat-turn-body">
        {message.pending ? (
          <span className="chatgpt-capture-chat-pending">Waiting for response…</span>
        ) : displayText ? (
          message.role === 'assistant' ? (
            <div className="chatgpt-capture-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayText}</ReactMarkdown>
            </div>
          ) : (
            <p className="chatgpt-capture-plain-text">{displayText}</p>
          )
        ) : (
          // Data Integrity: never hide a genuine capture gap behind an empty
          // bubble - an assistant turn that exists (this message was built
          // from a real response_started/response_completed event) but has
          // no text means the capture failed for this specific turn, and
          // that should be visible, not silently blank.
          <span className="chatgpt-capture-chat-pending tone-warning">
            {message.role === 'assistant' ? 'Response was not captured.' : '(empty)'}
          </span>
        )}
      </div>

      <AttachmentSection label={kind === 'output' ? 'Generated Images' : 'Input Images'} icon={kind === 'output' ? '🎨' : '📷'} attachments={matchedImages} />
      <AttachmentSection label="Files" icon="📄" attachments={matchedFiles} />

      {unmatchedPlaceholders.length > 0 && (
        <div className="chatgpt-capture-chat-attachments">
          {unmatchedPlaceholders.map((attachment, index) => (
            <span key={`${attachment.kind}-${index}`} className="chatgpt-capture-badge tone-warning">
              {attachment.kind === 'image' ? '🖼️' : '📄'} {attachment.label} - uploaded but not associated with this message.
            </span>
          ))}
        </div>
      )}

      {sourceEvents.length > 0 && (
        <>
          <button
            type="button"
            className="chatgpt-capture-chat-turn-expand"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide developer details ▲' : 'Developer details ▼'}
          </button>

          {expanded && (
            <div className="chatgpt-capture-chat-turn-dev">
              {sourceEvents.map((event) => (
                <EventDetailPanel key={event.id} event={event} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default function ConversationChatView({
  messages,
  eventsById,
  storedAttachments,
  ownerName,
  loading,
  error,
  truncated,
  totalEvents,
}) {
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
    <div className="chatgpt-capture-chat-view">
      {truncated && (
        <p className="chatgpt-capture-inline-note">
          Showing the most recent messages from {totalEvents} captured events for this conversation.
        </p>
      )}

      {(!messages || messages.length === 0) ? (
        <div className="chatgpt-capture-empty-state compact">
          <strong>No chat content captured yet</strong>
          <p>This conversation has lifecycle events (open/rename/etc.) but no prompt or response text yet. Check the Raw Events tab to see everything captured.</p>
        </div>
      ) : (
        <div className="chatgpt-capture-chat-turns">
          {messages.map((message) => (
            <ChatMessage
              key={message.id}
              message={message}
              ownerName={ownerName}
              eventsById={eventsById}
              storedAttachments={storedAttachments}
            />
          ))}
        </div>
      )}
    </div>
  );
}
