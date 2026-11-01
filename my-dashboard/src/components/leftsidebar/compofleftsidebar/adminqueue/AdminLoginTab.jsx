import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { authAPI } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import { UserAvatar } from '../../../common/UserAvatar';
import { getAvatarHue } from '../../../../utils/taskPresentation';
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

// Status is only about sign-in; whether someone is an admin lives in the
// Role column, so an admin no longer hides whether they can log in.
function StatusBadge({ user }) {
  if (user.isDeleted) return <span className="alt-status alt-status--deleted">Deleted</span>;
  if (user.isActive) return <span className="alt-status alt-status--active">Active</span>;
  return (
    <span className="alt-status alt-status--disabled" title={user.rejectionReason ? `Reason: ${user.rejectionReason}` : undefined}>
      Disabled
    </span>
  );
}

const POSITION_LABELS = { NORMAL: 'Member', HOD: 'Head of dept.', SPOC: 'SPOC', FACULTY: 'Faculty', ADMIN: 'Admin' };

function RoleCell({ user }) {
  if (user.isSuperAdmin) return <span className="alt-role alt-role--admin">Super admin</span>;
  if (user.isAdmin) return <span className="alt-role alt-role--admin">Admin</span>;
  const position = `${user.position || ''}`.trim().toUpperCase();
  const label = POSITION_LABELS[position] || (position ? tidyText(position) : 'Member');
  return <span className={`alt-role${position && position !== 'NORMAL' ? ' alt-role--lead' : ''}`}>{label}</span>;
}

// Departments arrive as typed at signup ("DIGITAL", "Data Analyst"); show
// all-caps names in title case so the column reads consistently.
function tidyText(value = '') {
  const text = `${value || ''}`.trim();
  if (!text || text !== text.toUpperCase() || text.length <= 3) return text;
  return text.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

function relativeTime(value) {
  if (!value) return null;
  const then = new Date(value).getTime();
  if (Number.isNaN(then)) return null;
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.round(days / 365);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
}

function AvatarWithHue({ user, size }) {
  return (
    <span
      className="alt-avatar"
      style={{ '--user-avatar-fallback-background': `hsl(${getAvatarHue(user.name || user.email)} 52% 48%)` }}
    >
      <UserAvatar avatar={user.avatar} name={user.name} size={size} />
    </span>
  );
}

// Row actions in a popover. Fixed-positioned from the trigger's rect so the
// table's overflow wrapper cannot clip it on the last rows.
function RowMenu({ anchor, items, onClose }) {
  const ref = useRef(null);
  useEffect(() => {
    const close = (event) => { if (!ref.current?.contains(event.target) && !anchor.el.contains(event.target)) onClose(); };
    const onKey = (event) => { if (event.key === 'Escape') onClose(); };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScroll);
    document.addEventListener('scroll', onScroll, true);
    ref.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScroll);
      document.removeEventListener('scroll', onScroll, true);
    };
  }, [anchor, onClose]);

  const rect = anchor.el.getBoundingClientRect();
  const estimatedHeight = items.length * 36 + 12;
  const openUp = rect.bottom + estimatedHeight > window.innerHeight - 8;
  const style = {
    right: Math.max(8, window.innerWidth - rect.right),
    ...(openUp ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }),
  };

  return (
    <div className="alt-menu" role="menu" ref={ref} style={style}>
      {items.map((item, index) => (item.divider ? (
        <div key={`d${index}`} className="alt-menu-divider" role="separator" />
      ) : (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`alt-menu-item${item.danger ? ' alt-menu-item--danger' : ''}`}
          onClick={() => { onClose(); item.onSelect(); }}
        >
          {item.label}
        </button>
      )))}
    </div>
  );
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
  filterRequest = null,
}) {
  const { user: currentUser } = useAuth();
  const [filter, setFilter]           = useState('all');
  const [selected, setSelected]       = useState(new Set());
  const [menu, setMenu]               = useState(null);
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

  const changeFilter = (v) => { setFilter(v); setPage(1); setSelected(new Set()); setMenu(null); };

  // A click on a header stat (Active / Disabled / Admins / Users) opens this
  // tab with the matching filter applied.
  useEffect(() => {
    if (filterRequest?.value) changeFilter(filterRequest.value);
  }, [filterRequest?.nonce]);

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

  const handleToggleAdmin = useCallback(async (targetUser) => {
    const grant = !targetUser.isAdmin;
    const ok = await showConfirm(
      grant
        ? `Give ${targetUser.name} (${targetUser.email}) full admin access?

They will be able to manage users, approvals and every admin setting.`
        : `Remove admin access from ${targetUser.name} (${targetUser.email})?`,
      { title: grant ? 'Make Admin' : 'Remove Admin' },
    );
    if (!ok) return;
    try {
      const res = await authAPI.setUserAdminAccess(targetUser.id, grant);
      setUsers((p) => p.map((u) => (u.id === targetUser.id ? { ...u, ...res.user } : u)));
      addToast(grant ? `${targetUser.name} is now an admin.` : `Admin access removed from ${targetUser.name}.`);
    } catch (e) {
      addToast(e?.response?.data?.detail || 'Failed to update admin access.', 'error');
    }
  }, [showConfirm, setUsers, addToast]);

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

  // ── Row menu ───────────────────────────────────────────────────────────────

  const closeMenu = useCallback(() => setMenu(null), []);

  const menuItems = (u) => {
    const isSelf = u.id === currentUser?.id;
    const items = [{ label: 'Open profile', onSelect: () => onViewUser(u) }];
    if (u.isDeleted) return items;
    if (!u.isSuperAdmin || isSelf) items.push({ label: 'Change password', onSelect: () => handleChangePassword(u) });
    if (!u.isSuperAdmin && !isSelf && (u.isAdmin || u.isActive)) {
      items.push({ label: u.isAdmin ? 'Remove admin access' : 'Make admin', onSelect: () => handleToggleAdmin(u) });
    }
    if (!u.isAdmin) {
      items.push({ divider: true });
      items.push({ label: 'Delete account…', danger: true, onSelect: () => handleDelete(u) });
    }
    return items;
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
                <th className="alt-col-login"   scope="col">Last login</th>
                <th className="alt-col-actions" scope="col"><span className="alt-sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {paged.map((u) => {
                const isSel = selected.has(u.id);
                const isSelf = u.id === currentUser?.id;
                const lastLogin = relativeTime(u.lastLogin);
                const deletedAgo = relativeTime(u.deletedAt);
                const extraRoles = (u.roles || []).filter((r) => !['user', 'admin', 'root', 'super_admin'].includes(r));
                // Clicks on the checkbox / buttons keep their own meaning.
                const openRow = (event) => {
                  if (event.target.closest('button, input, a')) return;
                  onViewUser(u);
                };
                return (
                  <tr
                    key={u.id}
                    className={`alt-row alt-row--clickable${isSel ? ' alt-row--sel' : ''}${!u.isActive && !u.isDeleted ? ' alt-row--muted' : ''}`}
                    onClick={openRow}
                  >
                    <td className="alt-col-chk">
                      <input type="checkbox" className="alt-cb" checked={isSel} onChange={() => toggleOne(u.id)} aria-label={`Select ${u.name}`} />
                    </td>
                    <td className="alt-col-user">
                      <div className="alt-user-cell">
                        <AvatarWithHue user={u} size={34} />
                        <div className="alt-user-info">
                          <button type="button" className="alt-user-name" title={`Open ${u.name}'s profile`} onClick={() => onViewUser(u)}>
                            {u.name}
                            {isSelf && <span className="alt-you">You</span>}
                          </button>
                          <span className="alt-user-email" title={u.email}>{u.email}</span>
                        </div>
                      </div>
                    </td>
                    <td className="alt-col-dept">
                      <span className="alt-cell">{tidyText(u.department) || <span className="alt-cell--muted">—</span>}</span>
                      {u.employeeId && <span className="alt-sub" title={u.employeeId}>{u.employeeId}</span>}
                    </td>
                    <td className="alt-col-role">
                      <RoleCell user={u} />
                      {extraRoles.length > 0 && <span className="alt-sub">{extraRoles.map(tidyText).join(', ')}</span>}
                    </td>
                    <td className="alt-col-status"><StatusBadge user={u} /></td>
                    <td className="alt-col-login">
                      {u.isDeleted ? (
                        <span className="alt-cell alt-cell--muted" title={formatDateTime(u.deletedAt)}>
                          Deleted {deletedAgo ? deletedAgo.toLowerCase() : ''}
                        </span>
                      ) : lastLogin ? (
                        <span className="alt-cell" title={formatDateTime(u.lastLogin)}>{lastLogin}</span>
                      ) : (
                        <span className="alt-cell alt-cell--muted">Never</span>
                      )}
                    </td>
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
                          className={`alt-more-btn${menu?.user.id === u.id ? ' is-open' : ''}`}
                          onClick={(event) => {
                            const el = event.currentTarget;
                            setMenu((prev) => (prev?.user.id === u.id ? null : { user: u, el }));
                          }}
                          aria-haspopup="menu"
                          aria-expanded={menu?.user.id === u.id}
                          aria-label={`More actions for ${u.name}`}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                            <circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
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

      {menu && (
        <RowMenu
          anchor={menu}
          onClose={closeMenu}
          items={menuItems(menu.user)}
        />
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}
