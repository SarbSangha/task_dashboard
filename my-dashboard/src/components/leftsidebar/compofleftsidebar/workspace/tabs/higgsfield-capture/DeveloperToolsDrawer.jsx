import { useEffect, useRef, useState } from 'react';
import { higgsfieldCaptureAPI } from '../../../../../../services/api';
import JsonViewer from './JsonViewer';
import { formatCount, formatCredits, formatRelativeTime, normalizeApiError, truncate } from './higgsfieldCaptureUtils';

const LIVE_FEED_POLL_MS = 5000;

function DiagnosticsPanel({ metrics, loading }) {
  if (loading && !metrics) return <div className="chatgpt-capture-panel">Loading diagnostics…</div>;
  if (!metrics) return null;
  const ingest = metrics.ingest || {};
  return (
    <div className="chatgpt-capture-panel">
      <div className="chatgpt-capture-panel-head">
        <h4>Ingest counters (this server process)</h4>
      </div>
      <div className="chatgpt-capture-fields-grid">
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Created</span>
          <span>{formatCount(ingest.created)}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Duplicate (deduped)</span>
          <span>{formatCount(ingest.duplicate)}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Rejected</span>
          <span>{formatCount(ingest.rejected)}</span>
        </div>
      </div>
      <p className="chatgpt-capture-inline-note">
        Resets on server restart - this is a live debugging signal, not an audit trail. For durable
        totals see the metrics band above (Generations Captured / Unclaimed).
      </p>
    </div>
  );
}

function RawEventInspector() {
  const [clientEventId, setClientEventId] = useState('');
  const [event, setEvent] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const handleSearch = async (submitEvent) => {
    submitEvent.preventDefault();
    const trimmed = clientEventId.trim();
    if (!trimmed) return;
    setLoading(true);
    setError('');
    setSearched(true);
    try {
      const response = await higgsfieldCaptureAPI.listEvents({ client_event_id: trimmed, limit: 1 });
      setEvent(response.data?.[0] || null);
    } catch (searchError) {
      setError(normalizeApiError(searchError, 'Unable to look up that event.'));
      setEvent(null);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="chatgpt-capture-panel chatgpt-capture-raw-inspector">
      <div className="chatgpt-capture-panel-head">
        <h4>Raw Event Inspector</h4>
        <p>Look up any raw HiggsfieldCaptureEvent by its client event id (e.g. <code>higgsfield:g-12345:submitted</code>) - the
          exact, unparsed payload the extension sent, before normalization.</p>
      </div>
      <form className="chatgpt-capture-inspector-form" onSubmit={handleSearch}>
        <input
          type="text"
          aria-label="Client event id"
          placeholder="Paste a client event id…"
          value={clientEventId}
          onChange={(changeEvent) => setClientEventId(changeEvent.target.value)}
        />
        <button type="submit" className="chatgpt-capture-secondary-btn" disabled={loading || !clientEventId.trim()}>
          {loading ? 'Searching…' : 'Look up'}
        </button>
      </form>
      {error && <div className="chatgpt-capture-alert">{error}</div>}
      {searched && !loading && !error && !event && (
        <p className="chatgpt-capture-inline-note">No event found with that client event id.</p>
      )}
      {event && (
        <>
          <div className="chatgpt-capture-fields-grid">
            <div className="chatgpt-capture-field">
              <span className="chatgpt-capture-field-label">Event type</span>
              <span>{event.eventType}</span>
            </div>
            <div className="chatgpt-capture-field">
              <span className="chatgpt-capture-field-label">Ownership confidence</span>
              <span>{event.ownershipConfidence || '—'}</span>
            </div>
            <div className="chatgpt-capture-field">
              <span className="chatgpt-capture-field-label">Generation ID</span>
              <span className="chatgpt-capture-mono">{event.providerGenerationId || '—'}</span>
            </div>
          </div>
          <JsonViewer data={event.payload} label="Raw intercepted payload" />
        </>
      )}
    </div>
  );
}

// Derives a human stage label from what a raw HiggsfieldCaptureEvent alone
// can tell us - the backend pipeline (ingest + normalize) completes
// synchronously within one request, so these are sequence-of-completion
// labels for admin legibility, not fabricated delays. Provider-agnostic -
// identical to heygen-capture's version.
function getLiveFeedStage(event) {
  if (event.ownershipConfidence === 'reconciliation') {
    return { label: 'Historical import', tone: 'muted' };
  }
  if (event.ownershipConfidence === 'ticket' || event.ownershipConfidence === 'session') {
    return { label: 'Capture complete ✓', tone: 'success' };
  }
  return { label: 'Captured (unattributed)', tone: 'warning' };
}

// Reads content-higgsfield.js's own capture envelope (payload.promptText,
// payload.preset/credits/status) rather than a raw provider API response -
// Higgsfield has no confirmed API response shape (see
// providers/higgsfield/normalization.py's module docstring), so the
// extension builds this envelope itself from DOM scraping + shape-based
// network interception.
function LiveCaptureFeedRow({ event, ownerName }) {
  const payload = event.payload || {};
  const preset = payload.preset || {};
  const credits = payload.credits || {};
  const stage = getLiveFeedStage(event);

  return (
    <div className="chatgpt-capture-panel" style={{ marginBottom: 8 }}>
      <div className="chatgpt-capture-panel-head">
        <h4 style={{ fontSize: 13 }}>{truncate(payload.promptText, 90) || 'No prompt captured'}</h4>
        <span className={`chatgpt-capture-metric-card tone-${stage.tone}`} style={{ padding: '2px 8px', fontSize: 11 }}>
          {stage.label}
        </span>
      </div>
      <div className="chatgpt-capture-fields-grid">
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Preset</span>
          <span>{preset.name || '—'}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Multi-shot</span>
          <span>{payload.multiShot === true ? 'On' : payload.multiShot === false ? 'Off' : '—'}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Credits</span>
          <span>{credits.used != null ? formatCredits(credits.used) : '—'}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Employee</span>
          <span>{ownerName || (event.userId ? `User #${event.userId}` : '—')}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Generation ID</span>
          <span className="chatgpt-capture-mono">{event.providerGenerationId || '—'}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Capture time</span>
          <span>{formatRelativeTime(event.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

function LiveCaptureFeed({ active }) {
  const [events, setEvents] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const ownerNamesRef = useRef(new Map());
  const [, forceRerender] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;

    const poll = async () => {
      if (!cancelled) setLoading(true);
      try {
        const response = await higgsfieldCaptureAPI.listEvents({ limit: 10 });
        if (cancelled) return;
        const items = response.data || [];
        setEvents(items);
        setError('');

        // Best-effort employee-name resolution, cached by userId so a
        // steady 5s poll of a mostly-unchanged list doesn't refetch the
        // same user repeatedly.
        const unresolvedUserIds = [...new Set(items.map((item) => item.userId).filter(Boolean))]
          .filter((userId) => !ownerNamesRef.current.has(userId));
        if (unresolvedUserIds.length) {
          const results = await Promise.all(
            unresolvedUserIds.map((userId) => higgsfieldCaptureAPI.getUser(userId).then(
              (userResponse) => [userId, userResponse.data?.name],
              () => [userId, null]
            ))
          );
          if (!cancelled) {
            results.forEach(([userId, name]) => ownerNamesRef.current.set(userId, name));
            forceRerender((tick) => tick + 1);
          }
        }
      } catch (fetchError) {
        if (!cancelled) setError(normalizeApiError(fetchError, 'Unable to load recent captures.'));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    poll();
    const timer = window.setInterval(poll, LIVE_FEED_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);

  return (
    <div className="chatgpt-capture-panel">
      <div className="chatgpt-capture-panel-head">
        <h4>Recent Live Captures</h4>
        {loading && <span className="chatgpt-capture-inline-note">Refreshing…</span>}
      </div>
      <p className="chatgpt-capture-inline-note">
        Auto-refreshes every {LIVE_FEED_POLL_MS / 1000}s while this drawer is open - lets an admin
        verify the system is capturing what was just generated, not something from history.
      </p>
      {error && <div className="chatgpt-capture-alert">{error}</div>}
      {!error && events.length === 0 && (
        <p className="chatgpt-capture-inline-note">No captures yet.</p>
      )}
      {events.map((event) => (
        <LiveCaptureFeedRow key={event.id} event={event} ownerName={event.userId ? ownerNamesRef.current.get(event.userId) : null} />
      ))}
    </div>
  );
}

export default function DeveloperToolsDrawer({ open, onClose, metrics, metricsLoading }) {
  return (
    <>
      <div
        className={`chatgpt-capture-drawer-backdrop${open ? ' visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`chatgpt-capture-drawer${open ? ' open' : ''}`}
        aria-hidden={!open}
        aria-label="Developer Tools"
      >
        <div className="chatgpt-capture-drawer-head">
          <h3>Developer Tools</h3>
          <button type="button" className="chatgpt-capture-drawer-close" onClick={onClose} aria-label="Close developer tools">
            ✕
          </button>
        </div>
        <div className="chatgpt-capture-drawer-body">
          <LiveCaptureFeed active={open} />
          <DiagnosticsPanel metrics={metrics} loading={metricsLoading} />
          <RawEventInspector />
        </div>
      </aside>
    </>
  );
}
