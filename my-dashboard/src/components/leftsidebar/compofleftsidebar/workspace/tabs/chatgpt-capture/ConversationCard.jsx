import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ConversationStats from './ConversationStats';
import { formatRelativeTime, getHealthStatusMeta } from './chatgptCaptureUtils';

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
      <button
        type="button"
        className={`chatgpt-capture-conv-card cgpt-conv-card${isSelected ? ' selected' : ''}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelect(conversation.conversationId, conversation.title)}
      >
        <div className="cgpt-conv-card-top">
          <span className="cgpt-conv-card-icon" aria-hidden="true">{typeIcon}</span>
          <span className="cgpt-conv-card-title">{conversation.title || conversation.conversationId}</span>
          <span className={`cgpt-conv-card-status tone-${health.tone}`} title={health.label}>
            {STATUS_ICON[health.tone] || '⚪'}
          </span>
        </div>

        {promptPreview && (
          <p className="cgpt-conv-card-preview">{promptPreview}</p>
        )}

        <div className="cgpt-conv-card-foot">
          <ConversationStats messages={messages} images={conversation.imagesCount || 0} files={conversation.filesCount || 0} />
          <span className="cgpt-conv-card-time">{formatRelativeTime(conversation.lastSeenAt)}</span>
        </div>

        <div className="cgpt-conv-card-tags">
          {userName && <span className="cgpt-conv-card-user">👤 {userName}</span>}
          {conversation.model && <span className="chatgpt-capture-chip">{conversation.model}</span>}
        </div>
      </button>
    </div>
  );
}
