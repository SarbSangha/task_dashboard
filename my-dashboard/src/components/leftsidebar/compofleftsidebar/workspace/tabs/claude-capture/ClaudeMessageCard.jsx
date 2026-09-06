import { useMemo, useState } from 'react';
import ChatAttachmentGallery from '../../../../../common/chat/ChatAttachmentGallery';
import JsonViewer from './JsonViewer';
import MessageHeader from './MessageHeader';
import MarkdownRenderer from './MarkdownRenderer';
import { matchStoredAttachments, toGalleryAttachment } from './claudeCaptureUtils';

// Claude's own contentParts (see backend providers/claude/CAPTURE_CONTRACT.md)
// interleave plain markdown text with non-text blocks (tool_use, thinking,
// artifact references, ...) this UI doesn't render specially yet - each
// "attachment"-type part is shown as a small collapsed raw-JSON badge rather
// than silently dropped, same lossless-capture-deserves-lossless-display
// posture as chatgpt-capture/ConversationContentParts.jsx's own "attachment"
// part handling.
function OtherContentPart({ part, index }) {
  const [open, setOpen] = useState(false);
  const kind = part?.raw?.type || 'content';
  return (
    <div className="chatgpt-capture-chat-attachments" style={{ marginTop: open ? 4 : 0 }}>
      <button
        type="button"
        className="chatgpt-capture-badge tone-warning"
        onClick={() => setOpen((prev) => !prev)}
        style={{ cursor: 'pointer' }}
      >
        {open ? '▾' : '▸'} {kind} block (not rendered)
      </button>
      {open && <JsonViewer data={part} label={`Part ${index}`} />}
    </div>
  );
}

// Renders message.contentParts in order - Claude's own turn ordering,
// interleaving markdown text and any other block types found in the wire
// payload. Falls back to plain message.text (used when contentParts is
// absent - always true for human/prompt messages, which have no
// contentParts field at all) below in the caller.
function ContentParts({ parts }) {
  return (
    <>
      {parts.map((part, index) => {
        if (part?.type === 'markdown') {
          return <MarkdownRenderer key={index}>{part.text || ''}</MarkdownRenderer>;
        }
        return <OtherContentPart key={index} part={part} index={index} />;
      })}
    </>
  );
}

export default function ClaudeMessageCard({ message, storedAttachments, conversationModel }) {
  const [expanded, setExpanded] = useState(false);
  const isAssistant = message.role === 'assistant';
  const cssRole = isAssistant ? 'assistant' : 'user';

  const hasContentParts = Array.isArray(message.contentParts) && message.contentParts.length > 0;
  const displayText = message.text || '';
  const notCaptured = !hasContentParts && !displayText;

  const status = isAssistant
    ? (notCaptured ? { tone: 'error', label: 'Not captured' } : { tone: 'success', label: 'Completed' })
    : null;

  // Real captured bytes (image, PDF, etc a prompt was submitted with - see
  // backend providers/claude/attachments.py) matched by Claude's own file
  // uuid, rendered through the same gallery/lightbox every other capture
  // tab already uses. message.attachments (pasted text/large snippets, no
  // downloadable bytes ever) and any message.files entry whose capture
  // hasn't landed yet (or failed - best-effort, not lossless) still show as
  // plain badges below, same as before.
  const matchedFiles = useMemo(
    () => matchStoredAttachments(message.files, storedAttachments),
    [message.files, storedAttachments]
  );
  const matchedFileNames = useMemo(() => new Set(matchedFiles.map((item) => item.fileName)), [matchedFiles]);
  const unmatchedFiles = (message.files || []).filter((item) => !item.uuid || !matchedFileNames.has(item.uuid));

  const rawAttachments = [
    ...(message.attachments || []).map((item) => ({ ...item, kind: 'attachment' })),
    ...unmatchedFiles.map((item) => ({ ...item, kind: 'file' })),
  ];

  return (
    <div className={`cgpt-msg role-${cssRole}`}>
      <div className="cgpt-msg-bubble">
        <div className="cgpt-msg-body">
          {hasContentParts ? (
            <ContentParts parts={message.contentParts} />
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

          {matchedFiles.length > 0 && (
            <div className="chatgpt-capture-chat-media">
              <span className="chatgpt-capture-chat-media-label">📎 Attached files</span>
              <ChatAttachmentGallery attachments={matchedFiles.map(toGalleryAttachment)} />
            </div>
          )}

          {rawAttachments.length > 0 && (
            <div className="chatgpt-capture-chat-attachments">
              {rawAttachments.map((attachment, index) => (
                <span key={`${attachment.kind}-${index}`} className="chatgpt-capture-badge">
                  {attachment.kind === 'attachment' ? '📎' : '📄'} {attachment.name || attachment.mimeType || 'attachment'}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>

      <MessageHeader role={message.role} model={conversationModel} timestamp={message.timestamp} status={status} />

      {(message.codeBlocks?.length > 0 || message.citations?.length > 0 || message.providerMessageId) && (
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
              <JsonViewer data={message} label="Raw message" collapsedByDefault />
            </div>
          )}
        </>
      )}
    </div>
  );
}
