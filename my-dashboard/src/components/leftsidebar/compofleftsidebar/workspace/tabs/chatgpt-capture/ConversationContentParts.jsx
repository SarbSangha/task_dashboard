import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ChatAttachmentGallery from '../../../../../common/chat/ChatAttachmentGallery';
import { sanitizeResponseText, toGalleryAttachment, toGalleryMediaAsset } from './chatgptCaptureUtils';

/**
 * Renders an assistant message's contentParts (see CAPTURE_CONTRACT.md
 * response_completed.contentParts) in true document order - markdown and
 * image parts interleaved exactly as ChatGPT produced them, instead of the
 * older "all text, then all images appended below" layout. Falls back
 * silently for any part type this doesn't explicitly know about, rather than
 * dropping it (Data Integrity philosophy already established in
 * ConversationChatView.jsx).
 *
 * An `image` part references ChatGPT's internal `assetPointer` file id. The
 * contract's intended lookup (a `kind:"output"` attachment upload keyed by
 * that file id) isn't wired up, so `imagesByFileId` is normally empty. The
 * same generated image IS captured on the separate media-asset path (the one
 * the Generation Workspace renders); `mediaAssets` carries that turn's
 * matched assets, and image parts that don't resolve via `imagesByFileId`
 * consume them positionally so the picture shows inline in the transcript,
 * not just up in the workspace panel.
 *
 * ChatGPT does not always emit an `image` contentPart for images it produced:
 * a web-image / carousel turn puts an `image_group` reference *inside* the
 * markdown text (a private-use-area marker sanitizeResponseText strips) with
 * no structured part at all, yet the media-asset path still captures the
 * pictures. So any matched `mediaAssets` left unconsumed by an explicit image
 * part are rendered together at the end.
 */
function isMarkdownPart(part) {
  return part && (part.type === 'markdown' || (!part.type && typeof part.text === 'string'));
}

export default function ConversationContentParts({ parts, imagesByFileId, mediaAssets = [] }) {
  if (!Array.isArray(parts) || !parts.length) return null;

  // Resolve each image part up front: a stored output attachment if one
  // matches its file id, else the next unconsumed media asset for this turn,
  // else nothing (render the "not yet uploaded" note).
  const resolvedImageByIndex = new Map();
  let mediaCursor = 0;
  parts.forEach((part, index) => {
    if (!part || part.type !== 'image') return;
    // Real asset pointers use various schemes ("file-service://", "sediment://",
    // ...); the stored-attachment file id is the bare tail.
    const fileId = `${part.assetPointer || ''}`.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').trim();
    const stored = imagesByFileId?.get(fileId);
    if (stored) {
      resolvedImageByIndex.set(index, { kind: 'stored', item: stored });
      return;
    }
    if (mediaCursor < mediaAssets.length) {
      resolvedImageByIndex.set(index, { kind: 'media', item: mediaAssets[mediaCursor] });
      mediaCursor += 1;
    }
  });

  const trailingMedia = mediaAssets.slice(mediaCursor);

  return (
    <div className="chatgpt-capture-content-parts">
      {parts.map((part, index) => {
        if (isMarkdownPart(part)) {
          const text = sanitizeResponseText(part.text);
          if (!text) return null;
          return (
            <div key={index} className="chatgpt-capture-markdown">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
            </div>
          );
        }

        if (part.type === 'image') {
          const resolved = resolvedImageByIndex.get(index);
          if (resolved) {
            const attachment = resolved.kind === 'stored'
              ? toGalleryAttachment(resolved.item)
              : toGalleryMediaAsset(resolved.item);
            return (
              <div key={index} className="chatgpt-capture-chat-media">
                <ChatAttachmentGallery attachments={[attachment]} />
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

      {trailingMedia.length > 0 && (
        <div className="chatgpt-capture-chat-media">
          <ChatAttachmentGallery attachments={trailingMedia.map(toGalleryMediaAsset)} />
        </div>
      )}
    </div>
  );
}
