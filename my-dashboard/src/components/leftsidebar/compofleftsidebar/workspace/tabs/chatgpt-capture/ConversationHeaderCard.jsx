import { SkeletonBlock } from '../../../../../ui/Skeleton';
import Menu from '../../../../../ui/Menu';
import ConversationStats from './ConversationStats';
import { formatAbsoluteTime, formatRelativeTime, getHealthStatusMeta } from './chatgptCaptureUtils';

const STATUS_ICON = { success: '🟢', warning: '🟡', error: '🔴', muted: '⚪' };

export default function ConversationHeaderCard({
  detail,
  loading,
  error,
  hasMedia = false,
  onRefresh,
  onViewMedia,
  onViewRaw,
  onExport,
}) {
  if (loading && !detail) {
    return (
      <div className="cgpt-conv-header" aria-hidden="true">
        <SkeletonBlock width="40%" height={18} />
        <SkeletonBlock width="70%" height={12} style={{ marginTop: 8 }} />
      </div>
    );
  }

  if (error) {
    return <div className="chatgpt-capture-alert">{error}</div>;
  }

  if (!detail) return null;

  const health = getHealthStatusMeta(detail.captureHealth);

  // Secondary/rare actions live behind a single ⋮ menu (progressive
  // disclosure) so the header stays a thin band and the transcript below gets
  // the height — the Developer view also has its own toggle in the subhead.
  const actionItems = [
    onRefresh && { key: 'refresh', label: 'Refresh', icon: '↻', onSelect: onRefresh },
    hasMedia && onViewMedia && { key: 'media', label: 'View media', icon: '🎨', onSelect: onViewMedia },
    onViewRaw && { key: 'dev', label: 'Developer console', icon: '🔧', onSelect: onViewRaw },
    onExport && { key: 'export', label: 'Export JSON', icon: '⬇', onSelect: onExport },
  ].filter(Boolean);

  return (
    <div className="cgpt-conv-header">
      <div className="cgpt-conv-header-top">
        <div className="cgpt-conv-header-title">
          <h5>{detail.title || detail.conversationId}</h5>
          <div className="cgpt-conv-header-sub">
            <span>{detail.provider === 'chatgpt' ? 'ChatGPT' : (detail.provider || 'ChatGPT')}</span>
            {detail.model && <span className="chatgpt-capture-chip">{detail.model}</span>}
            <span>{detail.ownerName || `User #${detail.ownerUserId}`}</span>
            <span className="cgpt-conv-header-dot" aria-hidden="true">·</span>
            <ConversationStats
              messages={detail.messageCount}
              images={detail.imagesCount}
              files={detail.filesCount}
              variant="inline"
            />
            <span className="cgpt-conv-header-dot" aria-hidden="true">·</span>
            <span title={formatAbsoluteTime(detail.createdAt)}>Updated {formatRelativeTime(detail.lastActivityAt)}</span>
          </div>
        </div>
        <div className="cgpt-conv-header-right">
          <span className={`cgpt-conv-header-status tone-${health.tone}`}>
            {STATUS_ICON[health.tone] || '⚪'} {health.label}
          </span>
          {actionItems.length > 0 && (
            <Menu
              align="end"
              menuLabel="Conversation actions"
              items={actionItems}
              renderTrigger={(triggerProps, { open }) => (
                <button
                  {...triggerProps}
                  className={`cgpt-conv-header-menu-btn${open ? ' open' : ''}`}
                  aria-label="Conversation actions"
                  title="Actions"
                >
                  ⋮
                </button>
              )}
            />
          )}
        </div>
      </div>

      {detail.promptsCount > 0 && detail.responsesCount === 0 && (
        <p className="chatgpt-capture-inline-note tone-warning">
          {detail.promptsCount} prompt{detail.promptsCount === 1 ? '' : 's'} captured with no ChatGPT response yet - check the extension's capture health.
        </p>
      )}
    </div>
  );
}
