import React, { useCallback, useMemo, useRef, useState } from 'react';
import { UserAvatar } from '../../../common/UserAvatar';
import { authAPI } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import './WorkplacePolicyPanel.css';

const PAGE_SIZE = 50;

const FILTERS = [
  { value: 'all', label: 'All Eligible' },
  { value: 'enabled', label: 'Policy On' },
  { value: 'disabled', label: 'Policy Off' },
  { value: 'active', label: 'Active' },
  { value: 'inactive', label: 'Inactive' },
];

let _toastId = 0;

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ value, label, variant }) {
  return (
    <div className={`wpp-stat-card wpp-stat-card--${variant}`} role="status" aria-label={`${label}: ${value}`}>
      <span className="wpp-stat-value">{value}</span>
      <span className="wpp-stat-label">{label}</span>
    </div>
  );
}

// ─── Policy Row ───────────────────────────────────────────────────────────────

function PolicyRow({ user, selected, onToggleSelect, onTogglePolicy, onViewInfo }) {
  const isPolicyOn = !!user.enforceActiveTaskPolicy;
  const isActive = !!user.isActive;

  return (
    <tr className={`wpp-row${selected ? ' wpp-row--selected' : ''}`}>
      <td className="wpp-col-check">
        <input
          type="checkbox"
          className="wpp-checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${user.name}`}
        />
      </td>
      <td className="wpp-col-user">
        <div className="wpp-user-cell">
          <UserAvatar avatar={user.avatar} name={user.name} size={30} />
          <div className="wpp-user-info">
            <span className="wpp-user-name" title={user.name}>{user.name}</span>
            <span className="wpp-user-email" title={user.email}>{user.email}</span>
          </div>
        </div>
      </td>
      <td className="wpp-col-dept">
        <span className="wpp-cell-text">{user.department || '—'}</span>
      </td>
      <td className="wpp-col-position">
        <span className="wpp-cell-text">{user.position || '—'}</span>
      </td>
      <td className="wpp-col-access">
        <span className={`wpp-badge wpp-access-badge--${isActive ? 'active' : 'inactive'}`}>
          {isActive ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td className="wpp-col-policy">
        <span className={`wpp-badge wpp-policy-badge--${isPolicyOn ? 'on' : 'off'}`}>
          {isPolicyOn ? 'Enabled' : 'Disabled'}
        </span>
      </td>
      <td className="wpp-col-actions">
        <div className="wpp-row-actions">
          <button
            type="button"
            className={`wpp-row-btn wpp-row-policy-btn${isPolicyOn ? ' wpp-row-policy-btn--on' : ''}`}
            onClick={onTogglePolicy}
            aria-label={`${isPolicyOn ? 'Disable' : 'Enable'} policy for ${user.name}`}
          >
            {isPolicyOn ? 'Disable' : 'Enable'}
          </button>
          <button
            type="button"
            className="wpp-row-btn wpp-row-info-btn"
            onClick={onViewInfo}
            aria-label={`View info for ${user.name}`}
          >
            Info
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─── Toast Stack ──────────────────────────────────────────────────────────────

function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="wpp-toast-stack" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`wpp-toast wpp-toast--${t.type}`}>
          {t.msg}
        </div>
      ))}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

function WorkplacePolicyPanel({ users, setUsers, onViewInfo, loading }) {
  const { showConfirm } = useCustomDialogs();
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [toasts, setToasts] = useState([]);
  const selectAllRef = useRef(null);

  const addToast = useCallback((msg, type = 'success') => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  // Non-admin, non-deleted users are eligible for this policy
  const eligibleUsers = useMemo(
    () => users.filter((u) => !u.isAdmin && !u.isDeleted),
    [users]
  );

  const stats = useMemo(() => {
    const admins = users.filter((u) => u.isAdmin && !u.isDeleted).length;
    const enabled = eligibleUsers.filter((u) => u.enforceActiveTaskPolicy).length;
    return {
      total: eligibleUsers.length,
      enabled,
      disabled: eligibleUsers.length - enabled,
      admins,
    };
  }, [users, eligibleUsers]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return eligibleUsers.filter((u) => {
      if (q) {
        const hay = `${u.name} ${u.email} ${u.employeeId || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case 'enabled':  return !!u.enforceActiveTaskPolicy;
        case 'disabled': return !u.enforceActiveTaskPolicy;
        case 'active':   return !!u.isActive;
        case 'inactive': return !u.isActive;
        default:         return true;
      }
    });
  }, [eligibleUsers, search, filter]);

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedUsers = filteredUsers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const changeSearch = (v) => { setSearch(v); setPage(1); };
  const changeFilter = (v) => { setFilter(v); setPage(1); };

  // ── Selection helpers ────────────────────────────────────────────────────────

  const isSelected = (id) => selected.has(id);

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const allOnPage = pagedUsers.length > 0 && pagedUsers.every((u) => selected.has(u.id));
  const someOnPage = pagedUsers.some((u) => selected.has(u.id)) && !allOnPage;

  // Sync indeterminate attribute via ref callback
  const headerCheckboxRef = useCallback((el) => {
    if (el) el.indeterminate = someOnPage;
  }, [someOnPage]);

  const toggleAllOnPage = () => {
    if (allOnPage) {
      setSelected((prev) => {
        const next = new Set(prev);
        pagedUsers.forEach((u) => next.delete(u.id));
        return next;
      });
    } else {
      setSelected((prev) => {
        const next = new Set(prev);
        pagedUsers.forEach((u) => next.add(u.id));
        return next;
      });
    }
  };

  const clearSelection = () => setSelected(new Set());

  // ── Individual toggle ────────────────────────────────────────────────────────

  const handleTogglePolicy = useCallback(async (targetUser) => {
    const next = !targetUser.enforceActiveTaskPolicy;
    try {
      const res = await authAPI.setUserWorkplacePolicy(targetUser.id, next);
      const updated = res?.user;
      setUsers((prev) =>
        prev.map((u) =>
          u.id === targetUser.id
            ? { ...u, enforceActiveTaskPolicy: updated?.enforceActiveTaskPolicy ?? next }
            : u
        )
      );
      addToast(`Policy ${next ? 'enabled' : 'disabled'} for ${targetUser.name}.`);
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Failed to update policy.', 'error');
    }
  }, [setUsers, addToast]);

  // ── Bulk action ──────────────────────────────────────────────────────────────

  const handleBulkPolicy = async (enable) => {
    const ids = [...selected];
    const label = enable ? 'Enable' : 'Disable';
    const confirmed = await showConfirm(
      `${label} "No Active Task → No Workplace Tools" policy for ${ids.length} user${ids.length !== 1 ? 's' : ''}?`,
      { title: `${label} Workplace Policy` }
    );
    if (!confirmed) return;

    setBulkLoading(true);
    try {
      await authAPI.bulkSetWorkplacePolicy(ids, enable);
      setUsers((prev) =>
        prev.map((u) =>
          ids.includes(u.id) ? { ...u, enforceActiveTaskPolicy: enable } : u
        )
      );
      addToast(`Policy ${enable ? 'enabled' : 'disabled'} for ${ids.length} user${ids.length !== 1 ? 's' : ''}.`);
      clearSelection();
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Bulk update failed.', 'error');
    } finally {
      setBulkLoading(false);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="wpp-root">

      {/* ── Stat Cards ── */}
      <div className="wpp-stats">
        <StatCard value={stats.total}    label="Eligible Users"  variant="neutral"  />
        <StatCard value={stats.enabled}  label="Policy Enabled"  variant="enabled"  />
        <StatCard value={stats.disabled} label="Policy Disabled" variant="disabled" />
        <StatCard value={stats.admins}   label="Admins (exempt)" variant="admin"    />
      </div>

      {/* ── Controls: search + filter chips ── */}
      <div className="wpp-controls">
        <div className="wpp-search-wrap">
          <svg className="wpp-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
            <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6"/>
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
          </svg>
          <input
            type="search"
            className="wpp-search"
            placeholder="Search by name, email, or employee ID…"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
            aria-label="Search eligible users"
          />
          {search && (
            <button
              type="button"
              className="wpp-search-clear"
              onClick={() => changeSearch('')}
              aria-label="Clear search"
            >
              ✕
            </button>
          )}
        </div>

        <div className="wpp-filters" role="group" aria-label="Filter users by policy status">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`wpp-filter-chip${filter === f.value ? ' active' : ''}`}
              onClick={() => changeFilter(f.value)}
              aria-pressed={filter === f.value}
            >
              {f.label}
              {f.value !== 'all' && (
                <span className="wpp-filter-count">
                  {f.value === 'enabled'  && stats.enabled}
                  {f.value === 'disabled' && stats.disabled}
                  {f.value === 'active'   && eligibleUsers.filter((u) => u.isActive).length}
                  {f.value === 'inactive' && eligibleUsers.filter((u) => !u.isActive).length}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* ── Bulk toolbar ── */}
      {selected.size > 0 && (
        <div className="wpp-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="wpp-bulk-count">
            {selected.size} user{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="wpp-bulk-actions">
            <button
              type="button"
              className="wpp-bulk-btn wpp-bulk-btn--enable"
              onClick={() => handleBulkPolicy(true)}
              disabled={bulkLoading}
            >
              Enable Policy
            </button>
            <button
              type="button"
              className="wpp-bulk-btn wpp-bulk-btn--disable"
              onClick={() => handleBulkPolicy(false)}
              disabled={bulkLoading}
            >
              Disable Policy
            </button>
            <button
              type="button"
              className="wpp-bulk-btn wpp-bulk-btn--clear"
              onClick={clearSelection}
              disabled={bulkLoading}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="wpp-table-wrap">
        <table className="wpp-table" aria-label="Workplace access policy — user list">
          <thead>
            <tr>
              <th className="wpp-col-check" scope="col">
                <input
                  type="checkbox"
                  className="wpp-checkbox"
                  checked={allOnPage}
                  ref={headerCheckboxRef}
                  onChange={toggleAllOnPage}
                  aria-label="Select all users on this page"
                />
              </th>
              <th className="wpp-col-user"     scope="col">User</th>
              <th className="wpp-col-dept"     scope="col">Department</th>
              <th className="wpp-col-position" scope="col">Position</th>
              <th className="wpp-col-access"   scope="col">Access</th>
              <th className="wpp-col-policy"   scope="col">Policy</th>
              <th className="wpp-col-actions"  scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={7} className="wpp-empty">Loading users…</td>
              </tr>
            )}
            {!loading && pagedUsers.length === 0 && (
              <tr>
                <td colSpan={7} className="wpp-empty">
                  {search || filter !== 'all'
                    ? 'No users match the current filter.'
                    : 'No eligible users found.'}
                </td>
              </tr>
            )}
            {pagedUsers.map((u) => (
              <PolicyRow
                key={u.id}
                user={u}
                selected={isSelected(u.id)}
                onToggleSelect={() => toggleSelect(u.id)}
                onTogglePolicy={() => handleTogglePolicy(u)}
                onViewInfo={() => onViewInfo(u)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="wpp-pagination" role="navigation" aria-label="User list pagination">
          <span className="wpp-pagination-info">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredUsers.length)} of {filteredUsers.length} users
          </span>
          <div className="wpp-pagination-controls">
            <button
              type="button"
              className="wpp-page-btn"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="wpp-page-indicator" aria-current="page">
              {safePage} / {totalPages}
            </span>
            <button
              type="button"
              className="wpp-page-btn"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              aria-label="Next page"
            >
              ›
            </button>
          </div>
        </div>
      )}

      {/* ── Toasts ── */}
      <ToastStack toasts={toasts} />
    </div>
  );
}

export default WorkplacePolicyPanel;
