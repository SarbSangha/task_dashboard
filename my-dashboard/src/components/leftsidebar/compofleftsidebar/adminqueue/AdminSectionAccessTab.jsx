import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../common/UserAvatar';
import { authAPI } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import './AdminSectionAccessTab.css';

/**
 * Section Access - grants the deny-by-default Insight sidebar sections
 * (RMW Data, Buffer) to individual users.
 *
 * Structurally a sibling of WorkplacePolicyPanel (same stats/search/filter/
 * bulk/table/pagination shape) with one difference that drives the layout:
 * a user has a separate on/off state per section, not one policy flag, so
 * each gated section gets its own column and its own pair of bulk buttons.
 * The column set comes from the server's catalog endpoint, so adding a
 * feature to GATED_FEATURES on the backend surfaces a column here with no
 * change to this file.
 *
 * Admins are listed but not toggleable - they bypass the grant table
 * server-side, and showing them as permanently "Granted" is the honest
 * rendering of that.
 */

const PAGE_SIZE = 50;

// Rendered until the catalog request resolves, so the table does not
// reflow from zero columns on open. Must match GATED_FEATURES ordering in
// backend/services/feature_access_service.py.
const FALLBACK_FEATURES = [
  { key: 'rmw_data', label: 'RMW Data' },
  { key: 'buffer', label: 'Buffer' },
];

let _toastId = 0;

const hasFeature = (user, key) => !!(user?.featureAccess && user.featureAccess[key]);
const isExempt = (user) => !!(user?.isFeatureExempt || user?.isAdmin);

// ─── Stat Card ────────────────────────────────────────────────────────────────

function StatCard({ value, label, variant }) {
  return (
    <div className={`sap-stat-card sap-stat-card--${variant}`} role="status" aria-label={`${label}: ${value}`}>
      <span className="sap-stat-value">{value}</span>
      <span className="sap-stat-label">{label}</span>
    </div>
  );
}

// ─── Access Row ───────────────────────────────────────────────────────────────

function AccessRow({ user, features, selected, pending, onToggleSelect, onToggleFeature, onViewInfo }) {
  const exempt = isExempt(user);
  const isActive = !!user.isActive;

  return (
    <tr className={`sap-row${selected ? ' sap-row--selected' : ''}`}>
      <td className="sap-col-check">
        <input
          type="checkbox"
          className="sap-checkbox"
          checked={selected}
          onChange={onToggleSelect}
          disabled={exempt}
          aria-label={`Select ${user.name}`}
        />
      </td>
      <td className="sap-col-user">
        <div className="sap-user-cell">
          <UserAvatar avatar={user.avatar} name={user.name} size={30} />
          <div className="sap-user-info">
            <span className="sap-user-name" title={user.name}>{user.name}</span>
            <span className="sap-user-email" title={user.email}>{user.email}</span>
          </div>
        </div>
      </td>
      <td className="sap-col-dept">
        <span className="sap-cell-text">{user.department || '—'}</span>
      </td>
      <td className="sap-col-access">
        <span className={`sap-badge sap-access-badge--${isActive ? 'active' : 'inactive'}`}>
          {isActive ? 'Active' : 'Inactive'}
        </span>
      </td>

      {features.map((f) => {
        const granted = exempt || hasFeature(user, f.key);
        const busy = pending.has(`${user.id}:${f.key}`);
        return (
          <td className="sap-col-feature" key={f.key}>
            {exempt ? (
              <span className="sap-badge sap-feature-badge--exempt" title="Admins always have access">
                Always
              </span>
            ) : (
              <button
                type="button"
                className={`sap-toggle${granted ? ' sap-toggle--on' : ''}`}
                onClick={() => onToggleFeature(user, f)}
                disabled={busy}
                role="switch"
                aria-checked={granted}
                aria-label={`${granted ? 'Revoke' : 'Grant'} ${f.label} for ${user.name}`}
                title={`${granted ? 'Revoke' : 'Grant'} ${f.label}`}
              >
                <span className="sap-toggle-track" aria-hidden="true">
                  <span className="sap-toggle-thumb" />
                </span>
                <span className="sap-toggle-text">{granted ? 'Granted' : 'Hidden'}</span>
              </button>
            )}
          </td>
        );
      })}

      <td className="sap-col-actions">
        <button
          type="button"
          className="sap-row-btn sap-row-info-btn"
          onClick={onViewInfo}
          aria-label={`View info for ${user.name}`}
        >
          Info
        </button>
      </td>
    </tr>
  );
}

// ─── Toast Stack ──────────────────────────────────────────────────────────────

function ToastStack({ toasts }) {
  if (!toasts.length) return null;
  return (
    <div className="sap-toast-stack" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`sap-toast sap-toast--${t.type}`}>{t.msg}</div>
      ))}
    </div>
  );
}

// ─── Main Panel ───────────────────────────────────────────────────────────────

function AdminSectionAccessTab({ users, setUsers, onViewInfo, loading }) {
  const { showConfirm } = useCustomDialogs();
  const [features, setFeatures] = useState(FALLBACK_FEATURES);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState(new Set());
  const [pending, setPending] = useState(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'success') => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  // Keep the fallback columns if the catalog call fails - losing the
  // endpoint should not leave an admin with a table they cannot act on.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await authAPI.getFeatureAccessCatalog();
        if (!cancelled && Array.isArray(res?.features) && res.features.length) {
          setFeatures(res.features);
        }
      } catch {
        /* keep FALLBACK_FEATURES */
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const visibleUsers = useMemo(() => users.filter((u) => !u.isDeleted), [users]);
  const grantableUsers = useMemo(() => visibleUsers.filter((u) => !isExempt(u)), [visibleUsers]);

  const stats = useMemo(() => {
    const perFeature = {};
    features.forEach((f) => {
      perFeature[f.key] = grantableUsers.filter((u) => hasFeature(u, f.key)).length;
    });
    return {
      total: grantableUsers.length,
      admins: visibleUsers.length - grantableUsers.length,
      perFeature,
    };
  }, [visibleUsers, grantableUsers, features]);

  const filterOptions = useMemo(() => {
    const opts = [{ value: 'all', label: 'All Users' }];
    features.forEach((f) => {
      opts.push({ value: `has:${f.key}`, label: `${f.label}: Granted`, count: stats.perFeature[f.key] || 0 });
      opts.push({
        value: `no:${f.key}`,
        label: `${f.label}: Hidden`,
        count: stats.total - (stats.perFeature[f.key] || 0),
      });
    });
    opts.push({ value: 'none', label: 'No Sections' });
    return opts;
  }, [features, stats]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleUsers.filter((u) => {
      if (q) {
        const hay = `${u.name} ${u.email} ${u.employeeId || ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (filter === 'all') return true;
      if (filter === 'none') {
        return !isExempt(u) && features.every((f) => !hasFeature(u, f.key));
      }
      const [mode, key] = filter.split(':');
      if (!key) return true;
      const granted = isExempt(u) || hasFeature(u, key);
      return mode === 'has' ? granted : !granted;
    });
  }, [visibleUsers, search, filter, features]);

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedUsers = filteredUsers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const changeSearch = (v) => { setSearch(v); setPage(1); };
  const changeFilter = (v) => { setFilter(v); setPage(1); };

  // ── Selection ────────────────────────────────────────────────────────────────

  // Admins are skipped: the server refuses to change them, so letting them
  // into a selection would only produce "skipped" results.
  const selectablePaged = useMemo(() => pagedUsers.filter((u) => !isExempt(u)), [pagedUsers]);
  const allOnPage = selectablePaged.length > 0 && selectablePaged.every((u) => selected.has(u.id));
  const someOnPage = selectablePaged.some((u) => selected.has(u.id)) && !allOnPage;

  const headerCheckboxRef = useCallback((el) => {
    if (el) el.indeterminate = someOnPage;
  }, [someOnPage]);

  const toggleSelect = useCallback((id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllOnPage = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      selectablePaged.forEach((u) => (allOnPage ? next.delete(u.id) : next.add(u.id)));
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  // ── Individual toggle ────────────────────────────────────────────────────────

  const handleToggleFeature = useCallback(async (targetUser, feature) => {
    const next = !hasFeature(targetUser, feature.key);
    const pendingKey = `${targetUser.id}:${feature.key}`;
    setPending((prev) => new Set(prev).add(pendingKey));
    try {
      const res = await authAPI.setUserFeatureAccess(targetUser.id, feature.key, next);
      const updated = res?.user;
      setUsers((prev) =>
        prev.map((u) =>
          u.id === targetUser.id
            ? {
                ...u,
                featureAccess:
                  updated?.featureAccess ?? { ...(u.featureAccess || {}), [feature.key]: next },
              }
            : u
        )
      );
      addToast(`${feature.label} ${next ? 'granted to' : 'hidden from'} ${targetUser.name}.`);
    } catch (err) {
      addToast(err?.response?.data?.detail || `Failed to update ${feature.label} access.`, 'error');
    } finally {
      setPending((prev) => {
        const nextSet = new Set(prev);
        nextSet.delete(pendingKey);
        return nextSet;
      });
    }
  }, [setUsers, addToast]);

  // ── Bulk action ──────────────────────────────────────────────────────────────

  const handleBulk = async (feature, enable) => {
    const ids = [...selected];
    if (!ids.length) return;
    const verb = enable ? 'Grant' : 'Hide';
    const confirmed = await showConfirm(
      `${verb} ${feature.label} for ${ids.length} user${ids.length !== 1 ? 's' : ''}?`,
      { title: `${verb} ${feature.label}` }
    );
    if (!confirmed) return;

    setBulkLoading(true);
    try {
      const res = await authAPI.bulkSetFeatureAccess(ids, feature.key, enable);
      setUsers((prev) =>
        prev.map((u) =>
          ids.includes(u.id) && !isExempt(u)
            ? { ...u, featureAccess: { ...(u.featureAccess || {}), [feature.key]: enable } }
            : u
        )
      );
      const changed = res?.updatedCount ?? ids.length;
      addToast(`${feature.label} ${enable ? 'granted to' : 'hidden from'} ${changed} user${changed !== 1 ? 's' : ''}.`);
      clearSelection();
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Bulk update failed.', 'error');
    } finally {
      setBulkLoading(false);
    }
  };

  const columnCount = 5 + features.length;

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="sap-root">

      <p className="sap-intro">
        These sections are hidden by default. A user sees <strong>RMW Data</strong> or{' '}
        <strong>Buffer</strong> in their sidebar only while granted here — revoking also blocks
        the section&apos;s data, not just the menu item. Admins always have access.
      </p>

      {/* ── Stat Cards ── */}
      <div className="sap-stats">
        <StatCard value={stats.total} label="Grantable Users" variant="neutral" />
        {features.map((f) => (
          <StatCard key={f.key} value={stats.perFeature[f.key] || 0} label={`${f.label} Granted`} variant="granted" />
        ))}
        <StatCard value={stats.admins} label="Admins (always)" variant="admin" />
      </div>

      {/* ── Controls ── */}
      <div className="sap-controls">
        <div className="sap-search-wrap">
          <svg className="sap-search-icon" viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
            <circle cx="9" cy="9" r="5.5" stroke="currentColor" strokeWidth="1.6" />
            <path d="M13.5 13.5L17 17" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            className="sap-search"
            placeholder="Search by name, email, or employee ID…"
            value={search}
            onChange={(e) => changeSearch(e.target.value)}
            aria-label="Search users"
          />
          {search && (
            <button type="button" className="sap-search-clear" onClick={() => changeSearch('')} aria-label="Clear search">
              ✕
            </button>
          )}
        </div>

        <div className="sap-filters" role="group" aria-label="Filter users by section access">
          {filterOptions.map((f) => (
            <button
              key={f.value}
              type="button"
              className={`sap-filter-chip${filter === f.value ? ' active' : ''}`}
              onClick={() => changeFilter(f.value)}
              aria-pressed={filter === f.value}
            >
              {f.label}
              {typeof f.count === 'number' && <span className="sap-filter-count">{f.count}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── Bulk toolbar ── */}
      {selected.size > 0 && (
        <div className="sap-bulk-bar" role="toolbar" aria-label="Bulk actions">
          <span className="sap-bulk-count">
            {selected.size} user{selected.size !== 1 ? 's' : ''} selected
          </span>
          <div className="sap-bulk-actions">
            {features.map((f) => (
              <span className="sap-bulk-group" key={f.key}>
                <span className="sap-bulk-group-label">{f.label}</span>
                <button
                  type="button"
                  className="sap-bulk-btn sap-bulk-btn--grant"
                  onClick={() => handleBulk(f, true)}
                  disabled={bulkLoading}
                >
                  Grant
                </button>
                <button
                  type="button"
                  className="sap-bulk-btn sap-bulk-btn--revoke"
                  onClick={() => handleBulk(f, false)}
                  disabled={bulkLoading}
                >
                  Hide
                </button>
              </span>
            ))}
            <button
              type="button"
              className="sap-bulk-btn sap-bulk-btn--clear"
              onClick={clearSelection}
              disabled={bulkLoading}
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {/* ── Table ── */}
      <div className="sap-table-wrap">
        <table className="sap-table" aria-label="Section access — user list">
          <thead>
            <tr>
              <th className="sap-col-check" scope="col">
                <input
                  type="checkbox"
                  className="sap-checkbox"
                  checked={allOnPage}
                  ref={headerCheckboxRef}
                  onChange={toggleAllOnPage}
                  disabled={selectablePaged.length === 0}
                  aria-label="Select all users on this page"
                />
              </th>
              <th className="sap-col-user" scope="col">User</th>
              <th className="sap-col-dept" scope="col">Department</th>
              <th className="sap-col-access" scope="col">Account</th>
              {features.map((f) => (
                <th className="sap-col-feature" scope="col" key={f.key}>{f.label}</th>
              ))}
              <th className="sap-col-actions" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={columnCount} className="sap-empty">Loading users…</td></tr>
            )}
            {!loading && pagedUsers.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="sap-empty">
                  {search || filter !== 'all' ? 'No users match the current filter.' : 'No users found.'}
                </td>
              </tr>
            )}
            {!loading && pagedUsers.map((u) => (
              <AccessRow
                key={u.id}
                user={u}
                features={features}
                selected={selected.has(u.id)}
                pending={pending}
                onToggleSelect={() => toggleSelect(u.id)}
                onToggleFeature={handleToggleFeature}
                onViewInfo={() => onViewInfo(u)}
              />
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Pagination ── */}
      {totalPages > 1 && (
        <div className="sap-pagination" role="navigation" aria-label="User list pagination">
          <span className="sap-pagination-info">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredUsers.length)} of {filteredUsers.length} users
          </span>
          <div className="sap-pagination-controls">
            <button
              type="button"
              className="sap-page-btn"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1}
              aria-label="Previous page"
            >
              ‹
            </button>
            <span className="sap-page-indicator" aria-current="page">{safePage} / {totalPages}</span>
            <button
              type="button"
              className="sap-page-btn"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages}
              aria-label="Next page"
            >
              ›
            </button>
          </div>
        </div>
      )}

      <ToastStack toasts={toasts} />
    </div>
  );
}

export default AdminSectionAccessTab;
