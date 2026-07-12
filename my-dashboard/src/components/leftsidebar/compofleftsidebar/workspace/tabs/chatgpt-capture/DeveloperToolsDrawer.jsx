import { useState } from 'react';
import DiagnosticsPanel from './DiagnosticsPanel';
import LiveActivityFeed from './LiveActivityFeed';
import EventDetailPanel from './EventDetailPanel';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { normalizeApiError } from './chatgptCaptureUtils';

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
      const response = await chatgptCaptureAPI.listEvents({ client_event_id: trimmed, limit: 1 });
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
        <p>Look up any captured event by its client event id.</p>
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
      {event && <EventDetailPanel event={event} />}
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
          <DiagnosticsPanel metrics={metrics} loading={metricsLoading} />
          <RawEventInspector />
          <LiveActivityFeed />
        </div>
      </aside>
    </>
  );
}
