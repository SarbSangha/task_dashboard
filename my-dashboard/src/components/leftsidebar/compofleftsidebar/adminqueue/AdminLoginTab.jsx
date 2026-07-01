import React, { useCallback, useMemo, useRef, useState } from 'react';
import { authAPI } from '../../../../services/api';
import { UserAvatar } from '../../../common/UserAvatar';
import './AdminLoginTab.css';

const PAGE_SIZE = 50;

const FILTERS = [
  { value: 'all',      label: 'All Users' },
  { value: 'active',   label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
  { value: 'admin',    label: 'Admins' },
  { value: 'deleted',  label: 'Deleted' },
];

let _tid = 0;

// ─── Sub-components ───────────────────────────────────────────────────────────

function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="alt-toasts" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`alt-toast alt-toast--${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

function StatusBadge({ user }) {
  if (user.isDeleted) return <span className="alt-badge alt-badge--deleted">Deleted</span>;
  if (user.isAdmin)   return <span className="alt-badge alt-badge--admin">Admin</span>;
  if (user.isActive)  return <span className="alt-badge alt-badge--active">Active</span>;
  return <span className="alt-badge alt-badge--disabled">Disabled</span>;
}

function EmptyState({ children }) {
  return (
    <div className="alt-empty">
      <svg className="alt-empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.8" opacity=".25" />
        <circle cx="24" cy="20" r="7" stroke="currentColor" strokeWidth="1.8" opacity=".4" />
        <path d="M10 40c0-8 6.3-14 14-14s14 6 14 14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".4" />
      </svg>
      <p className="alt-empty-text">{children}</p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function AdminLoginTab({
  users, setUsers, search, loading,
  showConfirm, showPrompt, setMessage, onViewUser, onReload, formatDateTime,
}) {
  const [filter, setFilter]           = useState('all');
  const [selected, setSelected]       = useState(new Set());
  const [expanded, setExpanded]       = useState(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const [toasts, setToasts]           = useState([]);
  const [page, setPage]               = useState(1);

  const addToast = useCallback((msg, type = 'success') => {
    const id = ++_tid;
    setToasts((p) => [...p, { id, msg, type }]);
    setTimeout(() => setToasts((p) => p.filter((t) => t.id !== id)), 4000);
  }, []);

  // ── Filtering ──────────────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (q) {
        const hay = `${u.name} ${u.email} ${u.employeeId || ''} ${u.department || ''} ${(u.roles || []).join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case 'active':   return !u.isDeleted &&  u.isActive && !u.isAdmin;
        case 'inactive': return !u.isDeleted && !u.isActive && !u.isAdmin;
        case 'admin':    return !u.isDeleted &&  u.isAdmin;
        case 'deleted':  return !!u.isDeleted;
        default:         return !u.isDeleted;
      }
    });
  }, [users, search, filter]);

  const counts = useMemo(() => ({
    all:      users.filter((u) => !u.isDeleted).length,
    active:   users.filter((u) => !u.isDeleted &&  u.isActive && !u.isAdmin).length,
    inactive: users.filter((u) => !u.isDeleted && !u.isActive && !u.isAdmin).length,
    admin:    users.filter((u) => !u.isDeleted &&  u.isAdmin).length,
    deleted:  users.filter((u) =>  u.isDeleted).length,
  }), [users]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage   = Math.min(page, totalPages);
  const paged      = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const changeFilter = (v) => { setFilter(v); setPage(1); setSelected(new Set()); setExpanded(null); };

  // ── Selection ──────────────────────────────────────────────────────────────

  const allOnPage  = paged.length > 0 && paged.every((u) => selected.has(u.id));
  const someOnPage = paged.some((u) => selected.has(u.id)) && !allOnPage;

  const headerRef = useCallback((el) => { if (el) el.indeterminate = someOnPage; }, [someOnPage]);

  const toggleOne = useCallback((id) => {
    setSelected((p) => { const n = new Set(p); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }, []);

  const toggleAll = () => {
    if (allOnPage) setSelected((p) => { const n = new Set(p); paged.forEach((u) => n.delete(u.id)); return n; });
    else           setSelected((p) => { const n = new Set(p); paged.forEach((u) => n.add(u.id)); return n; });
  };

  // ── Individual actions ─────────────────────────────────────────────────────

  const handleToggleAccess = useCallback(async (targetUser) => {
    const isActive = targetUser.isActive;
    try {
      if (isActive) {
        const reason = (await showPrompt('Reason to remove login access:', {
          title: 'Remove Login Access', defaultValue: '',
        })) ?? '';
        await authAPI.deactivateUserAccess(targetUser.id, reason);
        setUsers((p) => p.map((u) => u.id === targetUser.id ? { ...u, isActive: false, rejectionReason: reason } : u));
        addToast(`Login access removed for ${targetUser.name}.`);
      } else {
        await authAPI.activateUserAccess(targetUser.id);
        setUsers((p) => p.map((u) => u.id === targetUser.id ? { ...u, isActive: true, rejectionReason: null } : u));
        addToast(`Login access restored for ${targetUser.name}.`);
      }
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to update login access.', 'error');
    }
  }, [showPrompt, setUsers, addToast]);

  const handleChangePassword = useCallback(async (targetUser) => {
    const p1 = await showPrompt(`New password for ${targetUser.name}:`, {
      title: 'Change Password', defaultValue: '', placeholder: 'Min 8 characters', inputType: 'password', confirmText: 'Continue',
    });
    if (p1 === null) return;
    if (!p1.trim() || p1.trim().length < 8) { addToast('Password must be at least 8 characters.', 'error'); return; }
    const p2 = await showPrompt('Confirm new password:', {
      title: 'Confirm Password', defaultValue: '', placeholder: 'Re-enter password', inputType: 'password', confirmText: 'Update Password',
    });
    if (p2 === null) return;
    if (p1 !== p2) { addToast('Passwords do not match.', 'error'); return; }
    try {
      await authAPI.adminChangeUserPassword(targetUser.id, p1);
      addToast(`Password updated for ${targetUser.name}.`);
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to update password.', 'error');
    }
  }, [showPrompt, addToast]);

  const handleDelete = useCallback(async (targetUser) => {
    const ok = await showConfirm(
      `Permanently delete account for ${targetUser.name} (${targetUser.email})?\n\nThis cannot be undone.`,
      { title: 'Delete Account' },
    );
    if (!ok) return;
    const reason = (await showPrompt('Reason for deletion (optional):', { title: 'Delete Reason', defaultValue: '' })) ?? '';
    try {
      await authAPI.deleteUserAccount(targetUser.id, reason);
      addToast(`Account deleted: ${targetUser.name}.`);
      await onReload();
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to delete account.', 'error');
    }
  }, [showConfirm, showPrompt, onReload, addToast]);

  // ── Bulk actions ───────────────────────────────────────────────────────────

  const handleBulkAccess = async (enable) => {
    const ids  = [...selected];
    const verb = enable ? 'Restore login access' : 'Remove login access';
    const ok   = await showConfirm(`${verb} for ${ids.length} user${ids.length !== 1 ? 's' : ''}?`, { title: `Bulk: ${verb}` });
    if (!ok) return;

    let reason = '';
    if (!enable) {
      reason = (await showPrompt('Reason (applied to all selected users):', { title: 'Bulk Disable Reason', defaultValue: '' })) ?? '';
    }

    setBulkLoading(true);
    let ok2 = 0; const errs = [];
    await Promise.allSettled(ids.map(async (id) => {
      try {
        if (enable) await authAPI.activateUserAccess(id);
        else await authAPI.deactivateUserAccess(id, reason);
        ok2++;
      } catch {
        const u = users.find((x) => x.id === id);
        if (u) errs.push(u.name);
      }
    }));
    await onReload();
    setBulkLoading(false);
    setSelected(new Set());

    if (errs.length) addToast(`Updated ${ok2} users. Failed: ${errs.join(', ')}.`, 'error');
    else addToast(`${enable ? 'Restored' : 'Removed'} login access for ${ok2} user${ok2 !== 1 ? 's' : ''}.`);
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="alt-root">
      {/* Filter chips */}
      <div className="alt-filters" role="group" aria-label="Filter users">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            className={`alt-chip${filter === f.value ? ' alt-chip--active' : ''}`}
            onClick={() => changeFilter(f.value)}
            aria-pressed={filter === f.value}
          >
            {f.label}
            <span className="alt-chip-n">{counts[f.value]}</span>
          </button>
        ))}
      </div>

      {/* Bulk toolbar */}
      {selected.size > 0 && (
        <div className="alt-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="alt-bulk-count">{selected.size} selected</span>
          <div className="alt-bulk-actions">
            <button type="button" className="alt-bulk-btn alt-bulk-btn--enable" onClick={() => handleBulkAccess(true)} disabled={bulkLoading}>Enable Login</button>
            <button type="button" className="alt-bulk-btn alt-bulk-btn--disable" onClick={() => handleBulkAccess(false)} disabled={bulkLoading}>Disable Login</button>
            <button type="button" className="alt-bulk-btn alt-bulk-btn--clear" onClick={() => setSelected(new Set())} disabled={bulkLoading}>Clear</button>
          </div>
        </div>
      )}

      {/* Table */}
      {loading ? (
        <EmptyState>Loading users…</EmptyState>
      ) : filtered.length === 0 ? (
        <EmptyState>{search || filter !== 'all' ? 'No users match the current filter.' : 'No users found.'}</EmptyState>
      ) : (
        <div className="alt-table-wrap">
          <table className="alt-table" aria-label="User login management">
            <thead>
              <tr>
                <th className="alt-col-chk" scope="col">
                  <input type="checkbox" className="alt-cb" checked={allOnPage} ref={headerRef} onChange={toggleAll} aria-label="Select all on this page" />
                </th>
                <th className="alt-col-user"    scope="col">User</th>
                <th className="alt-col-dept"    scope="col">Department</th>
                <th className="alt-col-role"    scope="col">Role</th>
                <th className="alt-col-status"  scope="col">Status</th>
                <th className="alt-col-login"   scope="col">Last Login</th>
                <th className="alt-col-actions" scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {paged.map((u) => {
                const isSel = selected.has(u.id);
                const isExp = expanded === u.id;
                const roleLabel = (u.roles || []).filter((r) => r !== 'user').join(', ') || (u.isAdmin ? 'Admin' : 'User');
                return (
                  <React.Fragment key={u.id}>
                    <tr className={`alt-row${isSel ? ' alt-row--sel' : ''}${isExp ? ' alt-row--exp' : ''}`}>
                      <td className="alt-col-chk">
                        <input type="checkbox" className="alt-cb" checked={isSel} onChange={() => toggleOne(u.id)} aria-label={`Select ${u.name}`} />
                      </td>
                      <td className="alt-col-user">
                        <div className="alt-user-cell">
                          <UserAvatar avatar={u.avatar} name={u.name} size={32} />
                          <div className="alt-user-info">
                            <span className="alt-user-name" title={u.name}>{u.name}</span>
                            <span className="alt-user-email" title={u.email}>{u.email}</span>
                          </div>
                        </div>
                      </td>
                      <td className="alt-col-dept"><span className="alt-cell">{u.department || '—'}</span></td>
                      <td className="alt-col-role"><span className="alt-cell">{roleLabel}</span></td>
                      <td className="alt-col-status"><StatusBadge user={u} /></td>
                      <td className="alt-col-login"><span className="alt-cell alt-cell--muted">{formatDateTime(u.lastLogin)}</span></td>
                      <td className="alt-col-actions">
                        <div className="alt-row-acts">
                          {!u.isDeleted && !u.isAdmin && (
                            <button
                              type="button"
                              className={`alt-act-btn${u.isActive ? ' alt-act-btn--disable' : ' alt-act-btn--enable'}`}
                              onClick={() => handleToggleAccess(u)}
                              aria-label={`${u.isActive ? 'Disable' : 'Enable'} login for ${u.name}`}
                            >
                              {u.isActive ? 'Disable' : 'Enable'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="alt-expand-btn"
                            onClick={() => setExpanded(isExp ? null : u.id)}
                            aria-expanded={isExp}
                            aria-label={`${isExp ? 'Collapse' : 'Expand'} row for ${u.name}`}
                          >
                            {isExp ? '▲' : '▼'}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {isExp && (
                      <tr className="alt-row-expand-row">
                        <td colSpan={7}>
                          <div className="alt-expand-inner">
                            {u.rejectionReason && (
                              <p className="alt-expand-note">
                                <strong>Disabled:</strong> {u.rejectionReason}
                              </p>
                            )}
                            {u.isDeleted && (
                              <p className="alt-expand-note alt-expand-note--danger">
                                <strong>Deleted:</strong> {formatDateTime(u.deletedAt)} · {u.deletedReason || 'No reason provided'}
                              </p>
                            )}
                            <div className="alt-expand-actions">
                              <button type="button" className="alt-expand-act" onClick={() => onViewUser(u)}>
                                View Full Profile
                              </button>
                              {!u.isDeleted && (
                                <button type="button" className="alt-expand-act" onClick={() => handleChangePassword(u)}>
                                  Change Password
                                </button>
                              )}
                              {!u.isDeleted && !u.isAdmin && (
                                <button type="button" className="alt-expand-act alt-expand-act--danger" onClick={() => handleDelete(u)}>
                                  Delete Account
                                </button>
                              )}
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="alt-pagination" role="navigation" aria-label="User list pagination">
          <span className="alt-page-info">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)} of {filtered.length} users
          </span>
          <div className="alt-page-ctrls">
            <button type="button" className="alt-page-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={safePage <= 1} aria-label="Previous page">‹</button>
            <span className="alt-page-ind" aria-current="page">{safePage} / {totalPages}</span>
            <button type="button" className="alt-page-btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages} aria-label="Next page">›</button>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}
