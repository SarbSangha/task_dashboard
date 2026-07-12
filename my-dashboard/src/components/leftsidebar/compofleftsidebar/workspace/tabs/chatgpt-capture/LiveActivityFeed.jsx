import { useCallback, useEffect, useRef, useState } from 'react';
import { List } from 'react-window';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { useElementSize } from '../../../../../../hooks/useElementSize';
import { EVENT_TYPE_META, formatRelativeTime, getEventTypeMeta, normalizeApiError } from './chatgptCaptureUtils';

const POLL_INTERVAL_MS = 8000;
const MAX_FEED_ITEMS = 500;
const FEED_ROW_HEIGHT = 56;

const LEGEND_ENTRIES = [
  { key: 'prompt_captured', label: 'Prompt' },
  { key: 'response_completed', label: 'Response' },
  { key: 'conversation_renamed', label: 'Rename' },
  { key: 'conversation_opened', label: 'Open' },
  { key: 'file_upload_detected', label: 'File Upload' },
  { key: '__error__', label: 'Errors', tone: 'error' },
  { key: '__parse_failure__', label: 'Parse Failures', tone: 'warning' },
];

function FeedRow({ ariaAttributes, index, style, items }) {
  const event = items[index];
  if (!event) return null;
  const meta = getEventTypeMeta(event.eventType);

  return (
    <div {...ariaAttributes} style={style} className={`chatgpt-capture-feed-row tone-${meta.tone}`}>
      <span className="chatgpt-capture-feed-icon" aria-hidden="true">{meta.icon}</span>
      <span className="chatgpt-capture-feed-label">{meta.label}</span>
      <span className="chatgpt-capture-feed-conversation">{event.providerConversationId || '—'}</span>
      <span className="chatgpt-capture-feed-time">{formatRelativeTime(event.createdAt)}</span>
    </div>
  );
}

export default function LiveActivityFeed() {
  const [items, setItems] = useState([]);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState('');
  const seenIdsRef = useRef(new Set());
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  const poll = useCallback(async () => {
    if (pausedRef.current) return;
    try {
      const response = await chatgptCaptureAPI.listEvents({ limit: 50 });
      const incoming = response.data || [];
      const fresh = incoming.filter((event) => !seenIdsRef.current.has(event.id));
      if (fresh.length === 0) return;
      fresh.forEach((event) => seenIdsRef.current.add(event.id));
      setItems((prev) => {
        const merged = [...fresh, ...prev].slice(0, MAX_FEED_ITEMS);
        // Keep the seen-id set in sync with what's actually retained so it
        // doesn't grow unbounded across a long-lived session.
        seenIdsRef.current = new Set(merged.map((item) => item.id));
        return merged;
      });
      setError('');
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Live feed temporarily unavailable.'));
    }
  }, []);

  useEffect(() => {
    poll();
    const timer = window.setInterval(poll, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  const handleClear = () => {
    setItems([]);
    seenIdsRef.current = new Set();
  };

  const [wrapRef, size] = useElementSize();

  return (
    <div className="chatgpt-capture-panel chatgpt-capture-live-feed">
      <div className="chatgpt-capture-panel-head">
        <div>
          <h4>Live Activity Feed</h4>
          <p>Newest capture events across every conversation, polling every {POLL_INTERVAL_MS / 1000}s.</p>
        </div>
        <div className="chatgpt-capture-actions">
          <button type="button" className="chatgpt-capture-secondary-btn" onClick={() => setPaused((prev) => !prev)}>
            {paused ? 'Resume' : 'Pause'}
          </button>
          <button type="button" className="chatgpt-capture-secondary-btn" onClick={handleClear}>
            Clear
          </button>
        </div>
      </div>

      <div className="chatgpt-capture-feed-legend">
        {LEGEND_ENTRIES.map((entry) => {
          const meta = EVENT_TYPE_META[entry.key] || { icon: '⚠️', tone: entry.tone || 'muted' };
          return (
            <span key={entry.key} className={`chatgpt-capture-badge tone-${entry.tone || meta.tone}`}>
              {meta.icon} {entry.label}
            </span>
          );
        })}
      </div>

      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {items.length === 0 && !error && (
        <div className="chatgpt-capture-empty-state compact">
          <strong>Waiting for events</strong>
          <p>Nothing captured yet in this window. New events will appear here automatically.</p>
        </div>
      )}

      {items.length > 0 && (
        <div className="chatgpt-capture-feed-list" ref={wrapRef}>
          {size.width > 0 && size.height > 0 && (
            <List
              className="chatgpt-capture-virtual-list"
              rowComponent={FeedRow}
              rowProps={{ items }}
              rowCount={items.length}
              rowHeight={FEED_ROW_HEIGHT}
              overscanCount={6}
              style={{ height: size.height, width: size.width }}
            />
          )}
        </div>
      )}
    </div>
  );
}
