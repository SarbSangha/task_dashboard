import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatAttachmentGallery from '../../../../../common/chat/ChatAttachmentGallery';
import { sanitizeResponseText, toGalleryAttachment } from './chatgptCaptureUtils';

/**
 * Renders an assistant message's contentParts (see CAPTURE_CONTRACT.md
 * response_completed.contentParts) in true document order - markdown and
 * image parts interleaved exactly as ChatGPT produced them, instead of the
 * older "all text, then all images appended below" layout. Falls back
 * silently for any part type this doesn't explicitly know about, rather than
 * dropping it (Data Integrity philosophy already established in
 * ConversationChatView.jsx).
 */
export default function ConversationContentParts({ parts, imagesByFileId }) {
  if (!Array.isArray(parts) || !parts.length) return null;

  return (
    <div className="chatgpt-capture-content-parts">
      {parts.map((part, index) => {
        if (part.type === 'markdown') {
          const text = sanitizeResponseText(part.text);
          if (!text) return null;
          return (
            <div key={index} className="chatgpt-capture-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          );
        }

        if (part.type === 'image') {
          const fileId = `${part.assetPointer || ''}`.replace(/^file-service:\/\//, '');
          const matched = imagesByFileId?.get(fileId);
          if (matched) {
            return (
              <div key={index} className="chatgpt-capture-chat-media">
                <ChatAttachmentGallery attachments={[toGalleryAttachment(matched)]} />
              </div>
            );
          }
          return (
            <span key={index} className="chatgpt-capture-badge tone-warning">
              🎨 Generated image — not yet uploaded to Capture Center.
            </span>
          );
        }

        return (
          <span key={index} className="chatgpt-capture-badge tone-muted">
            📎 Unrecognized content part (type: {part.type || 'unknown'})
          </span>
        );
      })}
    </div>
  );
}
