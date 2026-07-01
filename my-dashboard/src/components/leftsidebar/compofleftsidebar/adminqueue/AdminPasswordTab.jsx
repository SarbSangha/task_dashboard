import React, { useCallback, useMemo, useState } from 'react';
import { authAPI } from '../../../../services/api';
import { UserAvatar } from '../../../common/UserAvatar';
import './AdminPasswordTab.css';

let _tid = 0;

function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="apwt-toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`apwt-toast apwt-toast--${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

function SectionHeader({ title, count, sub }) {
  return (
    <div className="apwt-section-hdr">
      <div>
        <h4 className="apwt-section-title">{title}</h4>
        {sub && <p className="apwt-section-sub">{sub}</p>}
      </div>
      {count != null && <span className="apwt-section-count">{count}</span>}
    </div>
  );
}

export default function AdminPasswordTab({
  requests, users, search, loading,
  showConfirm, showPrompt, setMessage, onReload, onViewUser, formatDateTime,
}) {
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'success') => {
    const id = ++_tid;
    setToasts((p) => [...p, { id, msg, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);

  // ── Filtered pending requests ──────────────────────────────────────────────

  const filteredRequests = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return requests;
    return requests.filter((r) => {
      const hay = `${r.user?.name || ''} ${r.user?.email || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [requests, search]);

  // ── Eligible users for manual reset ───────────────────────────────────────

  const manualUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (u.isDeleted || u.isAdmin) return false;
      if (!q) return true;
      const hay = `${u.name} ${u.email} ${u.department || ''}`.toLowerCase();
      return hay.includes(q);
    });
  }, [users, search]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  const handleReviewRequest = async (requestId, approve, userName) => {
    const notes = (await showPrompt(
      approve ? 'Approval note (optional):' : 'Rejection reason (required):',
      { title: approve ? 'Approve Password Request' : 'Reject Password Request', defaultValue: '' },
    )) ?? '';
    if (!approve && !notes.trim()) { addToast('Rejection reason is required.', 'error'); return; }
    try {
      await authAPI.reviewAdminRequest(requestId, approve, notes);
      addToast(`Password request ${approve ? 'approved' : 'rejected'} for ${userName}.`);
      await onReload();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to process request.', 'error');
    }
  };

  const handleAdminReset = useCallback(async (targetUser) => {
    const p1 = await showPrompt(`New password for ${targetUser.name}:`, {
      title: 'Admin Password Reset',
      defaultValue: '', placeholder: 'Min 8 characters', inputType: 'password', confirmText: 'Continue',
    });
    if (p1 === null) return;
    if (!p1.trim() || p1.trim().length < 8) { addToast('Password must be at least 8 characters.', 'error'); return; }

    const p2 = await showPrompt('Confirm new password:', {
      title: 'Confirm Password',
      defaultValue: '', placeholder: 'Re-enter', inputType: 'password', confirmText: 'Reset Password',
    });
    if (p2 === null) return;
    if (p1 !== p2) { addToast('Passwords do not match.', 'error'); return; }

    const ok = await showConfirm(
      `Reset password for ${targetUser.name}?\n\nThey will need to use the new password immediately.`,
      { title: 'Confirm Password Reset' },
    );
    if (!ok) return;

    try {
      await authAPI.adminChangeUserPassword(targetUser.id, p1);
      addToast(`Password reset for ${targetUser.name}.`);
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to reset password.', 'error');
    }
  }, [showPrompt, showConfirm, addToast]);

  if (loading) {
    return <div className="apwt-loading">Loading password requests…</div>;
  }

  return (
    <div className="apwt-root">
      {/* ── Pending Requests ── */}
      <section className="apwt-section">
        <SectionHeader
          title="Password Change Requests"
          count={filteredRequests.length}
          sub="User-initiated password change requests awaiting admin approval"
        />
        {filteredRequests.length === 0 ? (
          <div className="apwt-empty">
            <p>No pending password requests{search ? ' matching the search' : ''}. Users are managing their passwords independently.</p>
          </div>
        ) : (
          <div className="apwt-table-wrap">
            <table className="apwt-table" aria-label="Password change requests">
              <thead>
                <tr>
                  <th scope="col">User</th>
                  <th scope="col">Email</th>
                  <th scope="col">Department</th>
                  <th scope="col">Submitted</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredRequests.map((req) => (
                  <tr key={req.requestId} className="apwt-row">
                    <td>
                      <div className="apwt-user-cell">
                        <UserAvatar avatar={req.user?.avatar} name={req.user?.name || '?'} size={30} />
                        <span className="apwt-user-name">{req.user?.name || 'Unknown'}</span>
                      </div>
                    </td>
                    <td><span className="apwt-cell">{req.user?.email || '—'}</span></td>
                    <td><span className="apwt-cell">{req.user?.department || '—'}</span></td>
                    <td><span className="apwt-cell apwt-cell--muted">{formatDateTime(req.requestedAt || req.createdAt)}</span></td>
                    <td>
                      <div className="apwt-actions">
                        <button
                          type="button"
                          className="apwt-btn apwt-btn--approve"
                          onClick={() => handleReviewRequest(req.requestId, true, req.user?.name)}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="apwt-btn apwt-btn--reject"
                          onClick={() => handleReviewRequest(req.requestId, false, req.user?.name)}
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
        )}
      </section>

      {/* ── Admin Password Reset ── */}
      <section className="apwt-section">
        <SectionHeader
          title="Admin Password Reset"
          sub="Force-set a new password for any user without their involvement"
        />
        <div className="apwt-table-wrap">
          <table className="apwt-table" aria-label="Admin password reset">
            <thead>
              <tr>
                <th scope="col">User</th>
                <th scope="col">Department</th>
                <th scope="col">Account Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {manualUsers.length === 0 && (
                <tr>
                  <td colSpan={4} className="apwt-empty-cell">
                    {search ? 'No users match the search.' : 'No eligible users.'}
                  </td>
                </tr>
              )}
              {manualUsers.map((u) => (
                <tr key={u.id} className="apwt-row">
                  <td>
                    <div className="apwt-user-cell">
                      <UserAvatar avatar={u.avatar} name={u.name} size={30} />
                      <div className="apwt-user-info">
                        <span className="apwt-user-name">{u.name}</span>
                        <span className="apwt-user-email">{u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td><span className="apwt-cell">{u.department || '—'}</span></td>
                  <td>
                    <span className={`apwt-status${u.isActive ? ' apwt-status--active' : ' apwt-status--inactive'}`}>
                      {u.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td>
                    <div className="apwt-actions">
                      <button
                        type="button"
                        className="apwt-btn apwt-btn--reset"
                        onClick={() => handleAdminReset(u)}
                      >
                        Reset Password
                      </button>
                      <button
                        type="button"
                        className="apwt-btn apwt-btn--view"
                        onClick={() => onViewUser(u)}
                      >
                        Profile
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <ToastStack toasts={toasts} />
    </div>
  );
}
