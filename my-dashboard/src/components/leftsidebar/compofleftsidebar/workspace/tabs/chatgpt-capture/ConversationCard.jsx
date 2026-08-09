import { SkeletonBlock } from '../../../../../ui/Skeleton';
import Menu from '../../../../../ui/Menu';
import { formatCount, formatRelativeTime, getHealthStatusMeta } from './chatgptCaptureUtils';

const STATUS_ICON = { success: '🟢', warning: '🟡', error: '🔴', muted: '⚪' };

// react-window rowComponent signature preserved exactly (ariaAttributes,
// index, style, rowProps...) - only the card's internal markup is redesigned.
export default function ConversationCard({
  ariaAttributes,
  index,
  style,
  conversations,
  selectedConversationId,
  onSelect,
  isPinned,
  onTogglePin,
  userName,
}) {
  const conversation = conversations[index];

  if (!conversation) {
    return (
      <div {...ariaAttributes} style={style} className="chatgpt-capture-conv-card-wrap">
        <div className="chatgpt-capture-conv-card loading" aria-hidden="true">
          <SkeletonBlock width="60%" height={14} />
          <SkeletonBlock width="90%" height={11} style={{ marginTop: 8 }} />
          <SkeletonBlock width="80%" height={11} style={{ marginTop: 6 }} />
        </div>
      </div>
    );
  }

  const isSelected = conversation.conversationId === selectedConversationId;
  const health = getHealthStatusMeta(conversation.captureHealth);
  const pinned = isPinned(conversation.conversationId);
  const messages = (conversation.promptsCount || 0) + (conversation.responsesCount || 0);
  const hasImages = (conversation.imagesCount || 0) > 0;
  const typeIcon = hasImages ? '🖼' : '💬';
  const promptPreview = conversation.firstPromptPreview || conversation.lastResponsePreview;

  // Everything beyond title/preview/time is secondary - tucked behind the ⋮
  // menu (progressive disclosure) so the list stays scannable at a glance,
  // same approach as the conversation detail header's own action menu.
  const detailItems = [
    { type: 'info', icon: STATUS_ICON[health.tone] || '⚪', label: health.label },
    // Per-conversation twin of the user list's "Unconfirmed" badge: this row
    // is attributed to the person by best effort (their session captured it)
    // rather than by confirmed ownership, because it was captured mid-thread.
    conversation.isUnconfirmedOwnership && {
      type: 'info',
      icon: '⚠',
      label: 'Unconfirmed owner',
    },
    { type: 'separator' },
    { type: 'info', icon: '💬', label: `${formatCount(messages)} messages` },
    { type: 'info', icon: '🖼', label: `${formatCount(conversation.imagesCount || 0)} images` },
    { type: 'info', icon: '📄', label: `${formatCount(conversation.filesCount || 0)} files` },
    (userName || conversation.model) && { type: 'separator' },
    userName && { type: 'info', icon: '👤', label: userName },
    conversation.model && { type: 'info', icon: '🧠', label: conversation.model },
  ].filter(Boolean);

  return (
    <div {...ariaAttributes} style={style} className="chatgpt-capture-conv-card-wrap">
      <button
        type="button"
        className={`chatgpt-capture-pin-btn${pinned ? ' pinned' : ''}`}
        aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
        aria-pressed={pinned}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(conversation.conversationId);
        }}
      >
        {pinned ? '★' : '☆'}
      </button>
      <Menu
        align="end"
        menuLabel="Conversation details"
        items={detailItems}
        className="cgpt-conv-card-menu"
        renderTrigger={(triggerProps, { open }) => (
          <button
            {...triggerProps}
            className={`cgpt-conv-card-menu-btn${open ? ' open' : ''}`}
            aria-label="Conversation details"
            title="Details"
            onClick={(event) => {
              event.stopPropagation();
              triggerProps.onClick(event);
            }}
          >
            ⋮
          </button>
        )}
      />
      <button
        type="button"
        className={`chatgpt-capture-conv-card cgpt-conv-card${isSelected ? ' selected' : ''}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelect(conversation.conversationId, conversation.title)}
      >
        <div className="cgpt-conv-card-top">
          <span className="cgpt-conv-card-icon" aria-hidden="true">{typeIcon}</span>
          <span className="cgpt-conv-card-title">{conversation.title || conversation.conversationId}</span>
          <span className={`cgpt-conv-card-status tone-${health.tone}`} aria-hidden="true">
            {STATUS_ICON[health.tone] || '⚪'}
          </span>
        </div>

        {promptPreview && (
          <p className="cgpt-conv-card-preview">{promptPreview}</p>
        )}

        <div className="cgpt-conv-card-foot">
          <span className="cgpt-conv-card-time">{formatRelativeTime(conversation.lastSeenAt)}</span>
        </div>
      </button>
    </div>
  );
}
