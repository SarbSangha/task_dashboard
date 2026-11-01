import { useEffect, useState } from 'react';
import { buildConversationPreview, formatListTimestamp } from './chatUtils';
import { IconChevronDown, IconPin, IconPinOff } from './chatIcons';

export default function PinnedMessagesBar({ pinned = [], threadKey, onJump, onUnpin }) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    setExpanded(false);
  }, [threadKey]);

  if (!pinned.length) return null;

  const latest = pinned[0];
  const previewOf = (message) => buildConversationPreview(message.message, message.attachments) || 'Message';

  return (
    <div className={`pinned-bar ${expanded ? 'is-expanded' : ''}`}>
      <button
        type="button"
        className="pinned-bar-summary"
        onClick={() => (pinned.length === 1 ? onJump(latest) : setExpanded((prev) => !prev))}
        aria-expanded={pinned.length > 1 ? expanded : undefined}
      >
        <span className="pinned-bar-icon"><IconPin size={14} /></span>
        <span className="pinned-bar-copy">
          <span className="pinned-bar-label">
            {pinned.length === 1 ? 'Pinned message' : `${pinned.length} pinned messages`}
          </span>
          <span className="pinned-bar-preview">
            <strong>{latest.senderName}:</strong> {previewOf(latest)}
          </span>
        </span>
        {pinned.length > 1 && <IconChevronDown size={16} className="pinned-bar-chevron" />}
      </button>
      {pinned.length === 1 && (
        <button
          type="button"
          className="pinned-bar-unpin pinned-bar-unpin--summary"
          onClick={() => onUnpin(latest)}
          title="Unpin"
          aria-label={`Unpin message from ${latest.senderName}`}
        >
          <IconPinOff size={14} />
        </button>
      )}

      {expanded && (
        <ul className="pinned-bar-list">
          {pinned.map((message) => (
            <li key={message.id} className="pinned-bar-item">
              <button type="button" className="pinned-bar-item-main" onClick={() => onJump(message)}>
                <span className="pinned-bar-item-top">
                  <strong>{message.senderName}</strong>
                  <time>{formatListTimestamp(message.createdAt)}</time>
                </span>
                <span className="pinned-bar-item-text">{previewOf(message)}</span>
                {message.pinnedBy?.name && <small>Pinned by {message.pinnedBy.name}</small>}
              </button>
              <button
                type="button"
                className="pinned-bar-unpin"
                onClick={() => onUnpin(message)}
                title="Unpin"
                aria-label={`Unpin message from ${message.senderName}`}
              >
                <IconPinOff size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
