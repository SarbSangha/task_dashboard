import React, { useMemo } from 'react';
import './AdminPendingTab.css';

const TYPE_META = {
  signup:          { label: 'Login Request',   cls: 'info' },
  profile_update:  { label: 'Profile Update',  cls: 'success' },
  password_change: { label: 'Password Change', cls: 'warning' },
};

function TypeBadge({ type }) {
  const { label, cls } = TYPE_META[type] || { label: type || 'Unknown', cls: 'neutral' };
  return <span className={`apt-type apt-type--${cls}`}>{label}</span>;
}

function EmptyState({ message }) {
  return (
    <div className="apt-empty">
      <svg className="apt-empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.8" opacity=".25" />
        <path d="M16 28c2-4 10-4 12 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".4" />
        <circle cx="18" cy="20" r="2" fill="currentColor" opacity=".45" />
        <circle cx="30" cy="20" r="2" fill="currentColor" opacity=".45" />
      </svg>
      <p className="apt-empty-text">{message}</p>
    </div>
  );
}

export default function AdminPendingTab({ requests, search, loading, onReview, formatDateTime }) {
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((r) => {
      const hay = `${r.user?.name || ''} ${r.user?.email || ''} ${r.user?.department || ''} ${r.requestType || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [requests, search]);

  if (loading) return <EmptyState message="Loading requests…" />;

  if (filtered.length === 0) {
    return (
      <EmptyState
        message={search ? 'No requests match the search.' : "No pending requests — you're all caught up!"}
      />
    );
  }

  return (
    <div className="apt-root">
      <div className="apt-table-wrap">
        <table className="apt-table" aria-label="Pending approval requests">
          <thead>
            <tr>
              <th scope="col">Requester</th>
              <th scope="col">Type</th>
              <th scope="col">Department</th>
              <th scope="col">Position</th>
              <th scope="col">Submitted</th>
              <th scope="col">Details</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((req) => (
              <tr key={req.requestId} className="apt-row">
                <td>
                  <div className="apt-user-cell">
                    <span className="apt-user-name">{req.user?.name || 'Unknown'}</span>
                    <span className="apt-user-email">{req.user?.email || '—'}</span>
                  </div>
                </td>
                <td><TypeBadge type={req.requestType} /></td>
                <td><span className="apt-cell">{req.user?.department || req.payload?.department || '—'}</span></td>
                <td><span className="apt-cell">{req.user?.position  || req.payload?.position  || '—'}</span></td>
                <td>
                  <span className="apt-cell apt-cell--muted">
                    {formatDateTime(req.requestedAt || req.createdAt || req.updatedAt)}
                  </span>
                </td>
                <td>
                  <details className="apt-details">
                    <summary className="apt-details-toggle">View payload</summary>
                    <pre className="apt-details-pre">{JSON.stringify(req.payload || {}, null, 2)}</pre>
                  </details>
                </td>
                <td>
                  <div className="apt-actions">
                    <button
                      type="button"
                      className="apt-btn apt-btn--approve"
                      onClick={() => onReview(req.requestId, true)}
                      aria-label={`Approve request from ${req.user?.name}`}
                    >
                      Approve
                    </button>
                    <button
                      type="button"
                      className="apt-btn apt-btn--reject"
                      onClick={() => onReview(req.requestId, false)}
                      aria-label={`Reject request from ${req.user?.name}`}
                    >
                      Reject
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
