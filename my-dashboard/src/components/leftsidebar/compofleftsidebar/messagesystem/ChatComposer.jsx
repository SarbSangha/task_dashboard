import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import EmojiPicker from './EmojiPicker';
import {
  IconCheck,
  IconClose,
  IconEdit,
  IconFolder,
  IconPaperclip,
  IconReply,
  IconSend,
  IconSmile,
} from './chatIcons';

const COMPOSER_MAX_HEIGHT_PX = 160;

const formatUploadSize = (bytes = 0) => {
  const safeBytes = Number.isFinite(bytes) ? Math.max(bytes, 0) : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

function AttachmentUploadStatus({ uploadState, onCancel }) {
  if (!uploadState?.active) return null;

  const fileLine = [
    uploadState.currentFileIndex > 0 ? `File ${uploadState.currentFileIndex} of ${uploadState.fileCount}` : '',
    uploadState.currentFileName,
  ].filter(Boolean).join(' · ');

  return (
    <div className="composer-upload" role="status" aria-live="polite">
      <div className="composer-upload-row">
        <div className="composer-upload-copy">
          <strong>Uploading {uploadState.fileCount} {uploadState.fileCount === 1 ? 'file' : 'files'}</strong>
          <span>{fileLine || 'Preparing upload…'}</span>
        </div>
        <span className="composer-upload-percent">{uploadState.percent}%</span>
        {onCancel && (
          <button type="button" className="composer-chip-btn" onClick={onCancel} aria-label="Cancel upload" title="Cancel upload">
            <IconClose size={13} />
          </button>
        )}
      </div>
      <div className="composer-upload-bar" aria-hidden="true">
        <span style={{ width: `${uploadState.percent}%` }} />
      </div>
      <small className="composer-upload-bytes">
        {formatUploadSize(uploadState.uploadedBytes)} of {formatUploadSize(uploadState.totalBytes)}
      </small>
    </div>
  );
}

export default function ChatComposer({
  attachments = [],
  canSend,
  disabled = false,
  editing = null,
  focusKey,
  getAttachmentLabel,
  onCancelEdit,
  onCancelReply,
  onCancelUpload,
  onChange,
  onPasteFiles,
  onPickFiles,
  onPickFolder,
  onRemoveAttachment,
  onSubmit,
  placeholder,
  replyingTo = null,
  sending = false,
  uploadState,
  uploading = false,
  value,
}) {
  const textareaRef = useRef(null);
  const emojiButtonRef = useRef(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const isEditing = Boolean(editing);

  useLayoutEffect(() => {
    const node = textareaRef.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, COMPOSER_MAX_HEIGHT_PX)}px`;
    node.style.overflowY = node.scrollHeight > COMPOSER_MAX_HEIGHT_PX ? 'auto' : 'hidden';
  }, [value]);

  useEffect(() => {
    if (disabled) return;
    const node = textareaRef.current;
    if (!node) return;
    // Opening a chat on a phone should not pop the keyboard; replies/edits still focus.
    const isTouch = window.matchMedia?.('(pointer: coarse)').matches;
    if (isTouch && !isEditing && !replyingTo) return;
    node.focus({ preventScroll: true });
    const end = node.value.length;
    node.setSelectionRange(end, end);
  }, [disabled, focusKey, isEditing, replyingTo?.messageId]);

  const closeEmojiPicker = useCallback(() => setShowEmojiPicker(false), []);

  const insertEmoji = (emoji) => {
    const node = textareaRef.current;
    const start = node?.selectionStart ?? value.length;
    const end = node?.selectionEnd ?? value.length;
    const nextValue = `${value.slice(0, start)}${emoji}${value.slice(end)}`;
    onChange(nextValue);
    setShowEmojiPicker(false);
    node?.focus({ preventScroll: true });
    window.requestAnimationFrame(() => {
      const caret = start + emoji.length;
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  };

  // Toolbar buttons must not steal focus from the textarea, otherwise the
  // next Space/Enter presses the button instead of typing.
  const keepTextareaFocus = (event) => event.preventDefault();

  const handleKeyDown = (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (canSend) onSubmit();
      return;
    }
    if (event.key === 'Escape') {
      if (isEditing) {
        event.preventDefault();
        onCancelEdit?.();
      } else if (replyingTo) {
        event.preventDefault();
        onCancelReply?.();
      }
    }
  };

  const handlePaste = (event) => {
    if (isEditing || !onPasteFiles) return;
    const files = Array.from(event.clipboardData?.files || []);
    if (!files.length) return;
    event.preventDefault();
    onPasteFiles(files);
  };

  return (
    <div className={`composer ${isEditing ? 'is-editing' : ''}`}>
      {isEditing && (
        <div className="composer-context composer-context--edit">
          <IconEdit size={15} />
          <div className="composer-context-copy">
            <strong>Editing message</strong>
            <span>{editing.originalText}</span>
          </div>
          <button type="button" className="composer-chip-btn" onClick={onCancelEdit} disabled={editing.saving} aria-label="Cancel edit" title="Cancel edit (Esc)">
            <IconClose size={13} />
          </button>
        </div>
      )}
      {!isEditing && replyingTo && (
        <div className="composer-context">
          <IconReply size={15} />
          <div className="composer-context-copy">
            <strong>Replying to {replyingTo.senderName}</strong>
            <span>{replyingTo.preview}</span>
          </div>
          <button type="button" className="composer-chip-btn" onClick={onCancelReply} aria-label="Cancel reply" title="Cancel reply (Esc)">
            <IconClose size={13} />
          </button>
        </div>
      )}
      {!isEditing && <AttachmentUploadStatus uploadState={uploadState} onCancel={onCancelUpload} />}
      {!isEditing && attachments.length > 0 && (
        <div className="composer-attachments">
          {attachments.map((attachment, index) => (
            <div key={`${attachment.path || attachment.url || attachment.filename}-${index}`} className="composer-attachment">
              <IconPaperclip size={12} />
              <span title={getAttachmentLabel(attachment)}>{getAttachmentLabel(attachment)}</span>
              <button type="button" onClick={() => onRemoveAttachment(index)} aria-label={`Remove ${getAttachmentLabel(attachment)}`}>
                <IconClose size={11} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="composer-box">
        <textarea
          ref={textareaRef}
          className="composer-input"
          rows={1}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
        />
        <div className="composer-toolbar">
          <div className="composer-tools">
            <button
              type="button"
              className="composer-tool"
              onClick={onPickFiles}
              disabled={disabled || uploading || isEditing}
              title="Attach files"
              aria-label="Attach files"
            >
              <IconPaperclip size={17} />
            </button>
            <button
              type="button"
              className="composer-tool composer-tool--folder"
              onClick={onPickFolder}
              disabled={disabled || uploading || isEditing}
              title="Attach a folder"
              aria-label="Attach a folder"
            >
              <IconFolder size={17} />
            </button>
            <div className="composer-emoji-anchor">
              <button
                ref={emojiButtonRef}
                type="button"
                className={`composer-tool ${showEmojiPicker ? 'is-active' : ''}`}
                onMouseDown={keepTextareaFocus}
                onClick={() => setShowEmojiPicker((prev) => !prev)}
                disabled={disabled}
                title="Emoji"
                aria-label="Insert emoji"
                aria-expanded={showEmojiPicker}
              >
                <IconSmile size={17} />
              </button>
              {showEmojiPicker && (
                <EmojiPicker anchorRef={emojiButtonRef} onClose={closeEmojiPicker} onSelect={insertEmoji} />
              )}
            </div>
            <span className="composer-hint" aria-hidden="true">
              <kbd>Enter</kbd> to {isEditing ? 'save' : 'send'} · <kbd>Shift</kbd>+<kbd>Enter</kbd> new line
            </span>
          </div>
          <button
            type="button"
            className="composer-send"
            onClick={onSubmit}
            disabled={!canSend}
            aria-label={isEditing ? 'Save changes' : 'Send message'}
            title={isEditing ? 'Save changes' : 'Send'}
          >
            {isEditing ? <IconCheck size={17} strokeWidth={2.2} /> : <IconSend size={16} className={sending ? 'is-sending' : ''} />}
          </button>
        </div>
      </div>
    </div>
  );
}
