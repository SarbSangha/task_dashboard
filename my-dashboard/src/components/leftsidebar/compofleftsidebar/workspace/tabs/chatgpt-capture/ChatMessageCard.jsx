import { useMemo, useState } from 'react';
import ChatAttachmentGallery from '../../../../../common/chat/ChatAttachmentGallery';
import ConversationContentParts from './ConversationContentParts';
import EventDetailPanel from './EventDetailPanel';
import MessageHeader from './MessageHeader';
import MarkdownRenderer from './MarkdownRenderer';
import { matchStoredAttachments, sanitizeResponseText, toGalleryAttachment, toGalleryMediaAsset } from './chatgptCaptureUtils';

function AttachmentSection({ label, icon, attachments }) {
  if (!attachments.length) return null;
  return (
    <div className="chatgpt-capture-chat-media">
      <span className="chatgpt-capture-chat-media-label">{icon} {label}</span>
      <ChatAttachmentGallery attachments={attachments.map(toGalleryAttachment)} />
    </div>
  );
}

export default function ChatMessageCard({ message, eventsById, storedAttachments, media, conversationModel, onOpenWorkspace }) {
  const [expanded, setExpanded] = useState(false);
  const isAssistant = message.role === 'assistant';
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

  // The assistant's TEXT response can fail to capture (e.g. an image-edit
  // turn ChatGPT authors via a "tool" role the SSE parser doesn't recognize
  // as the visible answer - see content-chatgpt-network.js's
  // isVisibleResponseMessage) even when the generated IMAGE for that same
  // turn was independently captured via the DOM media-scan path
  // (content-chatgpt-media-capture.js -> ConversationMediaAsset). Those two
  // capture paths write to different tables and previously never got
  // reunited here - the image only ever showed up in the separate
  // Generation Workspace panel above the transcript, while the message
  // bubble itself showed a bare "Response was not captured", even though a
  // real result existed. Matching by providerMessageId (the actual ChatGPT
  // message id, not this app's synthetic row id) is the same correlation
  // mediaHelpers.buildGenerations already uses for the Generation Workspace
  // cards, applied here per-message instead of per-conversation.
  const matchedMedia = useMemo(
    () => (
      isAssistant && message.providerMessageId
        ? (media || []).filter((item) => item.assistantMessageId === message.providerMessageId && item.url)
        : []
    ),
    [isAssistant, media, message.providerMessageId]
  );
  const hasMatchedMedia = matchedMedia.length > 0;

  const displayText = isAssistant ? sanitizeResponseText(message.text) : message.text;
  const notCaptured = !message.pending && !hasContentParts && !displayText && !hasMatchedMedia;
  const textMissingButHasMedia = !message.pending && !hasContentParts && !displayText && hasMatchedMedia;
  const status = isAssistant
    ? (notCaptured
      ? { tone: 'error', label: 'Not captured' }
      : textMissingButHasMedia
        ? { tone: 'warning', label: 'Image only' }
        : { tone: 'success', label: 'Completed' })
    : null;
  const showWorkspaceLink = isAssistant && onOpenWorkspace && (matchedImages.length > 0 || contentPartsHaveImage);

  return (
    <div className={`cgpt-msg role-${message.role}`}>
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
          ) : hasMatchedMedia ? (
            <>
              <span className="chatgpt-capture-chat-pending tone-warning">
                Response text was not captured — showing the generated image only.
              </span>
              <ChatAttachmentGallery attachments={matchedMedia.map(toGalleryMediaAsset)} />
            </>
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

      <MessageHeader
        role={message.role}
        model={conversationModel}
        timestamp={message.timestamp}
        edited={message.edited}
        status={status}
      />

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
