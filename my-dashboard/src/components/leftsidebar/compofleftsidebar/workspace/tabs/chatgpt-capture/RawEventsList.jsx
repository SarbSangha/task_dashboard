import { useState } from 'react';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import EventDetailPanel from './EventDetailPanel';
import { formatRelativeTime, getEventTypeMeta } from './chatgptCaptureUtils';

export default function RawEventsList({ events, loading, error, emptyTitle = 'No events', emptyBody = 'Nothing has been captured yet.' }) {
  const [expandedEventId, setExpandedEventId] = useState(null);

  if (loading) {
    return (
      <div aria-hidden="true">
        {Array.from({ length: 4 }).map((_, index) => (
          <SkeletonBlock key={index} width="100%" height={40} style={{ marginBottom: 8 }} />
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
        <strong>{emptyTitle}</strong>
        <p>{emptyBody}</p>
      </div>
    );
  }

  return (
    <div className="chatgpt-capture-timeline-list">
      {events.map((event, index) => {
        const meta = getEventTypeMeta(event.eventType);
        const isExpanded = expandedEventId === event.id;
        return (
          <div key={event.id} className="chatgpt-capture-timeline-node">
            <div className="chatgpt-capture-timeline-rail" aria-hidden="true">
              <span className={`chatgpt-capture-timeline-dot tone-${meta.tone}`} />
              {index < events.length - 1 && <span className="chatgpt-capture-timeline-line" />}
            </div>
            <div className="chatgpt-capture-timeline-content">
              <button
                type="button"
                className="chatgpt-capture-timeline-node-head"
                onClick={() => setExpandedEventId(isExpanded ? null : event.id)}
                aria-expanded={isExpanded}
              >
                <span className="chatgpt-capture-timeline-icon" aria-hidden="true">{meta.icon}</span>
                <span className="chatgpt-capture-timeline-label">{meta.label}</span>
                <span className="chatgpt-capture-timeline-time">{formatRelativeTime(event.createdAt)}</span>
              </button>
              {isExpanded && <EventDetailPanel event={event} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}
