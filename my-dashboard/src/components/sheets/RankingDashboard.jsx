import { useCallback, useEffect, useRef, useState } from 'react';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { downloadBlobResponse } from '../../services/reports';
import { sheetsAPI } from '../../services/sheets';
import { AI_LABELS, formatWhen } from '../../utils/sheetFormat';
import { Movement } from './KeywordDetail';

/** keyword_ranking sheet: per-site cards, alerts, keyword table, runs, contributors. */

const POLL_MS = 60000;
const PAGE_SIZE = 100;
const EMPTY = { bucket: '', ai: '', addedBy: '', movement: '', q: '' };
const ALERT_LABELS = {
  BIG_DROP: 'Big drops', FELL_OUT_OF_TOP_10: 'Fell out of the top 10', LOST_AI_CITATION: 'Lost AI Overview citation',
  RANKING_PAGE_CHANGED: 'Ranking page changed', MISSED_MONDAY_RUN: 'Missed Monday run', CHECKS_FAILED: 'Failed checks',
  RANKED_WITHOUT_URL: 'Ranked, no Live URL',
  MANUAL_OVERRIDE: 'Manual overrides', UNPARSEABLE_VALUE: 'Unreadable values', DUPLICATE_KEYWORD: 'Duplicate keywords',
};
const errorText = (err, fallback) => (typeof err?.response?.data?.detail === 'string' ? err.response.data.detail : fallback);
const signed = (n, digits = 0) => (n == null ? '' : `${n > 0 ? '+' : ''}${digits ? n.toFixed(digits) : n}`);

function Sparkline({ points }) {
  const vals = points.map((p) => p.v).filter((v) => v != null);
  if (vals.length < 2) return <span className="shs-muted">—</span>;
  const w = 90;
  const h = 24;
  const max = Math.max(...vals, 10);
  const step = w / (points.length - 1);
  const y = (v) => ((v - 1) / Math.max(1, max - 1)) * (h - 4) + 2;   // 1 at the top
  const path = points.map((p, i) => (p.v == null ? null : `${i * step},${y(p.v)}`)).filter(Boolean).join(' ');
  return (
    <svg width={w} height={h} className="shr-spark" aria-hidden="true">
      <polyline points={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {points.map((p, i) => (p.v != null && !p.b.startsWith('ranked')
        ? <circle key={p.d} cx={i * step} cy={y(p.v)} r="1.8" className="shr-spark-out" /> : null))}
    </svg>
  );
}

function SiteCard({ site }) {
  const l = site.latest;
  const c = site.change || {};
  return (
    <article className="shs-card shr-site">
      <header><h3>{site.tab}</h3><span className="shs-muted">{site.runs} runs</span></header>
      {!l ? <p className="shs-muted">No runs yet.</p> : (
        <>
          <p className="shs-muted">Latest: {l.label} ({l.trigger})</p>
          <div className="shr-metrics">
            <div><strong>{site.keywords}</strong><span>keywords</span></div>
            <div><strong>{l.top3}</strong><span>top 3 <em className={c.top3 > 0 ? 'shr-up' : c.top3 < 0 ? 'shr-down' : ''}>{signed(c.top3)}</em></span></div>
            <div><strong>{l.top10}</strong><span>top 10 <em className={c.top10 > 0 ? 'shr-up' : c.top10 < 0 ? 'shr-down' : ''}>{signed(c.top10)}</em></span></div>
            <div><strong>{l.avgPosition ?? '—'}</strong><span>avg position <em className={c.avgPosition < 0 ? 'shr-up' : c.avgPosition > 0 ? 'shr-down' : ''}>{signed(c.avgPosition, 1)}</em></span></div>
            <div><strong>{l.citationRate == null ? '—' : `${Math.round(l.citationRate * 100)}%`}</strong>
              <span>AI cited <em className={c.citationRate > 0 ? 'shr-up' : c.citationRate < 0 ? 'shr-down' : ''}>{c.citationRate == null ? '' : `${signed(Math.round(c.citationRate * 100))} pts`}</em></span></div>
          </div>
        </>
      )}
    </article>
  );
}

export default function RankingDashboard({ sheet, onOpenKeyword, onSettings, active }) {
  const [tab, setTab] = useState('');
  const [filters, setFilters] = useState(EMPTY);
  const q = useDebouncedValue(filters.q, 400);
  const [page, setPage] = useState(1);
  const [overview, setOverview] = useState(null);
  const [keywords, setKeywords] = useState({ items: [], total: 0 });
  const [alerts, setAlerts] = useState([]);
  const [runs, setRuns] = useState([]);
  const [people, setPeople] = useState([]);
  const [alertType, setAlertType] = useState('');
  const [section, setSection] = useState('keywords');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const reqId = useRef(0);
  const params = { tab, ...filters, q };
  const key = JSON.stringify(params);

  const load = useCallback(async () => {
    const id = reqId.current + 1;
    reqId.current = id;
    const p = JSON.parse(key);
    try {
      const [ov, kw, al, rn, pp] = await Promise.all([
        sheetsAPI.rankingOverview(sheet.id, p.tab),
        sheetsAPI.rankingKeywords(sheet.id, { ...p, page, pageSize: PAGE_SIZE }),
        sheetsAPI.rankingAlerts(sheet.id, p.tab),
        sheetsAPI.rankingRuns(sheet.id, p.tab),
        sheetsAPI.rankingContributors(sheet.id, p.tab),
      ]);
      if (reqId.current !== id) return;
      setOverview(ov);
      setKeywords({ items: kw.items || [], total: kw.total || 0 });
      setAlerts(al.alerts || []);
      setRuns(rn.runs || []);
      setPeople(pp.people || []);
      setError('');
    } catch (err) {
      if (reqId.current === id) setError(errorText(err, 'Could not load this sheet.'));
    }
  }, [sheet.id, key, page]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [active, load]);

  const set = (k) => (e) => { setPage(1); setFilters((f) => ({ ...f, [k]: e.target.value })); };
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
      const res = kind === 'history' ? await sheetsAPI.rankingHistoryCsv(sheet.id, params) : await sheetsAPI.rankingKeywordsCsv(sheet.id, params);
      downloadBlobResponse(res, `${kind}.csv`);
    } catch (err) {
      setError(errorText(err, 'Export failed.'));
    } finally {
      setBusy('');
    }
  };

  const alertGroups = alerts.reduce((acc, a) => ({ ...acc, [a.type]: (acc[a.type] || 0) + 1 }), {});
  const shownAlerts = alertType ? alerts.filter((a) => a.type === alertType) : alerts.filter((a) => a.severity === 'high').slice(0, 30);
  const totalPages = Math.max(1, Math.ceil(keywords.total / PAGE_SIZE));
  const lastPoll = overview?.sheet?.lastPolledAt || sheet.lastPolledAt;
  const pollNote = overview?.sheet?.lastPollError || sheet.lastPollError;

  return (
    <div className="shs-dashboard">
      <div className="shs-sheet-head">
        <div>
          <h3>{sheet.name}</h3>
          <p className="shs-muted">Keyword ranking · last read {lastPoll ? formatWhen(lastPoll) : 'never'}
            {pollNote && <span className="shs-warn"> · {pollNote}</span>}</p>
        </div>
        <div className="shs-actions">
          {sheet.permissions?.openInGoogle && sheet.openUrl && <a className="shs-secondary-btn" href={sheet.openUrl} target="_blank" rel="noopener noreferrer">Open in Google Sheets</a>}
          {sheet.sourceUrl && <a className="shs-secondary-btn" href={sheet.sourceUrl} target="_blank" rel="noopener noreferrer">Open source sheet</a>}
          {sheet.permissions?.settings && <button type="button" className="shs-secondary-btn" onClick={syncNow} disabled={busy === 'sync'}>{busy === 'sync' ? 'Reading…' : 'Sync now'}</button>}
          {sheet.permissions?.settings && <button type="button" className="shs-secondary-btn" onClick={onSettings}>Settings</button>}
        </div>
      </div>
      {error && <div className="trp-error" role="alert">{error}</div>}

      <div className="shs-tabs" role="tablist" aria-label="Site">
        {['', ...(overview?.tabs || [])].map((t) => (
          <button key={t || 'all'} type="button" role="tab" aria-selected={tab === t}
            className={`shs-tab${tab === t ? ' shs-tab--on' : ''}`} onClick={() => { setPage(1); setTab(t); }}>{t || 'All sites'}</button>
        ))}
      </div>

      <div className="shs-cards">{(overview?.sites || []).map((s) => <SiteCard key={s.tab} site={s} />)}</div>

      <section className="sha-section">
        <h3>Alerts</h3>
        <div className="shs-status-row">
          {Object.keys(ALERT_LABELS).filter((k) => alertGroups[k]).map((k) => (
            <button key={k} type="button" className={`shs-status-chip${alertType === k ? ' shs-status-chip--on' : ''}`}
              onClick={() => setAlertType(alertType === k ? '' : k)}>{ALERT_LABELS[k]} <strong>{alertGroups[k]}</strong></button>
          ))}
          {!alerts.length && <span className="shs-muted">No alerts.</span>}
        </div>
        {shownAlerts.length > 0 && (
          <ul className="shs-stuck shr-alerts">
            {shownAlerts.map((a, i) => (
              <li key={`${a.type}-${a.keywordId}-${a.runDate}-${i}`} className={`shr-alert--${a.severity}`}>
                {a.keywordId ? <button type="button" className="shs-link-btn" onClick={() => onOpenKeyword(a.keywordId)}>{a.keyword}</button> : <strong>{ALERT_LABELS[a.type]}</strong>}
                <span className="shs-muted"> · {a.tab}{a.runDate ? ` · ${a.runDate}` : ''}</span>
                <div>{a.message}</div>
              </li>
            ))}
          </ul>
        )}
        {!alertType && alerts.length > shownAlerts.length && <p className="shs-muted shs-small">Showing high-priority alerts. Pick a type above to see all of it.</p>}
      </section>

      <div className="shs-tabs">
        {[['keywords', `Keywords (${keywords.total})`], ['people', 'Who added what'], ['runs', `Runs (${runs.length})`]].map(([k, label]) => (
          <button key={k} type="button" className={`shs-tab${section === k ? ' shs-tab--on' : ''}`} onClick={() => setSection(k)}>{label}</button>
        ))}
      </div>

      {section === 'keywords' && (
        <section className="sha-section">
          <div className="trp-filters">
            <label className="trp-field sha-search"><span>Search keyword</span><input type="search" value={filters.q} onChange={set('q')} /></label>
            <label className="trp-field"><span>Position</span>
              <select value={filters.bucket} onChange={set('bucket')}>
                <option value="">Any</option><option value="top3">Top 3</option><option value="top10">Top 10</option>
                <option value="ranked">Ranked</option><option value="not_ranked">Not ranked</option>
                <option value="failed">Check failed</option><option value="unparsed">Unreadable value</option>
              </select>
            </label>
            <label className="trp-field"><span>AI Overview</span>
              <select value={filters.ai} onChange={set('ai')}>
                <option value="">Any</option><option value="cited">Cited</option><option value="not_cited">Not cited</option><option value="none">No AI Overview</option>
              </select>
            </label>
            <label className="trp-field"><span>Movement</span>
              <select value={filters.movement} onChange={set('movement')}>
                <option value="">Any</option><option value="improved">Improved</option><option value="dropped">Dropped</option>
                <option value="same">No change</option><option value="new">New</option><option value="not_comparable">Not comparable</option>
              </select>
            </label>
            <label className="trp-field"><span>Added by</span>
              <select value={filters.addedBy} onChange={set('addedBy')}>
                <option value="">Anyone</option><option value="imported">Before tracking</option><option value="unknown">Unknown user</option>
                {people.filter((p) => p.email).map((p) => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
              </select>
            </label>
            <div className="sha-actions">
              {JSON.stringify(filters) !== JSON.stringify(EMPTY) && <button type="button" className="shs-secondary-btn" onClick={() => { setPage(1); setFilters(EMPTY); }}>Reset</button>}
              <button type="button" className="shs-secondary-btn" onClick={() => exportCsv('keywords')} disabled={busy === 'keywords' || !keywords.total}>Keywords CSV</button>
              <button type="button" className="shs-secondary-btn" onClick={() => exportCsv('history')} disabled={busy === 'history' || !keywords.total}>History CSV</button>
            </div>
          </div>
          {keywords.items.length === 0 ? <div className="trp-empty">No keywords match these filters.</div> : (
            <div className="trp-table-wrap">
              <table className="trp-table">
                <thead><tr><th>Keyword</th>{!tab && <th>Site</th>}<th>Added by</th><th>Now</th><th>Before</th><th>Change</th><th>Best</th><th>AI Overview</th><th>Trend</th></tr></thead>
                <tbody>
                  {keywords.items.map((k) => (
                    <tr key={k.id} className="shs-click" onClick={() => onOpenKeyword(k.id)}>
                      <td className="shs-topic">
                        <strong>{k.keyword}</strong>
                        {k.targetUrl && <div className="shs-muted">{k.targetUrl.replace(/^https?:\/\//, '').slice(0, 60)}</div>}
                        <div className="shr-flags">
                          {k.isDuplicate && <span className="shs-badge shs-badge--awaiting-approval">duplicate</span>}
                          {k.hasOverride && <span className="shs-badge shs-badge--error">manual override</span>}
                          {k.hasUnparsed && <span className="shs-badge shs-badge--error">unreadable value</span>}
                          {k.pageChanged && <span className="shs-badge shs-badge--awaiting-approval">ranking page changed</span>}
                          {k.rankedWithoutUrl && <span className="shs-badge">no Live URL</span>}
                        </div>
                      </td>
                      {!tab && <td>{k.tab}</td>}
                      <td>{k.isImported ? <span className="shs-muted">before tracking</span> : (k.addedBy?.name || k.addedBy?.email || <span className="shs-muted">Unknown user</span>)}
                        {!k.isImported && k.addedAt && <div className="shs-muted">{formatWhen(k.addedAt, !k.addedBy?.email)}</div>}</td>
                      <td><strong>{k.current?.display || '—'}</strong></td>
                      <td>{k.previous?.display || '—'}</td>
                      <td><Movement change={k.change} /></td>
                      <td>{k.best ?? '—'}</td>
                      <td><span className={`shr-ai shr-ai--${k.current?.aiState || 'blank'}`}>{AI_LABELS[k.current?.aiState || 'blank']}</span></td>
                      <td className="shr-trend"><Sparkline points={k.sparkline} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {keywords.total > PAGE_SIZE && (
            <div className="sha-pager">
              <button type="button" className="shs-secondary-btn" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>Previous</button>
              <span>Page {page} of {totalPages}</span>
              <button type="button" className="shs-secondary-btn" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>Next</button>
            </div>
          )}
        </section>
      )}

      {section === 'people' && (
        <section className="sha-section">
          <table className="trp-table shs-compact">
            <thead><tr><th>Person</th><th>Keywords added</th><th>Edits</th><th>Removed</th><th>Last activity</th><th>Recently added</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.email || (p.imported ? 'imported' : 'unknown')}>
                  <td>{p.imported ? <em>Before tracking</em> : (p.name || p.email || 'Unknown user')}</td>
                  <td>{p.addedCount}</td><td>{p.edits}</td><td>{p.removed}</td><td>{formatWhen(p.lastActivity)}</td>
                  <td className="shs-muted">{(p.added || []).slice(0, 5).map((a) => a.keyword).join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="shs-muted shs-small">Names come from the Apps Script on the Keyword URL Source Sheet. Without it, additions show as Unknown user.</p>
        </section>
      )}

      {section === 'runs' && (
        <section className="sha-section">
          <div className="trp-table-wrap">
            <table className="trp-table shs-compact">
              <thead><tr><th>Date</th>{!tab && <th>Site</th>}<th>Run</th><th>Trigger</th><th>Checked</th><th>OK</th><th>Failed</th><th>Source</th><th>API / location</th><th>Cost</th><th>Duration</th></tr></thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id} className={r.failed ? 'shs-row--stuck' : ''}>
                    <td>{r.checkDate}</td>{!tab && <td>{r.tab}</td>}<td>{r.label}{r.column && <span className="shs-muted"> ({r.column})</span>}</td>
                    <td>{r.trigger}</td><td>{r.checked}</td><td>{r.success}</td><td>{r.failed || ''}</td>
                    <td>{r.source === 'job' ? 'job report' : 'sheet'}</td>
                    <td>{[r.api, r.location, r.gl && `gl=${r.gl}`].filter(Boolean).join(' · ') || <span className="shs-muted">not reported</span>}</td>
                    <td>{r.cost ?? '—'}</td><td>{r.durationSeconds ? `${Math.round(r.durationSeconds)} s` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="shs-muted shs-small">Trigger is inferred from the date (Monday = scheduled, other days = manual) unless the job reports it.</p>
        </section>
      )}
    </div>
  );
}
