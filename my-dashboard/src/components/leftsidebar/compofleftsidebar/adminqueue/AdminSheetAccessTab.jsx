import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../common/UserAvatar';
import { authAPI } from '../../../../services/api';
import { sheetsAPI } from '../../../../services/sheets';
import './AdminSectionAccessTab.css';
import './AdminSheetAccessTab.css';

/**
 * Sheet Access - per sheet, per person: does this person see the sheet in
 * the Sheets section, and may they use its Open / Open in Google Sheets /
 * Settings buttons. Backend: GET /api/sheets/access and
 * PUT /api/sheets/{id}/access/{userId} (routers/sheets_router.py), which
 * also enforce each permission on the sheet's own endpoints.
 *
 * Reuses the Section Access tab's look (sap-* classes). Seeing the Sheets
 * section at all, and being allowed to add sheets, are still the "Sheets"
 * and "Add Sheets" grants in Section Access. Giving someone a sheet here
 * grants "Sheets" too (server-side); anyone still without it gets a Grant
 * button, since they cannot reach their sheets until they have it.
 */

const PAGE_SIZE = 50;

const PERMISSIONS = [
  { key: 'open', label: 'Open' },
  { key: 'openInGoogle', label: 'Open in Google Sheets' },
  { key: 'settings', label: 'Settings' },
];

// What a person gets when first given a sheet; matches the server defaults.
const DEFAULT_ACCESS = { open: true, openInGoogle: true, settings: false };

let _toastId = 0;

const isExempt = (user) => !!(user?.isFeatureExempt || user?.isAdmin);
const hasSheetsSection = (user) => isExempt(user) || !!user?.featureAccess?.sheet_activity;

function Toggle({ on, busy, label, onChange, text }) {
  return (
    <button
      type="button"
      className={`sap-toggle${on ? ' sap-toggle--on' : ''}`}
      onClick={onChange}
      disabled={busy}
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
    >
      <span className="sap-toggle-track" aria-hidden="true">
        <span className="sap-toggle-thumb" />
      </span>
      <span className="sap-toggle-text">{text ?? (on ? 'Allowed' : 'Off')}</span>
    </button>
  );
}

function AdminSheetAccessTab({ users, setUsers, onViewInfo, loading: usersLoading }) {
  const [sheets, setSheets] = useState([]);
  const [sheetId, setSheetId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [pending, setPending] = useState(new Set());
  const [page, setPage] = useState(1);
  const [toasts, setToasts] = useState([]);

  const addToast = useCallback((msg, type = 'success') => {
    const id = ++_toastId;
    setToasts((prev) => [...prev, { id, msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await sheetsAPI.accessOverview();
      const list = d?.sheets || [];
      setSheets(list);
      setSheetId((cur) => (list.some((s) => s.id === cur) ? cur : list[0]?.id ?? null));
      setError('');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Could not load sheets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const sheet = sheets.find((s) => s.id === sheetId) || null;
  const members = useMemo(() => sheet?.members || {}, [sheet]);
  const accessOf = (user) => members[String(user.id)] || null;

  const visibleUsers = useMemo(() => users.filter((u) => !u.isDeleted), [users]);
  const grantable = useMemo(() => visibleUsers.filter((u) => !isExempt(u)), [visibleUsers]);

  const stats = useMemo(() => {
    const out = { members: 0, open: 0, openInGoogle: 0, settings: 0 };
    grantable.forEach((u) => {
      const a = members[String(u.id)];
      if (!a) return;
      out.members += 1;
      PERMISSIONS.forEach((p) => { if (a[p.key]) out[p.key] += 1; });
    });
    return out;
  }, [grantable, members]);

  const filteredUsers = useMemo(() => {
    const q = search.trim().toLowerCase();
    return visibleUsers.filter((u) => {
      if (q && !`${u.name} ${u.email} ${u.employeeId || ''}`.toLowerCase().includes(q)) return false;
      const a = members[String(u.id)];
      if (filter === 'with') return isExempt(u) || Boolean(a);
      if (filter === 'without') return !isExempt(u) && !a;
      return true;
    });
  }, [visibleUsers, search, filter, members]);

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pagedUsers = filteredUsers.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const markSectionGranted = useCallback((userId) => {
    setUsers?.((prev) => prev.map((u) => (u.id === userId
      ? { ...u, featureAccess: { ...(u.featureAccess || {}), sheet_activity: true } }
      : u)));
  }, [setUsers]);

  const grantSection = useCallback(async (user) => {
    const key = `section:${user.id}`;
    setPending((prev) => new Set(prev).add(key));
    try {
      await authAPI.setUserFeatureAccess(user.id, 'sheet_activity', true);
      markSectionGranted(user.id);
      addToast(`Sheets section granted to ${user.name}.`);
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Failed to grant the Sheets section.', 'error');
    } finally {
      setPending((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  }, [markSectionGranted, addToast]);

  const save = useCallback(async (user, next) => {
    if (!sheet) return;
    const key = `${sheet.id}:${user.id}`;
    setPending((prev) => new Set(prev).add(key));
    try {
      const res = await sheetsAPI.setAccess(sheet.id, user.id, next);
      setSheets((prev) => prev.map((s) => {
        if (s.id !== sheet.id) return s;
        const m = { ...s.members };
        if (res?.member) m[String(user.id)] = res.permissions;
        else delete m[String(user.id)];
        return { ...s, members: m };
      }));
      if (res?.sectionGranted) markSectionGranted(user.id);
      addToast(next.member
        ? `${user.name}'s access to "${sheet.name}" updated.`
        : `"${sheet.name}" removed from ${user.name}.`);
    } catch (err) {
      addToast(err?.response?.data?.detail || 'Failed to update sheet access.', 'error');
    } finally {
      setPending((prev) => {
        const n = new Set(prev);
        n.delete(key);
        return n;
      });
    }
  }, [sheet, addToast, markSectionGranted]);

  const toggleMember = (user) => {
    const a = accessOf(user);
    save(user, a ? { member: false } : { member: true, ...DEFAULT_ACCESS });
  };

  const togglePermission = (user, permKey) => {
    const a = accessOf(user) || DEFAULT_ACCESS;
    save(user, { member: true, ...a, [permKey]: !a[permKey] });
  };

  const columnCount = 5 + PERMISSIONS.length;

  if (!loading && !sheets.length) {
    return (
      <div className="sap-root">
        {error
          ? <div className="sap-intro sha-error" role="alert">{error}</div>
          : <p className="sap-intro">No sheets have been added yet. Add one from the Sheets section first.</p>}
      </div>
    );
  }

  return (
    <div className="sap-root">
      <p className="sap-intro">
        Choose a sheet, then choose who sees it and what they can do with it: <strong>Open</strong> (the dashboard view
        and its downloads), <strong>Open in Google Sheets</strong> (the sheet&apos;s link) and <strong>Settings</strong>{' '}
        (tabs, columns and Sync now). Giving someone a sheet also turns on their <strong>Sheets</strong> menu. To let
        someone add new sheets, grant <strong>Add Sheets</strong> in Section Access. Admins can always do everything.
      </p>

      {error && <div className="sap-intro sha-error" role="alert">{error}</div>}

      <div className="sap-filters" role="group" aria-label="Choose a sheet">
        {sheets.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`sap-filter-chip${s.id === sheetId ? ' active' : ''}`}
            onClick={() => { setSheetId(s.id); setPage(1); }}
            aria-pressed={s.id === sheetId}
          >
            {s.name}
            <span className="sap-filter-count">{Object.keys(s.members || {}).length}</span>
          </button>
        ))}
      </div>

      <div className="sap-stats">
        <div className="sap-stat-card sap-stat-card--neutral" role="status">
          <span className="sap-stat-value">{stats.members}</span>
          <span className="sap-stat-label">Can see</span>
        </div>
        {PERMISSIONS.map((p) => (
          <div key={p.key} className="sap-stat-card sap-stat-card--granted" role="status">
            <span className="sap-stat-value">{stats[p.key]}</span>
            <span className="sap-stat-label">{p.label}</span>
          </div>
        ))}
      </div>

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
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            aria-label="Search users"
          />
        </div>
        <div className="sap-filters" role="group" aria-label="Filter users">
          {[['all', 'All Users'], ['with', 'Can see this sheet'], ['without', 'Cannot see']].map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={`sap-filter-chip${filter === value ? ' active' : ''}`}
              onClick={() => { setFilter(value); setPage(1); }}
              aria-pressed={filter === value}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="sap-table-wrap">
        <table className="sap-table" aria-label={`Sheet access for ${sheet?.name || 'sheet'}`}>
          <thead>
            <tr>
              <th className="sap-col-user" scope="col">User</th>
              <th className="sap-col-dept" scope="col">Department</th>
              <th className="sap-col-access" scope="col">Sheets section</th>
              <th className="sap-col-feature" scope="col">Can see sheet</th>
              {PERMISSIONS.map((p) => (
                <th className="sap-col-feature" scope="col" key={p.key}>{p.label}</th>
              ))}
              <th className="sap-col-actions" scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(loading || usersLoading) && (
              <tr><td colSpan={columnCount} className="sap-empty">Loading…</td></tr>
            )}
            {!loading && !usersLoading && pagedUsers.length === 0 && (
              <tr><td colSpan={columnCount} className="sap-empty">No users match the current filter.</td></tr>
            )}
            {!loading && !usersLoading && sheet && pagedUsers.map((u) => {
              const exempt = isExempt(u);
              const a = accessOf(u);
              const busy = pending.has(`${sheet.id}:${u.id}`);
              return (
                <tr className="sap-row" key={u.id}>
                  <td className="sap-col-user">
                    <div className="sap-user-cell">
                      <UserAvatar avatar={u.avatar} name={u.name} size={30} />
                      <div className="sap-user-info">
                        <span className="sap-user-name" title={u.name}>{u.name}</span>
                        <span className="sap-user-email" title={u.email}>{u.email}</span>
                      </div>
                    </div>
                  </td>
                  <td className="sap-col-dept"><span className="sap-cell-text">{u.department || '—'}</span></td>
                  <td className="sap-col-access">
                    {hasSheetsSection(u)
                      ? <span className="sap-badge sap-access-badge--active">Granted</span>
                      : (
                        <button type="button" className="sap-row-btn" onClick={() => grantSection(u)}
                          disabled={pending.has(`section:${u.id}`)}
                          title="Not granted: this person cannot see the Sheets menu. Click to grant it.">
                          Grant
                        </button>
                      )}
                  </td>
                  {exempt ? (
                    [<td className="sap-col-feature" key="m"><span className="sap-badge sap-feature-badge--exempt">Always</span></td>,
                      ...PERMISSIONS.map((p) => (
                        <td className="sap-col-feature" key={p.key}><span className="sap-badge sap-feature-badge--exempt">Always</span></td>
                      ))]
                  ) : (
                    <>
                      <td className="sap-col-feature">
                        <Toggle on={Boolean(a)} busy={busy} text={a ? 'Visible' : 'Hidden'}
                          label={`${a ? 'Hide' : 'Show'} ${sheet.name} for ${u.name}`} onChange={() => toggleMember(u)} />
                      </td>
                      {PERMISSIONS.map((p) => (
                        <td className="sap-col-feature" key={p.key}>
                          {a ? (
                            <Toggle on={Boolean(a[p.key])} busy={busy}
                              label={`${a[p.key] ? 'Block' : 'Allow'} ${p.label} on ${sheet.name} for ${u.name}`}
                              onChange={() => togglePermission(u, p.key)} />
                          ) : <span className="sap-cell-text sha-muted">—</span>}
                        </td>
                      ))}
                    </>
                  )}
                  <td className="sap-col-actions">
                    <button type="button" className="sap-row-btn sap-row-info-btn" onClick={() => onViewInfo(u)}
                      aria-label={`View info for ${u.name}`}>
                      Info
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="sap-pagination" role="navigation" aria-label="User list pagination">
          <span className="sap-pagination-info">
            {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredUsers.length)} of {filteredUsers.length} users
          </span>
          <div className="sap-pagination-controls">
            <button type="button" className="sap-page-btn" onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={safePage <= 1} aria-label="Previous page">‹</button>
            <span className="sap-page-indicator" aria-current="page">{safePage} / {totalPages}</span>
            <button type="button" className="sap-page-btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={safePage >= totalPages} aria-label="Next page">›</button>
          </div>
        </div>
      )}

      {toasts.length > 0 && (
        <div className="sap-toast-stack" role="status" aria-live="polite">
          {toasts.map((t) => <div key={t.id} className={`sap-toast sap-toast--${t.type}`}>{t.msg}</div>)}
        </div>
      )}
    </div>
  );
}

export default AdminSheetAccessTab;
