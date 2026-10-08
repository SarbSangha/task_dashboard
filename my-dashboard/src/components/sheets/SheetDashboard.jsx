import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { downloadBlobResponse } from '../../services/reports';
import { sheetsAPI } from '../../services/sheets';
import { sheetUserColor, sheetUserInitials } from '../../utils/sheetUserColor';
import { StatusBadge } from './RequestDetail';
import { formatWhen } from '../../utils/sheetFormat';

/** One registered sheet: overview, per-user stats, stuck requests, requests table. */

const PAGE_SIZE = 50;
const POLL_MS = 60000;
const EMPTY = { tab: '', status: '', user: '', start: '', end: '', q: '', stuck: false };

const hours = (h) => (h == null ? '—' : h < 48 ? `${h} h` : `${Math.round(h / 24 * 10) / 10} days`);
const errorText = (err, fallback) => (typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : fallback);

export default function SheetDashboard({ sheet, onOpenRequest, onSettings, active }) {
  const [filters, setFilters] = useState(EMPTY);
  const q = useDebouncedValue(filters.q, 400);
  const [page, setPage] = useState(1);
  const [overview, setOverview] = useState(null);
  const [list, setList] = useState({ items: [], total: 0 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const reqId = useRef(0);

  const params = { tab: filters.tab, status: filters.status, user: filters.user, start: filters.start, end: filters.end, q, stuck: filters.stuck };
  const paramsKey = JSON.stringify(params);

  const load = useCallback(async () => {
    const id = reqId.current + 1;
    reqId.current = id;
    try {
      const p = JSON.parse(paramsKey);
      const [ov, rq] = await Promise.all([
        sheetsAPI.overview(sheet.id, p.tab),
        sheetsAPI.requests(sheet.id, { ...p, page, pageSize: PAGE_SIZE }),
      ]);
      if (reqId.current !== id) return;
      setOverview(ov);
      setList({ items: rq.items || [], total: rq.total || 0 });
      setUpdatedAt(new Date());
      setError('');
    } catch (err) {
      if (reqId.current === id) setError(errorText(err, 'Could not load this sheet.'));
    }
  }, [sheet.id, paramsKey, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const set = (key) => (e) => {
    setPage(1);
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setFilters((f) => ({ ...f, [key]: value }));
  };

  const syncNow = async () => {
    setBusy('sync');
    try {
      const r = await sheetsAPI.sync(sheet.id);
      if (r?.result?.error) setError(r.result.error);
      await load();
    } catch (err) {
      setError(errorText(err, 'Sync failed.'));
    } finally {
      setBusy('');
    }
  };

  const exportCsv = async (kind) => {
    setBusy(kind);
    try {
      const res = kind === 'events' ? await sheetsAPI.eventsCsv(sheet.id, params) : await sheetsAPI.requestsCsv(sheet.id, params);
      downloadBlobResponse(res, `${kind}.csv`);
    } catch (err) {
      setError(errorText(err, 'Export failed.'));
    } finally {
      setBusy('');
    }
  };

  const ov = overview;
  const totalPages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  const statusOptions = (ov?.statusCounts || []).map((s) => s.status);

  return (
    <div className="shs-dashboard">
      <div className="shs-sheet-head">
        <div>
          <h3>{sheet.name}</h3>
          <p className="shs-muted">
            Last read {sheet.lastPolledAt ? formatWhen(ov?.sheet?.lastPolledAt || sheet.lastPolledAt) : 'never'}
            {(ov?.sheet?.lastPollError || sheet.lastPollError) && <span className="shs-warn"> · {ov?.sheet?.lastPollError || sheet.lastPollError}</span>}
            {updatedAt && ` · refreshed ${updatedAt.toLocaleTimeString()}`}
          </p>
        </div>
        <div className="shs-actions">
          {sheet.permissions?.openInGoogle && sheet.openUrl && <a className="shs-secondary-btn" href={sheet.openUrl} target="_blank" rel="noopener noreferrer">Open in Google Sheets</a>}
          {sheet.permissions?.settings && <button type="button" className="shs-secondary-btn" onClick={syncNow} disabled={busy === 'sync'}>{busy === 'sync' ? 'Reading…' : 'Sync now'}</button>}
          {sheet.permissions?.settings && <button type="button" className="shs-secondary-btn" onClick={onSettings}>Settings</button>}
        </div>
      </div>

      {error && <div className="trp-error" role="alert">{error}</div>}

      <div className="shs-tabs" role="tablist" aria-label="Website tab">
        {['', ...(ov?.tabs || [])].map((t) => (
          <button key={t || 'all'} type="button" role="tab" aria-selected={filters.tab === t}
            className={`shs-tab${filters.tab === t ? ' shs-tab--on' : ''}`} onClick={() => set('tab')(t)}>{t || 'All tabs'}</button>
        ))}
      </div>

      {ov && (
        <>
          <div className="sha-cards">
            <div className="sha-card"><span className="sha-card-value">{ov.totalRequests}</span><span className="sha-card-label">Requests</span></div>
            <div className="sha-card"><span className="sha-card-value">{ov.deliveredThisWeek}</span><span className="sha-card-label">Delivered this week</span></div>
            <div className="sha-card"><span className="sha-card-value">{hours(ov.avgHoursToAwaiting)}</span><span className="sha-card-label">Request → structure ready</span></div>
            <div className="sha-card"><span className="sha-card-value">{hours(ov.avgHoursApprovalToDelivered)}</span><span className="sha-card-label">Approval → delivered</span></div>
            <div className={`sha-card${ov.errors ? ' shs-card--bad' : ''}`}><span className="sha-card-value">{ov.errors}</span><span className="sha-card-label">Errors</span></div>
          </div>
          <div className="shs-status-row">
            {ov.statusCounts.map((s) => (
              <button key={s.status} type="button" className={`shs-status-chip${filters.status === s.status ? ' shs-status-chip--on' : ''}`}
                onClick={() => set('status')(filters.status === s.status ? '' : s.status)}>
                <StatusBadge status={s.status} /> <strong>{s.count}</strong>
              </button>
            ))}
          </div>
          {ov.importedRequests > 0 && (
            <p className="shs-muted shs-small">{ov.importedRequests} request(s) were already in the sheet when it was added; their timings before that are unknown and left out of the averages.</p>
          )}

          <div className="sha-grid">
            <section className="sha-section">
              <h3>People</h3>
              {ov.perUser.length === 0 ? <p className="sha-muted">No user actions recorded yet.</p> : (
                <table className="trp-table shs-compact">
                  <thead><tr><th>User</th><th>Created</th><th>Approvals</th><th>Structure edits</th><th>Last activity</th></tr></thead>
                  <tbody>
                    {ov.perUser.map((p) => (
                      <tr key={p.email || 'unknown'} className="shs-click" onClick={() => set('user')(filters.user === (p.email || 'unknown') ? '' : (p.email || 'unknown'))}>
                        <td>
                          <span className="shs-actor"><span className="shs-avatar" style={{ background: sheetUserColor(p.email) }}>{sheetUserInitials(p.email)}</span>
                            {p.name || p.email || 'Unknown user'}</span>
                        </td>
                        <td>{p.created}</td><td>{p.approvals}</td><td>{p.structureEdits}</td><td>{formatWhen(p.lastActivity)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className="sha-muted">
                Claude: {ov.claude.structures} structures · {ov.claude.drafts} drafts · {ov.claude.delivered} delivered · {ov.claude.errors} errors
              </p>
            </section>
            <section className="sha-section">
              <h3>Needs attention</h3>
              {ov.stuck.length === 0 ? <p className="sha-muted">Nothing stuck.</p> : (
                <ul className="shs-stuck">
                  {ov.stuck.map((s) => (
                    <li key={s.id}><button type="button" className="shs-link-btn" onClick={() => onOpenRequest(s.id)}>{s.topic || '(no topic)'}</button>
                      <span className="shs-muted"> · {s.tab}</span><div className="shs-warn">{s.reason}</div></li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      <section className="sha-section">
        <div className="trp-filters">
          <label className="trp-field sha-search"><span>Search topic</span><input type="search" value={filters.q} onChange={set('q')} /></label>
          <label className="trp-field"><span>Status</span>
            <select value={filters.status} onChange={set('status')}>
              <option value="">All</option>{statusOptions.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </label>
          <label className="trp-field"><span>Created by</span>
            <select value={filters.user} onChange={set('user')}>
              <option value="">Anyone</option>
              {(ov?.perUser || []).map((p) => <option key={p.email || 'unknown'} value={p.email || 'unknown'}>{p.name || p.email || 'Unknown user'}</option>)}
            </select>
          </label>
          <label className="trp-field"><span>From</span><input type="date" value={filters.start} onChange={set('start')} /></label>
          <label className="trp-field"><span>To</span><input type="date" value={filters.end} onChange={set('end')} /></label>
          <label className="shs-check"><input type="checkbox" checked={filters.stuck} onChange={set('stuck')} /><span>Stuck or errors only</span></label>
          <div className="sha-actions">
            {JSON.stringify(filters) !== JSON.stringify(EMPTY) && <button type="button" className="shs-secondary-btn" onClick={() => { setPage(1); setFilters(EMPTY); }}>Reset</button>}
            <button type="button" className="shs-secondary-btn" onClick={() => exportCsv('requests')} disabled={busy === 'requests' || !list.total}>Requests CSV</button>
            <button type="button" className="shs-secondary-btn" onClick={() => exportCsv('events')} disabled={busy === 'events' || !list.total}>Events CSV</button>
          </div>
        </div>

        {list.items.length === 0 ? <div className="trp-empty">No requests match these filters.</div> : (
          <div className="trp-table-wrap">
            <table className="trp-table">
              <thead><tr><th>Tab</th><th>Topic</th><th>Created by</th><th>Status</th><th>Created</th><th>Last updated</th><th>Links</th></tr></thead>
              <tbody>
                {list.items.map((r) => (
                  <tr key={r.id} className={`shs-click${r.stuck || r.error ? ' shs-row--stuck' : ''}`} onClick={() => onOpenRequest(r.id)}>
                    <td>{r.tab}</td>
                    <td className="shs-topic" title={r.topic || ''}>{r.topic || <em>(no topic)</em>}{(r.stuck || r.error) && <div className="shs-warn">{r.error || r.stuck}</div>}</td>
                    <td>{r.createdBy?.name || r.createdBy?.email || <span className="shs-muted">Unknown user</span>}</td>
                    <td><StatusBadge status={r.status} error={r.error} /></td>
                    <td>{r.isImported ? <span className="shs-muted" title="Already in the sheet when it was registered">before tracking</span> : formatWhen(r.requestedAt || r.firstSeenAt, true)}</td>
                    <td>{formatWhen(r.lastChangedAt, true)}</td>
                    <td onClick={(e) => e.stopPropagation()}>
                      {r.structureDocLink && /^https?:/i.test(r.structureDocLink) && <a href={r.structureDocLink} target="_blank" rel="noopener noreferrer">Structure</a>}
                      {r.finalDocLink && /^https?:/i.test(r.finalDocLink) && <> · <a href={r.finalDocLink} target="_blank" rel="noopener noreferrer">Final doc</a></>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.total > PAGE_SIZE && (
          <div className="sha-pager">
            <button type="button" className="shs-secondary-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
            <span>Page {page} of {totalPages}</span>
            <button type="button" className="shs-secondary-btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
          </div>
        )}
      </section>
    </div>
  );
}
