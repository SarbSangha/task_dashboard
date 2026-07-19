import { useMemo, useState } from 'react';
import RawEventsList from './RawEventsList';
import { categorizeEvent } from './observabilityHelpers';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'sse', label: 'SSE' },
  { key: 'media', label: 'Media' },
  { key: 'network', label: 'Network' },
  { key: 'errors', label: 'Errors' },
];

// Searchable / filterable event list. Reuses RawEventsList (timeline rows +
// collapsible EventDetailPanel + JsonViewer) for the raw-payload viewing.
export default function EventExplorer({ events, loading, error }) {
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (events || []).filter((e) => {
      if (filter !== 'all' && categorizeEvent(e) !== filter) return false;
      if (!q) return true;
      const hay = [e.eventType, e.clientEventId, e.providerMessageId, JSON.stringify(e.payload || {})].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [events, filter, query]);

  return (
    <div className="cgpt-dev-card">
      <div className="cgpt-dev-card-head">
        <h6 className="cgpt-dev-card-title">Event Explorer</h6>
        <div className="cgpt-ws-search cgpt-dev-search">
          <span className="cgpt-ws-search-icon" aria-hidden="true">🔍</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search events…"
            aria-label="Search events by type, id, or payload"
          />
        </div>
      </div>
      <div className="cgpt-media-filters" role="group" aria-label="Filter events">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`cgpt-media-filter${filter === f.key ? ' active' : ''}`}
            aria-pressed={filter === f.key}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>
      <RawEventsList
        events={filtered}
        loading={loading}
        error={error}
        emptyTitle="No matching events"
        emptyBody="No events match this filter or search."
      />
    </div>
  );
}
