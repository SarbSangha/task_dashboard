import React, { useEffect, useState } from 'react';
import { clientsAPI } from '../../../../../services/api';
import { formatGenerationDate } from './klingMedia';

/**
 * The Kling tab's "Clients" browse view - replaces the old "Projects" tab.
 * One card per Client Mapping (see utils/client_gate.py) that has at least
 * one Kling generation; click one to filter "All Generations" down to it,
 * same interaction as the Projects grid it replaces.
 */
export default function KlingClientsExplorer({ onSelectClient }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await clientsAPI.getKlingDirectory({ q: search || undefined });
        if (cancelled) return;
        setClients(Array.isArray(response?.clients) ? response.clients : []);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load Kling clients:', fetchError);
          setError('Could not load clients right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search]);

  return (
    <div className="kling-projects-explorer">
      <div className="kling-projects-toolbar">
        <input
          className="trendings-search kling-search"
          placeholder="Search clients..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </div>

      {error && <div className="kling-state kling-state-error">{error}</div>}
      {!error && loading && <div className="kling-state">Loading clients...</div>}
      {!error && !loading && clients.length === 0 && <div className="kling-state">No clients found.</div>}

      {!error && !loading && clients.length > 0 && (
        <div className="kling-projects-grid">
          {clients.map((client) => (
            <button type="button" key={client.id} className="kling-project-card" onClick={() => onSelectClient(client)}>
              <div className="kling-project-card-cover">{client.name ? client.name.slice(0, 1).toUpperCase() : '#'}</div>
              <div className="kling-project-card-body">
                <h4 className="kling-project-card-title">{client.name}</h4>
                <div className="kling-project-card-stats">
                  <span>{client.generationCount} generation{client.generationCount === 1 ? '' : 's'}</span>
                  <span>Last generated {formatGenerationDate(client.lastGeneratedAt)}</span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
