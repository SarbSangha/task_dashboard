import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { getEventTypeMeta } from './chatgptCaptureUtils';

function formatClockTime(value) {
  if (!value) return '--:--';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '--:--';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(parsed);
}

export default function ConversationTimelineLog({ events, loading, error }) {
  if (loading) {
    return (
      <div aria-hidden="true">
        {Array.from({ length: 6 }).map((_, index) => (
          <SkeletonBlock key={index} width="100%" height={22} style={{ marginBottom: 6 }} />
        ))}
      </div>
    );
  }

  if (error) {
    return <div className="chatgpt-capture-alert">{error}</div>;
  }

  if (!events || events.length === 0) {
    return (
      <div className="chatgpt-capture-empty-state compact">
        <strong>No events yet</strong>
        <p>Nothing has been captured for this conversation.</p>
      </div>
    );
  }

  return (
    <div className="chatgpt-capture-timeline-log">
      {events.map((event) => {
        const meta = getEventTypeMeta(event.eventType);
        return (
          <div key={event.id} className="chatgpt-capture-timeline-log-row">
            <span className="chatgpt-capture-timeline-log-time">{formatClockTime(event.createdAt)}</span>
            <span className={`chatgpt-capture-timeline-log-dot tone-${meta.tone}`} aria-hidden="true" />
            <span className="chatgpt-capture-timeline-log-icon" aria-hidden="true">{meta.icon}</span>
            <span className="chatgpt-capture-timeline-log-label">{meta.label}</span>
          </div>
        );
      })}
    </div>
  );
}
