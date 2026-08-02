import React, { useEffect, useMemo, useState } from 'react';
import { clientsAPI } from '../../../../services/api';
import './AdminClientsTab.css';

function EmptyState({ message }) {
  return (
    <div className="act-empty">
      <svg className="act-empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.8" opacity=".25" />
        <path d="M16 28c2-4 10-4 12 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".4" />
        <circle cx="18" cy="20" r="2" fill="currentColor" opacity=".45" />
        <circle cx="30" cy="20" r="2" fill="currentColor" opacity=".45" />
      </svg>
      <p className="act-empty-text">{message}</p>
    </div>
  );
}

export default function AdminClientsTab({ search }) {
  const [clients, setClients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [newClientName, setNewClientName] = useState('');
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState('');

  const loadClients = async () => {
    setLoading(true);
    try {
      const result = await clientsAPI.getClients();
      setClients(result.clients || []);
      setMessage('');
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to load clients');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadClients(); }, []);

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return clients;
    return clients.filter((client) => client.name.toLowerCase().includes(q));
  }, [clients, search]);

  const handleAddClient = async (event) => {
    event.preventDefault();
    const name = newClientName.trim();
    if (name.length < 2) {
      setMessage('Client name must be at least 2 characters long');
      return;
    }
    try {
      await clientsAPI.createClient(name);
      setNewClientName('');
      setMessage('');
      await loadClients();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to add client');
    }
  };

  const toggleActive = async (client) => {
    try {
      await clientsAPI.updateClient(client.id, { is_active: !client.isActive });
      await loadClients();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to update client');
    }
  };

  const startRename = (client) => {
    setRenamingId(client.id);
    setRenameValue(client.name);
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameValue('');
  };

  const saveRename = async (client) => {
    const name = renameValue.trim();
    if (name.length < 2) {
      setMessage('Client name must be at least 2 characters long');
      return;
    }
    if (name === client.name) {
      cancelRename();
      return;
    }
    try {
      await clientsAPI.updateClient(client.id, { name });
      cancelRename();
      await loadClients();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to rename client');
    }
  };

  return (
    <div className="act-root">
      <form className="act-add-form" onSubmit={handleAddClient}>
        <input
          type="text"
          placeholder="New client name"
          value={newClientName}
          onChange={(event) => setNewClientName(event.target.value)}
          maxLength={200}
          aria-label="New client name"
        />
        <button type="submit" className="act-btn act-btn--add">Add Client</button>
      </form>

      {message && <div className="act-message" role="alert">{message}</div>}

      {loading ? (
        <EmptyState message="Loading clients…" />
      ) : filtered.length === 0 ? (
        <EmptyState message={search ? 'No clients match the search.' : 'No clients yet — add one above.'} />
      ) : (
        <div className="act-table-wrap">
          <table className="act-table" aria-label="Clients">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((client) => (
                <tr key={client.id} className="act-row">
                  <td>
                    {renamingId === client.id ? (
                      <input
                        type="text"
                        className="act-rename-input"
                        value={renameValue}
                        onChange={(event) => setRenameValue(event.target.value)}
                        maxLength={200}
                        autoFocus
                      />
                    ) : (
                      <span className="act-name">{client.name}</span>
                    )}
                  </td>
                  <td>
                    <span className={`act-status act-status--${client.isActive ? 'active' : 'inactive'}`}>
                      {client.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <div className="act-actions">
                      {renamingId === client.id ? (
                        <>
                          <button type="button" className="act-btn" onClick={() => saveRename(client)}>Save</button>
                          <button type="button" className="act-btn act-btn--reject" onClick={cancelRename}>Cancel</button>
                        </>
                      ) : (
                        <>
                          <button type="button" className="act-btn" onClick={() => startRename(client)}>Rename</button>
                          <button
                            type="button"
                            className={`act-btn ${client.isActive ? 'act-btn--reject' : 'act-btn--approve'}`}
                            onClick={() => toggleActive(client)}
                          >
                            {client.isActive ? 'Deactivate' : 'Activate'}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
