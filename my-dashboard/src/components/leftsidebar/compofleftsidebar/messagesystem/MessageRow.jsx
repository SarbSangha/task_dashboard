import React, { useState } from 'react';
import ChatAttachmentGallery from '../../../common/chat/ChatAttachmentGallery';
import {
  QUICK_REACTIONS,
  buildAttachmentCountLabel,
  buildAvatarHue,
  buildInitials,
  buildMentionTokens,
  findMentionToken,
  formatMessageTime,
  linkifySegments,
} from './chatUtils';
import {
  IconCopy,
  IconEdit,
  IconForward,
  IconPin,
  IconPinOff,
  IconReply,
  IconSmile,
  IconTrash,
} from './chatIcons';

const escapeRegExp = (value = '') => `${value}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const renderLinkedText = (text, keyPrefix) =>
  linkifySegments(text).map((segment, index) => (
    segment.type === 'link' ? (
      <a
        key={`${keyPrefix}-${index}`}
        className="msg-link"
        href={segment.href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => event.stopPropagation()}
      >
        {segment.value}
      </a>
    ) : (
      <React.Fragment key={`${keyPrefix}-${index}`}>{segment.value}</React.Fragment>
    )
  ));

function MessageText({ currentUserId, mentions = [], text = '' }) {
  if (!text) return null;

  const tokenToMention = new Map();
  mentions.forEach((mention) => {
    buildMentionTokens(mention).forEach((token) => {
      if (token) tokenToMention.set(token, mention);
    });
  });

  if (!tokenToMention.size) {
    return <div className="msg-text">{renderLinkedText(text, 'plain')}</div>;
  }

  const tokenPattern = Array.from(tokenToMention.keys())
    .sort((left, right) => right.length - left.length)
    .map(escapeRegExp)
    .join('|');
  const mentionPattern = new RegExp(`@(${tokenPattern})(?=$|[^a-z0-9_-])`, 'gi');
  const nodes = [];
  let lastIndex = 0;
  let match;

  while ((match = mentionPattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(...renderLinkedText(text.slice(lastIndex, match.index), `t${lastIndex}`));
    }
    const mention = tokenToMention.get(findMentionToken(match[1]));
    nodes.push(
      <span
        key={`m${match.index}`}
        className={`msg-mention ${mention?.id === currentUserId ? 'is-me' : ''}`}
        title={mention?.name || match[0]}
      >
        {match[0]}
      </span>
    );
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(...renderLinkedText(text.slice(lastIndex), `t${lastIndex}`));
  }

  return <div className="msg-text">{nodes}</div>;
}

const getNames = (entries) =>
  (Array.isArray(entries) ? entries : []).map((entry) => entry?.name).filter(Boolean);

const getReceiptStatus = (message) => {
  if (message?.isOptimistic || message?.receipt?.status === 'sending') {
    return { status: 'sending', label: 'Sending…', tickCount: 1 };
  }

  const receipt = message?.receipt || {};
  const readByNames = getNames(receipt.readBy);
  const deliveredByNames = getNames(receipt.deliveredBy);
  if (receipt.status === 'read' || readByNames.length > 0) {
    return { status: 'read', label: readByNames.length ? `Seen by ${readByNames.join(', ')}` : 'Seen', tickCount: 2 };
  }
  if (receipt.status === 'delivered' || deliveredByNames.length > 0 || Number(receipt.deliveredCount) > 0) {
    return { status: 'delivered', label: deliveredByNames.length ? `Delivered to ${deliveredByNames.join(', ')}` : 'Delivered', tickCount: 2 };
  }
  return { status: 'sent', label: 'Sent', tickCount: 1 };
};

function ReceiptTicks({ message, mode, onOpenDetails }) {
  const receipt = getReceiptStatus(message);
  const ticks = (
    <span className={`msg-ticks msg-ticks--${receipt.status}`} aria-hidden="true">
      <svg viewBox="0 0 18 12" width="16" height="11">
        <path d={receipt.tickCount > 1 ? 'M1 6.5 4.5 10 11 2.5M7 9l1 1 6.5-7.5' : 'M3 6.5 6.5 10 13 2.5'} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );

  if (mode === 'group' && !message?.isOptimistic && typeof onOpenDetails === 'function') {
    return (
      <button
        type="button"
        className="msg-receipt-btn"
        title={`${receipt.label} · View message info`}
        aria-label={`${receipt.label}. View message info`}
        onClick={(event) => {
          event.stopPropagation();
          onOpenDetails(message.id);
        }}
      >
        {ticks}
      </button>
    );
  }

  return <span className="msg-receipt" title={receipt.label} role="img" aria-label={receipt.label}>{ticks}</span>;
}

function ToolbarButton({ label, onClick, danger = false, active = false, children }) {
  return (
    <button
      type="button"
      className={`msg-tool ${danger ? 'is-danger' : ''} ${active ? 'is-active' : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={label}
      aria-label={label}
    >
      {children}
    </button>
  );
}

const MessageRow = React.memo(function MessageRow({
  ariaAttributes,
  currentUserId,
  highlightedMessageId,
  index,
  isSelectionActive,
  items,
  mode,
  onCopyMessage,
  onDeleteMessage,
  onDiscardFailedMessage,
  onEditMessage,
  onOpenReceiptDetails,
  onReactToMessage,
  onReplyToMessage,
  onRetryFailedMessage,
  onTogglePin,
  selectedIds,
  style,
  toggleMessageSelection,
}) {
  const [showReactions, setShowReactions] = useState(false);
  // Touch screens have no hover, so a tap on the bubble reveals the toolbar.
  const [showTouchActions, setShowTouchActions] = useState(false);
  const item = items[index];
  if (!item) return null;

  if (item.type === 'separator') {
    return (
      <div {...ariaAttributes} style={style} className="msg-virtual-row">
        <div className="msg-day-divider"><span>{item.label}</span></div>
      </div>
    );
  }

  if (item.type === 'unread') {
    return (
      <div {...ariaAttributes} style={style} className="msg-virtual-row">
        <div className="msg-unread-divider" role="separator"><span>{item.label}</span></div>
      </div>
    );
  }

  const { message, isGroupStart, isGroupEnd } = item;
  const mine = Number(message.senderId) === Number(currentUserId);
  const isSelected = selectedIds.includes(message.id);
  const isDeleted = Boolean(message.deletedAt);
  const isFailed = Boolean(message.failed);
  const isPinned = Boolean(message.pinnedAt) && !isDeleted;
  const canAct = !message.isOptimistic && !isFailed && !isDeleted && !isSelectionActive;
  const timeLabel = formatMessageTime(message.createdAt);

  const rowClassName = [
    'msg-row',
    mine ? 'is-mine' : 'is-theirs',
    isGroupStart ? 'is-group-start' : 'is-continuation',
    isGroupEnd ? 'is-group-end' : '',
    isSelectionActive ? 'is-selecting' : '',
    isSelected ? 'is-selected' : '',
    highlightedMessageId === message.id ? 'is-highlighted' : '',
    showTouchActions ? 'is-touch-open' : '',
  ].filter(Boolean).join(' ');

  const bubbleClassName = [
    'msg-bubble',
    message.isOptimistic ? 'is-pending' : '',
    isFailed ? 'is-failed' : '',
    isDeleted ? 'is-deleted' : '',
    isPinned ? 'is-pinned' : '',
  ].filter(Boolean).join(' ');

  return (
    <div {...ariaAttributes} style={style} className="msg-virtual-row">
      <div
        className={rowClassName}
        onClick={isSelectionActive ? () => toggleMessageSelection(mode, message.id) : undefined}
        onMouseLeave={showReactions ? () => setShowReactions(false) : undefined}
        onBlur={(event) => {
          if (showTouchActions && !event.currentTarget.contains(event.relatedTarget)) {
            setShowTouchActions(false);
            setShowReactions(false);
          }
        }}
      >
        {isSelectionActive && (
          <button
            type="button"
            className={`msg-select ${isSelected ? 'is-selected' : ''}`}
            onClick={(event) => {
              event.stopPropagation();
              toggleMessageSelection(mode, message.id);
            }}
            aria-pressed={isSelected}
            aria-label={isSelected ? 'Deselect message' : 'Select message'}
          >
            {isSelected && (
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            )}
          </button>
        )}

        {!mine && (
          isGroupStart ? (
            <div
              className="person-avatar person-avatar--sm msg-avatar"
              style={{ '--avatar-hue': `${buildAvatarHue(message.senderName)}deg` }}
              aria-hidden="true"
            >
              {buildInitials(message.senderName)}
            </div>
          ) : (
            <span className="msg-avatar-spacer" aria-hidden="true" />
          )
        )}

        <div className="msg-stack">
          {isGroupStart && !mine && mode === 'group' && (
            <div className="msg-author">{message.senderName}</div>
          )}

          <div
            className={bubbleClassName}
            tabIndex={canAct ? -1 : undefined}
            onClick={canAct ? (event) => {
              if (event.target.closest('a, button, video, audio')) return;
              if (!window.matchMedia?.('(hover: none)').matches) return;
              setShowTouchActions((prev) => !prev);
            } : undefined}
          >
            {canAct && (
              <div className="msg-toolbar" role="toolbar" aria-label="Message actions" onClick={(event) => event.stopPropagation()}>
                {showReactions ? (
                  QUICK_REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      className={`msg-tool msg-tool--emoji ${message.myReaction === emoji ? 'is-active' : ''}`}
                      onClick={() => {
                        onReactToMessage(mode, message, emoji);
                        setShowReactions(false);
                      }}
                      aria-label={`React with ${emoji}`}
                    >
                      {emoji}
                    </button>
                  ))
                ) : (
                  <>
                    <ToolbarButton label="Add reaction" onClick={() => setShowReactions(true)}><IconSmile size={15} /></ToolbarButton>
                    <ToolbarButton label="Reply" onClick={() => onReplyToMessage(mode, message)}><IconReply size={15} /></ToolbarButton>
                    <ToolbarButton label={isPinned ? 'Unpin' : 'Pin'} active={isPinned} onClick={() => onTogglePin(mode, message)}>
                      {isPinned ? <IconPinOff size={15} /> : <IconPin size={15} />}
                    </ToolbarButton>
                    {!!message.message && (
                      <ToolbarButton label="Copy text" onClick={() => onCopyMessage(message)}><IconCopy size={15} /></ToolbarButton>
                    )}
                    {mine && <ToolbarButton label="Edit" onClick={() => onEditMessage(mode, message)}><IconEdit size={15} /></ToolbarButton>}
                    {mine && <ToolbarButton label="Delete" danger onClick={() => onDeleteMessage(mode, message)}><IconTrash size={15} /></ToolbarButton>}
                  </>
                )}
              </div>
            )}

            {isPinned && (
              <div className="msg-pinned-label">
                <IconPin size={11} />
                <span>Pinned{message.pinnedBy?.name ? ` by ${message.pinnedBy.name}` : ''}</span>
              </div>
            )}
            {!isDeleted && message.forwardMetadata && (
              <div className="msg-forwarded">
                <IconForward size={12} />
                <span>Forwarded from {message.forwardMetadata.sourceLabel || 'a chat'}</span>
              </div>
            )}
            {!isDeleted && message.replyTo && (
              <div className="msg-quote">
                <strong>{message.replyTo.senderName}</strong>
                <span>
                  {message.replyTo.deletedAt
                    ? 'This message was deleted'
                    : message.replyTo.message || buildAttachmentCountLabel(message.replyTo.attachments)}
                </span>
              </div>
            )}

            {isDeleted ? (
              <div className="msg-text msg-text--deleted">This message was deleted</div>
            ) : (
              <MessageText currentUserId={currentUserId} mentions={message.mentions} text={message.message} />
            )}

            {!isDeleted && !!message.attachments?.length && (
              <div className="msg-attachments">
                <ChatAttachmentGallery attachments={message.attachments} />
              </div>
            )}

            {isFailed && (
              <div className="msg-failed" onClick={(event) => event.stopPropagation()}>
                <span>Not sent</span>
                <button type="button" onClick={() => onRetryFailedMessage(mode, message)}>Retry</button>
                <button type="button" onClick={() => onDiscardFailedMessage(mode, message)}>Discard</button>
              </div>
            )}

            <div className="msg-meta">
              {message.editedAt && !isDeleted && <span className="msg-edited">edited</span>}
              <time dateTime={message.createdAt || undefined}>{timeLabel}</time>
              {mine && !isFailed && !isDeleted && (
                <ReceiptTicks message={message} mode={mode} onOpenDetails={onOpenReceiptDetails} />
              )}
            </div>
          </div>

          {!isDeleted && !!message.reactions?.length && (
            <div className="msg-reactions">
              {message.reactions.map((reaction) => {
                const names = (reaction.users || []).map((entry) => entry?.name).filter(Boolean);
                return (
                  <button
                    key={reaction.emoji}
                    type="button"
                    className={`msg-reaction ${message.myReaction === reaction.emoji ? 'is-mine' : ''}`}
                    title={names.length ? `${reaction.emoji} ${names.join(', ')}` : reaction.emoji}
                    onClick={(event) => {
                      event.stopPropagation();
                      onReactToMessage(mode, message, reaction.emoji);
                    }}
                  >
                    <span>{reaction.emoji}</span>
                    <strong>{reaction.count}</strong>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

export default MessageRow;
