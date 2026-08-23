import { useEffect, useState } from 'react';
import { epidemicCaptureAPI } from '../../../../../../services/api';
// JsonViewer is byte-for-byte identical across every provider folder (no
// Epidemic-Sound-specific logic inside it) - reused directly from
// envato-capture instead of duplicating a provider-agnostic file, per that
// folder's own JsonViewer.jsx comment ("kept as its own copy so this
// provider folder stays self-contained" - true of the copy, not of needing
// yet another one here).
import JsonViewer from '../envato-capture/JsonViewer';
import { formatRelativeTime, normalizeApiError, truncate } from './epidemicCaptureUtils';

// Mirrors suno-capture/DeveloperToolsDrawer.jsx, minus even the ElevenLabs-
// style eventType branching Suno kept: Epidemic Sound only ever reports one
// event type (download_click - see constants.py's ALL_EVENT_TYPES), so
// LiveCaptureFeedRow has nothing to branch on. No DiagnosticsPanel either -
// no GET /api/providers/epidemicsound/metrics endpoint (see this provider's
// leaner epidemicCaptureAPI in services/api.js).
const LIVE_FEED_POLL_MS = 5000;

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
      const response = await epidemicCaptureAPI.listEvents({ client_event_id: trimmed, limit: 1 });
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
        <p>Look up any raw EpidemicCaptureEvent by its client event id (e.g. <code>epidemic-sound:0a53c5d4-...:2026-08-18T...</code>) -
          the exact payload the extension sent, before normalization.</p>
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
              <span className="chatgpt-capture-field-label">Download ID</span>
              {/* providerDownloadId mirrors the naming convention every other
                  provider's own identity column gets exposed under
                  (item_uuid -> providerItemUuid for Envato, creation_id ->
                  providerCreationId for Suno) - falls back to '—' harmlessly
                  if the backend's EpidemicCaptureEvent ends up naming this
                  column differently. */}
              <span className="chatgpt-capture-mono">{event.providerDownloadId || '—'}</span>
            </div>
          </div>
          <JsonViewer data={event.payload} label="Raw decoded payload" />
        </>
      )}
    </div>
  );
}

function getLiveFeedStage(event) {
  if (event.ownershipConfidence === 'reconciliation') {
    return { label: 'Historical import', tone: 'muted' };
  }
  if (event.ownershipConfidence === 'ticket' || event.ownershipConfidence === 'session') {
    return { label: 'Capture complete ✓', tone: 'success' };
  }
  return { label: 'Captured (unattributed)', tone: 'warning' };
}

function LiveCaptureFeedRow({ event }) {
  const title = event.payload?.assetTitle;
  const stage = getLiveFeedStage(event);

  return (
    <div className="chatgpt-capture-panel" style={{ marginBottom: 8 }}>
      <div className="chatgpt-capture-panel-head">
        <h4 style={{ fontSize: 13 }}>
          {truncate(title, 90) || 'No title captured'}
        </h4>
        <span className={`chatgpt-capture-metric-card tone-${stage.tone}`} style={{ padding: '2px 8px', fontSize: 11 }}>
          {stage.label}
        </span>
      </div>
      <div className="chatgpt-capture-fields-grid">
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Type</span>
          <span>{event.payload?.isSfx ? 'Sound Effect' : 'Music'}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Employee</span>
          <span>{event.userName || (event.userId ? `User #${event.userId}` : '—')}</span>
        </div>
        <div className="chatgpt-capture-field">
          <span className="chatgpt-capture-field-label">Download ID</span>
          <span className="chatgpt-capture-mono">{event.providerDownloadId || '—'}</span>
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

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;

    const poll = async () => {
      if (!cancelled) setLoading(true);
      try {
        const response = await epidemicCaptureAPI.listEvents({ limit: 10 });
        if (cancelled) return;
        setEvents(response.data || []);
        setError('');
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
        Auto-refreshes every {LIVE_FEED_POLL_MS / 1000}s while this drawer is open.
      </p>
      {error && <div className="chatgpt-capture-alert">{error}</div>}
      {!error && events.length === 0 && (
        <p className="chatgpt-capture-inline-note">No captures yet.</p>
      )}
      {events.map((event) => (
        <LiveCaptureFeedRow key={event.id} event={event} />
      ))}
    </div>
  );
}

export default function DeveloperToolsDrawer({ open, onClose }) {
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
          <RawEventInspector />
        </div>
      </aside>
    </>
  );
}
