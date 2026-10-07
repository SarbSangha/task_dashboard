import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { downloadBlobResponse } from '../../services/reports';
import { sheetActivityAPI } from '../../services/sheetActivity';
import { UNKNOWN_COLOR, sheetUserColor, sheetUserInitials, sheetUserLabel } from '../../utils/sheetUserColor';
import './TaskReportPanel.css';
import './SheetActivityPanel.css';

/**
 * Sheets -> Sheet Activity: who changed what in the shared Google Sheet.
 *
 * Events are captured by apps-script/Code.gs and stored by
 * backend/routers/sheet_activity_router.py. Visibility is the
 * "sheet_activity" Section Access grant (Admin Queue -> Section Access);
 * the endpoints enforce it too.
 */

const ALL = '';
const UNKNOWN = 'unknown';
const PAGE_SIZE = 50;
const POLL_MS = 30000;
const CHART_USERS = 8;

const CHANGE_LABELS = {
  EDIT: 'Edit',
  INSERT_ROW: 'Rows inserted',
  REMOVE_ROW: 'Rows removed',
  INSERT_COLUMN: 'Columns inserted',
  REMOVE_COLUMN: 'Columns removed',
  INSERT_GRID: 'Tab added',
  REMOVE_GRID: 'Tab removed',
  FORMAT: 'Formatting',
  OTHER: 'Other change',
};

const EMPTY_FILTERS = { user: ALL, sheet: ALL, changeType: ALL, start: '', end: '', search: '' };

const formatTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};

const timeAgo = (iso) => {
  if (!iso) return '';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
};

const readError = async (err, fallback) => {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { return JSON.parse(await data.text())?.detail || fallback; } catch { return fallback; }
  }
  return typeof data?.detail === 'string' ? data.detail : fallback;
};

// Common prefix / suffix diff: highlights only the part that changed.
function splitDiff(oldText, newText) {
  let start = 0;
  const max = Math.min(oldText.length, newText.length);
  while (start < max && oldText[start] === newText[start]) start += 1;
  let end = 0;
  while (end < max - start && oldText[oldText.length - 1 - end] === newText[newText.length - 1 - end]) end += 1;
  return {
    prefix: oldText.slice(0, start),
    oldMid: oldText.slice(start, oldText.length - end),
    newMid: newText.slice(start, newText.length - end),
    suffix: end ? oldText.slice(oldText.length - end) : '',
  };
}

function UserChip({ email, size = 'sm' }) {
  const color = sheetUserColor(email);
  return (
    <span className={`sha-user sha-user--${size}`} title={sheetUserLabel(email)}>
      <span className="sha-avatar" style={{ background: color }} aria-hidden="true">{sheetUserInitials(email)}</span>
      <span className={`sha-user-name${email ? '' : ' sha-user-name--unknown'}`}>{sheetUserLabel(email)}</span>
    </span>
  );
}

function ChangeValue({ item }) {
  if (item.changeType !== 'EDIT') {
    return <span className="sha-structural">{CHANGE_LABELS[item.changeType] || item.changeType}{item.range ? ` near ${item.range}` : ''}</span>;
  }
  if (item.isMultiCell) {
    let preview = '';
    try {
      const grid = JSON.parse(item.newValue || '[]');
      preview = grid.flat().filter((v) => v !== '').slice(0, 4).join(' · ');
    } catch {
      preview = item.newValue || '';
    }
    return (
      <span className="sha-multi">
        <span className="sha-multi-tag">multiple cells{item.numRows && item.numColumns ? ` (${item.numRows}×${item.numColumns})` : ''}</span>
        {preview && <span className="sha-new">{preview}</span>}
        {item.truncated && <span className="sha-badge">truncated</span>}
      </span>
    );
  }
  const oldText = item.oldValue ?? '';
  const newText = item.newValue ?? '';
  const d = splitDiff(oldText, newText);
  return (
    <span className="sha-diff">
      <span className="sha-old" title={oldText}>
        {oldText === '' ? <em>(empty)</em> : <>{d.prefix}<mark>{d.oldMid}</mark>{d.suffix}</>}
      </span>
      <span className="sha-arrow" aria-label="changed to">→</span>
      <span className="sha-new" title={newText}>
        {newText === '' ? <em>(cleared)</em> : <>{d.prefix}<mark>{d.newMid}</mark>{d.suffix}</>}
      </span>
      {item.formula && <span className="sha-formula" title={item.formula}>ƒ {item.formula}</span>}
      {item.truncated && <span className="sha-badge">truncated</span>}
    </span>
  );
}

export default function SheetActivityPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('sheet-activity-panel', isOpen && isMinimized);

  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const search = useDebouncedValue(filters.search, 400);
  const [page, setPage] = useState(1);
  const [options, setOptions] = useState({ users: [], sheets: [], changeTypes: Object.keys(CHANGE_LABELS) });
  const [log, setLog] = useState({ items: [], total: 0 });
  const [summary, setSummary] = useState(null);
  const [peopleSummary, setPeopleSummary] = useState(null);
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const requestRef = useRef(0);

  const params = useMemo(() => ({
    user: filters.user || undefined,
    sheet: filters.sheet || undefined,
    changeType: filters.changeType || undefined,
    start: filters.start || undefined,
    end: filters.end || undefined,
    q: search || undefined,
  }), [filters.user, filters.sheet, filters.changeType, filters.start, filters.end, search]);

  const load = useCallback(async ({ silent = false } = {}) => {
    if (params.start && params.end && params.start > params.end) {
      setError('"From" date must be on or before the "To" date.');
      return;
    }
    const id = requestRef.current + 1;
    requestRef.current = id;
    if (!silent) setLoading(true);
    try {
      // The per-user list ignores the user filter, so the other people stay
      // visible (and clickable) while one is selected.
      const { user, ...withoutUser } = params;
      const [list, sum, people] = await Promise.all([
        sheetActivityAPI.list({ ...params, page, pageSize: PAGE_SIZE }),
        sheetActivityAPI.summary(params),
        user ? sheetActivityAPI.summary(withoutUser) : Promise.resolve(null),
      ]);
      if (requestRef.current !== id) return;
      setLog({ items: list.items || [], total: list.total || 0 });
      setSummary(sum);
      setPeopleSummary(people || sum);
      setUpdatedAt(new Date());
      setError('');
    } catch (err) {
      if (requestRef.current === id) setError(await readError(err, 'Could not load sheet activity.'));
    } finally {
      if (requestRef.current === id && !silent) setLoading(false);
    }
  }, [params, page]);

  const loadOptions = useCallback(() => {
    sheetActivityAPI.options()
      .then((data) => setOptions({
        users: data?.users || [],
        sheets: data?.sheets || [],
        changeTypes: data?.changeTypes || Object.keys(CHANGE_LABELS),
      }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (isOpen) loadOptions();
  }, [isOpen, loadOptions]);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // Poll while the panel is open, expanded and the browser tab is visible.
  useEffect(() => {
    if (!isOpen || isMinimized || !autoRefresh) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') load({ silent: true });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [isOpen, isMinimized, autoRefresh, load]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    } else {
      setIsMaximized(isMobileViewport());
    }
  }, [isOpen]);

  // Any filter change goes back to page 1 in the same render, so one fetch runs.
  const setFilter = (key) => (e) => {
    setPage(1);
    setFilters((prev) => ({ ...prev, [key]: e.target.value }));
  };
  const toggleUser = (email) => {
    const value = email || UNKNOWN;
    setPage(1);
    setFilters((prev) => ({ ...prev, user: prev.user === value ? ALL : value }));
  };
  const resetFilters = () => {
    setPage(1);
    setFilters(EMPTY_FILTERS);
  };

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((prev) => !prev);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await sheetActivityAPI.exportCsv(params);
      downloadBlobResponse(res, `sheet-activity_${params.start || 'all'}_to_${params.end || 'now'}.csv`);
    } catch (err) {
      setError(await readError(err, 'Could not export the activity log.'));
    } finally {
      setExporting(false);
    }
  };

  // Chart: edits per day, one stacked series per user (the busiest
  // CHART_USERS, the rest folded into "Others").
  const chart = useMemo(() => {
    if (!summary?.daily?.length) return { rows: [], series: [] };
    const totals = new Map();
    summary.daily.forEach((d) => totals.set(d.userEmail ?? UNKNOWN, (totals.get(d.userEmail ?? UNKNOWN) || 0) + d.edits));
    const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    const shown = new Set(ranked.slice(0, CHART_USERS));
    const days = new Map();
    summary.daily.forEach((d) => {
      const key = d.userEmail ?? UNKNOWN;
      const series = shown.has(key) ? key : 'others';
      const row = days.get(d.day) || { day: d.day };
      row[series] = (row[series] || 0) + d.edits;
      days.set(d.day, row);
    });
    const series = [...shown].map((key) => ({
      key,
      label: key === UNKNOWN ? sheetUserLabel(null) : key,
      color: key === UNKNOWN ? UNKNOWN_COLOR : sheetUserColor(key),
    }));
    if (ranked.length > CHART_USERS) series.push({ key: 'others', label: 'Others', color: '#a3a3a3' });
    return { rows: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)), series };
  }, [summary]);

  if (!isOpen) return null;

  const people = peopleSummary?.perUser || [];
  const maxEdits = Math.max(1, ...people.map((p) => p.edits));
  const totalPages = Math.max(1, Math.ceil(log.total / PAGE_SIZE));
  const hasFilters = Object.entries(filters).some(([k, v]) => v !== EMPTY_FILTERS[k]);

  return (
    <>
      <div className={`trp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`trp-panel sha-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Sheet Activity"
      >
        <div className="trp-header">
          <div className="trp-brand">
            <span className="trp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="3" y1="9" x2="21" y2="9" /><line x1="9" y1="9" x2="9" y2="21" />
              </svg>
            </span>
            <h2 className="trp-title">Sheet Activity</h2>
          </div>
          <div className="trp-header-spacer" />
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <div className="trp-body">
            <div className="trp-filters">
              <label className="trp-field">
                <span>User</span>
                <select value={filters.user} onChange={setFilter('user')}>
                  <option value={ALL}>All users</option>
                  {options.users.map((u) => <option key={u} value={u}>{u === UNKNOWN ? sheetUserLabel(null) : u}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>Tab</span>
                <select value={filters.sheet} onChange={setFilter('sheet')}>
                  <option value={ALL}>All tabs</option>
                  {options.sheets.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>Change</span>
                <select value={filters.changeType} onChange={setFilter('changeType')}>
                  <option value={ALL}>All changes</option>
                  {options.changeTypes.map((c) => <option key={c} value={c}>{CHANGE_LABELS[c] || c}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>From</span>
                <input type="date" value={filters.start} onChange={setFilter('start')} max={filters.end || undefined} />
              </label>
              <label className="trp-field">
                <span>To</span>
                <input type="date" value={filters.end} onChange={setFilter('end')} min={filters.start || undefined} />
              </label>
              <label className="trp-field sha-search">
                <span>Search</span>
                <input type="search" placeholder="Value, formula, cell, tab…" value={filters.search} onChange={setFilter('search')} />
              </label>
              <div className="sha-actions">
                {hasFilters && (
                  <button type="button" className="sha-secondary-btn" onClick={resetFilters}>Reset</button>
                )}
                <button type="button" className="sha-secondary-btn" onClick={() => { loadOptions(); load(); }} disabled={loading}>
                  {loading ? 'Loading…' : 'Refresh'}
                </button>
                <button type="button" className="trp-generate-btn" onClick={exportCsv} disabled={exporting || !log.total}>
                  {exporting ? 'Exporting…' : 'Export CSV'}
                </button>
              </div>
            </div>

            <div className="sha-status">
              <label className="sha-check">
                <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
                <span>Auto-refresh every 30 s</span>
              </label>
              {updatedAt && <span>Updated {updatedAt.toLocaleTimeString()}</span>}
            </div>

            {error && <div className="trp-error" role="alert">{error}</div>}

            <div className="sha-cards">
              <div className="sha-card"><span className="sha-card-value">{(summary?.totalEdits ?? 0).toLocaleString()}</span><span className="sha-card-label">Total changes</span></div>
              <div className="sha-card"><span className="sha-card-value">{summary?.activeUsersToday ?? 0}</span><span className="sha-card-label">Active users today</span></div>
              <div className="sha-card"><span className="sha-card-value">{summary?.activeUsers7d ?? 0}</span><span className="sha-card-label">Active users, 7 days</span></div>
              <div className="sha-card sha-card--wide">
                <span className="sha-card-label">Last change</span>
                {summary?.lastEdit ? (
                  <span className="sha-card-last">
                    <UserChip email={summary.lastEdit.userEmail} />
                    <span title={formatTime(summary.lastEdit.timestamp)}>{timeAgo(summary.lastEdit.timestamp)}</span>
                  </span>
                ) : <span className="sha-card-value">—</span>}
              </div>
            </div>

            <div className="sha-grid">
              <section className="sha-section">
                <h3>People</h3>
                {people.length === 0 ? <p className="sha-muted">No activity yet.</p> : (
                  <ul className="sha-people">
                    {people.map((p) => {
                      const key = p.userEmail || UNKNOWN;
                      const active = filters.user === key;
                      return (
                        <li key={key}>
                          <button type="button" className={`sha-person${active ? ' sha-person--active' : ''}`} onClick={() => toggleUser(p.userEmail)}
                            aria-pressed={active} title={active ? 'Show everyone' : 'Show only this user'}>
                            <UserChip email={p.userEmail} />
                            <span className="sha-person-bar"><span style={{ width: `${(p.edits / maxEdits) * 100}%`, background: sheetUserColor(p.userEmail) }} /></span>
                            <span className="sha-person-count">{p.edits.toLocaleString()}</span>
                            <span className="sha-person-last">{timeAgo(p.lastActivity)}</span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
              <section className="sha-section">
                <h3>Changes per day{summary?.window ? ` (${summary.window.start} – ${summary.window.end})` : ''}</h3>
                {chart.rows.length === 0 ? <p className="sha-muted">No changes in this window.</p> : (
                  <div className="sha-chart">
                    <ResponsiveContainer width="100%" height={240}>
                      <BarChart data={chart.rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} />
                        <XAxis dataKey="day" tick={{ fontSize: 11 }} />
                        <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
                        <Tooltip />
                        <Legend wrapperStyle={{ fontSize: 11 }} />
                        {chart.series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} stackId="edits" fill={s.color} />)}
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                {summary?.topTabs?.length > 0 && (
                  <p className="sha-muted">Most edited tabs: {summary.topTabs.slice(0, 5).map((t) => `${t.sheetName || '(unknown tab)'} (${t.edits})`).join(' · ')}</p>
                )}
              </section>
            </div>

            <section className="sha-section">
              <h3>Activity log <span className="sha-muted">({log.total.toLocaleString()} change{log.total === 1 ? '' : 's'}, newest first)</span></h3>
              {log.items.length === 0 ? (
                <div className="trp-empty">{loading ? 'Loading…' : 'No changes match these filters.'}</div>
              ) : (
                <div className="trp-table-wrap">
                  <table className="trp-table sha-table">
                    <thead>
                      <tr><th>Time</th><th>User</th><th>Tab</th><th>Cell / range</th><th>Change</th><th>Old → new</th></tr>
                    </thead>
                    <tbody>
                      {log.items.map((item) => (
                        <tr key={item.id} style={{ boxShadow: `inset 3px 0 0 ${sheetUserColor(item.userEmail)}` }}>
                          <td className="sha-nowrap" title={item.timestamp}>{formatTime(item.timestamp)}</td>
                          <td><UserChip email={item.userEmail} /></td>
                          <td>{item.sheetName || '—'}</td>
                          <td className="sha-mono">{item.range || '—'}</td>
                          <td><span className={`sha-type sha-type--${item.changeType.toLowerCase()}`}>{CHANGE_LABELS[item.changeType] || item.changeType}</span></td>
                          <td className="sha-change"><ChangeValue item={item} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {log.total > PAGE_SIZE && (
                <div className="sha-pager">
                  <button type="button" className="sha-secondary-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
                  <span>Page {page} of {totalPages}</span>
                  <button type="button" className="sha-secondary-btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </>
  );
}
