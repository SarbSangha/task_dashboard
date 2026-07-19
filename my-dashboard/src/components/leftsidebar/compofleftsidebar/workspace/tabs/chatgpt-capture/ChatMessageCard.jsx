import { useMemo, useState } from 'react';
import ChatAttachmentGallery from '../../../../../common/chat/ChatAttachmentGallery';
import ConversationContentParts from './ConversationContentParts';
import EventDetailPanel from './EventDetailPanel';
import MessageHeader from './MessageHeader';
import MarkdownRenderer from './MarkdownRenderer';
import { matchStoredAttachments, sanitizeResponseText, toGalleryAttachment } from './chatgptCaptureUtils';

function AttachmentSection({ label, icon, attachments }) {
  if (!attachments.length) return null;
  return (
    <div className="chatgpt-capture-chat-media">
      <span className="chatgpt-capture-chat-media-label">{icon} {label}</span>
      <ChatAttachmentGallery attachments={attachments.map(toGalleryAttachment)} />
    </div>
  );
}

export default function ChatMessageCard({ message, ownerName, eventsById, storedAttachments, conversationModel, onOpenWorkspace }) {
  const [expanded, setExpanded] = useState(false);
  const isUser = message.role === 'user';
  const isAssistant = message.role === 'assistant';
  const displayName = isUser ? (ownerName || 'User') : (isAssistant ? 'ChatGPT' : 'System');
  const sourceEvents = (message.sourceEventIds || []).map((id) => eventsById.get(id)).filter(Boolean);

  const kind = isAssistant ? 'output' : 'input';
  const matched = useMemo(
    () => matchStoredAttachments(message.attachments, storedAttachments).filter((item) => item.kind === kind),
    [message.attachments, storedAttachments, kind]
  );
  const matchedImages = useMemo(() => matched.filter((item) => (item.mimeType || '').startsWith('image/')), [matched]);
  const matchedFiles = useMemo(() => matched.filter((item) => !(item.mimeType || '').startsWith('image/')), [matched]);
  const matchedFileNames = useMemo(() => new Set(matched.map((item) => item.fileName)), [matched]);
  const unmatchedPlaceholders = (message.attachments || []).filter((item) => !matchedFileNames.has(item.label));

  const hasContentParts = Array.isArray(message.contentParts) && message.contentParts.length > 0;
  const contentPartsHaveImage = hasContentParts && message.contentParts.some((p) => p && p.type === 'image');
  const imagesByFileId = useMemo(() => {
    if (!hasContentParts) return null;
    const map = new Map();
    (storedAttachments || [])
      .filter((item) => item.kind === 'output')
      .forEach((item) => map.set(item.fileName, item));
    return map;
  }, [hasContentParts, storedAttachments]);

  const displayText = isAssistant ? sanitizeResponseText(message.text) : message.text;
  const notCaptured = !message.pending && !hasContentParts && !displayText;
  const status = isAssistant
    ? (notCaptured ? { tone: 'error', label: 'Not captured' } : { tone: 'success', label: 'Completed' })
    : null;
  const showWorkspaceLink = isAssistant && onOpenWorkspace && (matchedImages.length > 0 || contentPartsHaveImage);

  return (
    <div className={`cgpt-msg role-${message.role}`}>
      <MessageHeader
        role={message.role}
        displayName={displayName}
        model={conversationModel}
        timestamp={message.timestamp}
        edited={message.edited}
        status={status}
      />

      <div className="cgpt-msg-bubble">
        <div className="cgpt-msg-body">
          {message.pending ? (
            <span className="chatgpt-capture-chat-pending">Waiting for response…</span>
          ) : hasContentParts ? (
            <ConversationContentParts parts={message.contentParts} imagesByFileId={imagesByFileId} />
          ) : displayText ? (
            isAssistant ? (
              <MarkdownRenderer>{displayText}</MarkdownRenderer>
            ) : (
              <p className="chatgpt-capture-plain-text">{displayText}</p>
            )
          ) : (
            <span className="chatgpt-capture-chat-pending tone-warning">
              {isAssistant ? 'Response was not captured.' : '(empty)'}
            </span>
          )}

          {!hasContentParts && (
            <AttachmentSection label={kind === 'output' ? 'Generated Images' : 'Input Images'} icon={kind === 'output' ? '🎨' : '📷'} attachments={matchedImages} />
          )}
          <AttachmentSection label="Files" icon="📄" attachments={matchedFiles} />

          {showWorkspaceLink && (
            <button type="button" className="cgpt-msg-workspace-link" onClick={onOpenWorkspace}>
              🎨 Open Generation Workspace →
            </button>
          )}

          {unmatchedPlaceholders.length > 0 && (
            <div className="chatgpt-capture-chat-attachments">
              {unmatchedPlaceholders.map((attachment, index) => (
                <span key={`${attachment.kind}-${index}`} className="chatgpt-capture-badge tone-warning">
                  {attachment.kind === 'image' ? '🖼️' : '📄'} {attachment.label} - uploaded but not associated with this message.
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

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
