import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { formatCount, formatRelativeTime, getHealthStatusMeta } from './chatgptCaptureUtils';

export default function ConversationHeaderCard({ detail, loading, error }) {
  if (loading && !detail) {
    return (
      <div className="chatgpt-capture-conv-header" aria-hidden="true">
        <SkeletonBlock width="40%" height={18} />
        <SkeletonBlock width="70%" height={12} style={{ marginTop: 8 }} />
      </div>
    );
  }

  if (error) {
    return <div className="chatgpt-capture-alert">{error}</div>;
  }

  if (!detail) return null;

  const healthMeta = getHealthStatusMeta(detail.captureHealth);

  const fields = [
    { label: 'Owner', value: detail.ownerName || `User #${detail.ownerUserId}` },
    { label: 'Provider', value: 'ChatGPT' },
    { label: 'Model', value: detail.model || 'Unknown yet' },
    { label: 'Created', value: formatRelativeTime(detail.createdAt) },
    { label: 'Messages', value: formatCount(detail.messageCount) },
    { label: 'Images', value: formatCount(detail.imagesCount) },
    { label: 'Files', value: formatCount(detail.filesCount) },
  ];

  return (
    <div className="chatgpt-capture-conv-header">
      <div className="chatgpt-capture-conv-header-top">
        <h5>{detail.title || detail.conversationId}</h5>
        <span className={`chatgpt-capture-badge tone-${healthMeta.tone}`}>
          {healthMeta.tone === 'success' ? '🟢' : healthMeta.tone === 'error' ? '🔴' : '🟡'} {healthMeta.label}
        </span>
      </div>
      <div className="chatgpt-capture-conv-header-fields">
        {fields.map((field) => (
          <div key={field.label} className="chatgpt-capture-conv-header-field">
            <span className="chatgpt-capture-field-label">{field.label}</span>
            <span className="chatgpt-capture-field-value">{field.value}</span>
          </div>
        ))}
      </div>
      {detail.promptsCount > 0 && detail.responsesCount === 0 && (
        <p className="chatgpt-capture-inline-note tone-warning">
          {detail.promptsCount} prompt{detail.promptsCount === 1 ? '' : 's'} captured with no ChatGPT response yet - check the extension's capture health.
        </p>
      )}
    </div>
  );
}
