import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { figmaCaptureAPI } from '../../../../../../services/api';
import { DAY, dayKey, fmtCredits, fmtDuration, fmtTime, normalizeApiError } from './figmaCaptureUtils';
// The Cursor tab's look (.cut), shared so every usage page reads the same.
import '../cursor-capture/CursorUsageDashboard.css';

/**
 * The Figma tab - AI credits burned by Figma's AI agent, per person, fed by
 * GET /api/providers/figma/view. Every prompt's credits are Figma's own number
 * (what the credits icon under a reply shows), captured by the browser
 * extension in a dashboard-launched tab; the account card is Figma's own
 * balance for the shared login. Same layout as the Claude Code tab.
 */

const PAGE = 50;
const EXPORT_PAGE = 1000;
const RANGES = [
  { r: 'today', label: 'Today' },
  { r: '7', label: '7 days' },
  { r: 'month', label: 'This month' },
  { r: '30', label: '30 days' },
  { r: '90', label: '90 days' },
];
const STATUS_LABEL = { completed: '', pending: 'credits pending', failed: 'failed' };
const readStore = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };
const personOf = (p) => p.ownerName || (p.ownerUserId ? `User #${p.ownerUserId}` : 'Unknown');
const plural = (n, word) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function bounds(range) {
  const now = new Date();
  const sod = new Date(now);
  sod.setHours(0, 0, 0, 0);
  if (range === 'today') return [sod.getTime(), Date.now() + 60000];
  if (range === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Date.now() + 60000];
  return [sod.getTime() - (Number(range) - 1) * DAY, Date.now() + 60000];
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x || 1)));
  const f = x / p;
  return Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p);
}

function downloadText(text, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

function DailyChart({ daily, range }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(600);
  const [tip, setTip] = useState(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  if (!daily.length) return <div className="cut-daily" ref={ref}><div className="cut-empty">No Figma AI usage in this period.</div></div>;

  // Every day of the period gets a slot, so quiet days show as gaps.
  const [from, to] = bounds(range);
  const byDay = new Map();
  for (let t = from; t < to - 60000; t += DAY) byDay.set(dayKey(t), { credits: 0, n: 0 });
  for (const d of daily) byDay.set(d.date, { credits: d.credits, n: d.prompts });
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const W = Math.max(width, 280); const H = 220; const padL = 44; const padB = 22; const padT = 8;
  const max = Math.max(...days.map(([, d]) => d.credits), 1);
  const step = niceStep(max / 4);
  const topV = Math.ceil(max / step) * step || step;
  const cw = (W - padL) / days.length; const bw = Math.max(2, Math.min(36, cw - 4));
  const y = (v) => padT + (H - padT - padB) * (1 - v / topV);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor((W - padL) / 52)));
  const gridLines = [];
  for (let v = 0; v <= topV + 1e-9; v += step) gridLines.push(v);

  return (
    <div className="cut-daily" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily Figma AI credits bar chart" onMouseLeave={() => setTip(null)}>
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="var(--cut-grid)" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fill="var(--cut-muted)" fontSize="11">{v.toLocaleString()}</text>
          </g>
        ))}
        {days.map(([k, d], i) => {
          const x = padL + i * cw + (cw - bw) / 2; const top = y(d.credits); const h = Math.max(0, H - padB - top);
          const r = Math.min(4, bw / 2, h);
          const label = new Date(`${k}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          const tipText = `${new Date(`${k}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtCredits(d.credits)} credits · ${plural(d.n, 'prompt')}`;
          return (
            <g key={k}>
              {h > 0 && (
                <path d={`M${x},${H - padB} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${H - padB} Z`} fill="var(--cut-bar)" />
              )}
              <rect
                x={padL + i * cw} y={padT} width={cw} height={H - padT - padB} fill="transparent"
                onMouseMove={(e) => setTip({ text: tipText, x: e.clientX, y: e.clientY })}
              />
              {i % labelEvery === 0 && (
                <text x={padL + i * cw + cw / 2} y={H - 6} textAnchor="middle" fill="var(--cut-muted)" fontSize="11">{label}</text>
              )}
            </g>
          );
        })}
        <line x1={padL} x2={W} y1={H - padB} y2={H - padB} stroke="var(--cut-border)" />
      </svg>
      {tip && <div className="cut-tip" style={{ left: tip.x + 12, top: tip.y - 34 }}>{tip.text}</div>}
    </div>
  );
}

function ByFile({ files }) {
  const total = files.reduce((s, f) => s + f.credits, 0) || 1;
  if (!files.length) return <div className="cut-empty">No data</div>;
  return files.slice(0, 8).map((f) => (
    <div className="cut-model-row" key={f.fileKey || '-'} title={`${f.fileName || f.fileKey} · ${fmtCredits(f.credits)} credits · ${plural(f.prompts, 'prompt')}`}>
      <div className="name">
        {f.fileUrl ? <a href={f.fileUrl} target="_blank" rel="noreferrer">{f.fileName || f.fileKey}</a> : (f.fileName || 'Unknown file')}
      </div>
      <div className="amt mono">{fmtCredits(f.credits)}</div>
      <div className="cut-track"><div className="cut-fill" style={{ width: `${((f.credits / total) * 100).toFixed(1)}%` }} /></div>
      <div className="meta">{Math.round((f.credits / total) * 100)}% · {plural(f.prompts, 'prompt')} · {plural(f.people, 'person')}</div>
    </div>
  ));
}

function Accounts({ accounts }) {
  if (!accounts.length) {
    return <div className="cut-empty">No balance reported yet. It arrives the first time someone opens Figma from the dashboard.</div>;
  }
  return accounts.map((a) => {
    const used = a.monthlyConsumed || 0;
    const pct = a.monthlyTotal ? Math.min(100, (used / a.monthlyTotal) * 100) : 0;
    return (
      <div className="cut-model-row" key={a.figmaUserId || a.id} style={{ marginBottom: 10 }}>
        <div className="name">
          <b>{a.figmaEmail || `Figma user ${a.figmaUserId}`}</b>
          {a.planTier && <span className="cut-chip" style={{ marginLeft: 6 }}>{a.planTier}</span>}
        </div>
        <div className="amt mono">{fmtCredits(a.monthlyRemaining)} left</div>
        <div className="cut-track"><div className="cut-fill" style={{ width: `${pct.toFixed(1)}%` }} /></div>
        <div className="meta">
          {fmtCredits(used)} of {fmtCredits(a.monthlyTotal)} used this month
          {a.dailyTotal != null ? ` · today ${fmtCredits(a.dailyConsumed)} of ${fmtCredits(a.dailyTotal)}` : ''}
          {a.periodEnd ? ` · resets ${new Date(a.periodEnd).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}` : ''}
          {` · as of ${fmtTime(a.capturedAt)}`}
          {a.notCapturedCredits > 0 && (
            <span title="Figma counted these credits on this login this month, but no prompt in a dashboard-launched tab explains them - e.g. Figma used in another browser, the desktop app, or AI features outside the agent chat.">
              {` · ${fmtCredits(a.notCapturedCredits)} not captured`}
            </span>
          )}
        </div>
      </div>
    );
  });
}

export default function FigmaUsageDashboard({ searchInput = '' }) {
  const [range, setRange] = useState(() => readStore('figmaTab.range', 'month'));
  const [personId, setPersonId] = useState(() => readStore('figmaTab.person', ''));
  const [search, setSearch] = useState(searchInput);
  const [sort, setSort] = useState({ key: 'ts', dir: -1 });
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const requestRef = useRef(0);

  // The header's search box types fast; ask the server once typing pauses.
  useEffect(() => {
    const timer = setTimeout(() => { setSearch(searchInput); setPage(0); }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const params = useCallback((extra = {}) => {
    const [from, to] = bounds(range);
    return {
      from_ms: from,
      to_ms: to,
      owner_user_id: personId || undefined,
      q: search.trim() || undefined,
      sort: sort.key,
      direction: sort.dir < 0 ? 'desc' : 'asc',
      tz_offset_min: new Date().getTimezoneOffset(),
      limit: PAGE,
      offset: page * PAGE,
      ...extra,
    };
  }, [range, personId, search, sort, page]);

  const load = useCallback(async () => {
    const token = ++requestRef.current;
    setLoading(true);
    try {
      const response = await figmaCaptureAPI.getView(params());
      if (token !== requestRef.current) return;
      setData(response.data);
      setError('');
    } catch (fetchError) {
      if (token !== requestRef.current) return;
      setError(normalizeApiError(fetchError, 'Unable to load Figma usage.'));
    } finally {
      if (token === requestRef.current) setLoading(false);
    }
  }, [params]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const people = useMemo(() => data?.people || [], [data]);
  // A remembered person with no usage in this period: show everyone instead.
  useEffect(() => {
    if (personId && data && !data.people.some((p) => String(p.userId) === String(personId))) {
      setPersonId('');
      writeStore('figmaTab.person', '');
    }
  }, [data, personId]);
  const rows = data?.prompts || [];
  const totals = data?.totals;
  const total = data?.pagination?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const activePerson = personId && people.some((p) => String(p.userId) === String(personId)) ? String(personId) : '';
  const activeName = activePerson ? people.find((p) => String(p.userId) === activePerson)?.name : '';
  const everyoneCredits = people.reduce((s, p) => s + p.credits, 0);
  const accounts = data?.accounts || [];
  const remaining = accounts.reduce((s, a) => s + (a.monthlyRemaining || 0), 0);
  const allowance = accounts.reduce((s, a) => s + (a.monthlyTotal || 0), 0);

  const changeRange = (r) => { setRange(r); writeStore('figmaTab.range', r); setOpen(new Set()); setPage(0); };
  const changePerson = (id) => { const v = id ? String(id) : ''; setPersonId(v); writeStore('figmaTab.person', v); setPage(0); };
  const sortBy = (key) => {
    setSort((cur) => ({ key, dir: cur.key === key ? -cur.dir : (key === 'person' || key === 'file' ? 1 : -1) }));
    setPage(0);
  };
  const arrow = (key) => (sort.key === key ? (sort.dir < 0 ? ' ▾' : ' ▴') : '');
  const toggleRow = (id) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = [];
      for (let offset = 0; ; offset += EXPORT_PAGE) {
        const response = await figmaCaptureAPI.getView(params({ limit: EXPORT_PAGE, offset }));
        all.push(...response.data.prompts);
        if (all.length >= response.data.pagination.total || !response.data.prompts.length) break;
      }
      const head = ['time', 'person', 'file', 'prompt', 'credits', 'status', 'tool_calls', 'work_seconds', 'figma_login', 'client', 'task', 'user_action_uuid'];
      const lines = [head.join(',')].concat(all.map((p) => [
        p.promptedAt, personOf(p), p.fileName, p.promptText, p.credits ?? '', p.status, p.toolCalls ?? '',
        p.workMs ? Math.round(p.workMs / 1000) : '', p.figmaEmail, p.linkedClientName, p.linkedTaskName, p.userActionUuid,
      ].map(q).join(',')));
      downloadText(lines.join('\n'), `figma-ai-credits-${dayKey(Date.now())}.csv`);
    } catch (exportError) {
      setError(normalizeApiError(exportError, 'Export failed.'));
    } finally {
      setExporting(false);
    }
  };

  const downloadReport = () => {
    const [from, to] = bounds(range);
    const L = [q(`Figma AI credit report ${dayKey(from)} to ${dayKey(Math.min(to, Date.now()))}`), q('Credits are what Figma itself reported for each prompt.'), ''];
    L.push(['person', 'prompts', 'files', 'credit_share_pct', 'credits', 'pending', 'failed', 'last_active'].map(q).join(','));
    for (const p of people) {
      L.push([p.name, p.prompts, p.files, everyoneCredits ? ((p.credits / everyoneCredits) * 100).toFixed(1) : '0',
        p.credits, p.pending, p.failed, p.lastActiveAt].map(q).join(','));
    }
    L.push(['TOTAL', people.reduce((s, p) => s + p.prompts, 0), '', '100', everyoneCredits,
      people.reduce((s, p) => s + p.pending, 0), people.reduce((s, p) => s + p.failed, 0), ''].map(q).join(','));
    L.push('', [activeName ? `date (${activeName})` : 'date', 'prompts', 'credits'].map(q).join(','));
    for (const d of data?.daily || []) L.push([d.date, d.prompts, d.credits].map(q).join(','));
    downloadText(L.join('\n'), `figma-ai-credit-report-${dayKey(from)}.csv`);
  };

  return (
    <div className="cut">
      <div className="cut-header">
        <div>
          <h1>Figma AI credit burn</h1>
          <div className="cut-sub">
            {data?.lastIngestAt ? `Last prompt received ${fmtTime(data.lastIngestAt)}` : 'No prompts received yet. They arrive when someone uses Figma\'s AI in a tab opened from the dashboard.'}
            {loading ? ' · refreshing…' : ''}
          </div>
        </div>
        <div className="cut-controls">
          <div className="cut-seg">
            {RANGES.map(({ r, label }) => (
              <button key={r} type="button" className={range === r ? 'on' : ''} onClick={() => changeRange(r)}>{label}</button>
            ))}
          </div>
          {(people.length > 1 || activePerson) && (
            <select className="cut-btn" value={activePerson} onChange={(e) => changePerson(e.target.value)} aria-label="Person">
              <option value="">Everyone</option>
              {people.map((p) => <option key={p.userId} value={String(p.userId)}>{p.name}</option>)}
            </select>
          )}
          <button type="button" className="cut-btn" onClick={load}>Refresh</button>
          <button type="button" className="cut-btn" onClick={exportCsv} disabled={exporting || !total}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
        </div>
      </div>

      {error && <div className="cut-note error">{error}</div>}
      <div className="cut-note">
        Each prompt's credits are Figma's own figure - the same number its credits icon shows under the reply. The same request can cost a different amount each time, so nothing here is estimated.
      </div>
      {totals?.pendingPrompts > 0 && (
        <div className="cut-note">
          {plural(totals.pendingPrompts, 'prompt')} finished without Figma reporting credits yet (usually the tab was closed straight away). They count as 0 until Figma's number arrives.
        </div>
      )}

      <div className="cut-tiles">
        <div className="cut-tile">
          <div className="k">Credits burned</div>
          <div className="v mono">{totals ? fmtCredits(totals.credits) : '—'}</div>
          <div className="h">as reported by Figma</div>
        </div>
        <div className="cut-tile">
          <div className="k">Prompts</div>
          <div className="v mono">{totals ? totals.prompts.toLocaleString() : '—'}</div>
          <div className="h">{totals?.activeDays ? `across ${plural(totals.activeDays, 'active day')} · ${plural(totals.files, 'file')}` : ''}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Average per prompt</div>
          <div className="v mono">{totals?.avgCredits != null ? fmtCredits(totals.avgCredits) : '—'}</div>
          <div className="h">{totals?.topPromptCredits != null ? `most expensive: ${fmtCredits(totals.topPromptCredits)}` : 'credits'}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Credits left this month</div>
          <div className="v mono">{accounts.length ? fmtCredits(remaining) : '—'}</div>
          <div className="h">{accounts.length ? `of ${fmtCredits(allowance)} · ${plural(accounts.length, 'Figma login')}` : 'no balance reported yet'}</div>
        </div>
      </div>

      <div className="cut-card spaced">
        <h2>Figma accounts</h2>
        <div className="cut-sub">Each shared Figma login's AI credit balance, as Figma last reported it</div>
        <Accounts accounts={accounts} />
      </div>

      <div className="cut-card spaced">
        <div className="cut-tablebar">
          <div>
            <h2>By person</h2>
            <div className="cut-sub" style={{ margin: 0 }}>Who burned how many credits in this period - the person who opened Figma from the dashboard. Click a name to filter.</div>
          </div>
          <button type="button" className="cut-btn" onClick={downloadReport} disabled={!people.length}>Download report</button>
        </div>
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr>
                <th>Person</th><th className="num">Prompts</th><th className="num">Files</th>
                <th style={{ width: '30%' }}>Share of credits</th><th className="num">Credits</th><th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {people.length ? people.map((p) => {
                const pct = everyoneCredits ? (p.credits / everyoneCredits) * 100 : 0;
                const id = String(p.userId);
                return (
                  <tr key={id} className={`prow ${activePerson && activePerson !== id ? 'dim' : ''}`} onClick={() => changePerson(activePerson === id ? '' : id)}>
                    <td><b>{p.name || `User #${p.userId}`}</b></td>
                    <td className="num mono">{p.prompts.toLocaleString()}</td>
                    <td className="num mono">{p.files.toLocaleString()}</td>
                    <td>
                      <div className="cut-model-row" style={{ margin: '3px 0 0' }}>
                        <div className="cut-track"><div className="cut-fill" style={{ width: `${pct.toFixed(1)}%` }} /></div>
                        <div className="meta">
                          {Math.round(pct)}%
                          {p.pending ? ` · ${p.pending} pending` : ''}
                          {p.failed ? ` · ${p.failed} failed` : ''}
                        </div>
                      </div>
                    </td>
                    <td className="num mono">{fmtCredits(p.credits)}</td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.lastActiveAt)}</td>
                  </tr>
                );
              }) : <tr><td colSpan={6} className="cut-empty">{loading && !data ? 'Loading…' : 'No Figma AI usage in this period'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cut-grid2">
        <div className="cut-card">
          <h2>Daily burn</h2>
          <div className="cut-sub">Figma AI credits per day{activeName ? ` · ${activeName}` : ''}</div>
          <DailyChart daily={data?.daily || []} range={range} />
        </div>
        <div className="cut-card">
          <h2>By file</h2>
          <div className="cut-sub">Where the credits went</div>
          <ByFile files={data?.byFile || []} />
        </div>
      </div>

      <div className="cut-card">
        <div className="cut-tablebar">
          <div>
            <h2>Every prompt</h2>
            <div className="cut-sub" style={{ margin: 0 }}>Click a row to see the full prompt. Search from the box at the top.</div>
          </div>
        </div>
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => sortBy('ts')}>Time{arrow('ts')}</th>
                <th className="sortable" onClick={() => sortBy('person')}>Person{arrow('person')}</th>
                <th className="sortable" onClick={() => sortBy('file')}>File{arrow('file')}</th>
                <th>Prompt</th>
                <th className="num">Steps</th>
                <th className="sortable num" onClick={() => sortBy('credits')}>Credits{arrow('credits')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.flatMap((p) => {
                const isOpen = open.has(p.id);
                const out = [(
                  <tr key={p.id} className={`row ${p.status === 'failed' ? 'unassigned' : ''}`} onClick={() => toggleRow(p.id)}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.promptedAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{personOf(p)}</td>
                    <td>{p.fileName || <span className="cut-conv">—</span>}</td>
                    <td><div className="cut-ptext">{p.promptText || '(no text)'}</div></td>
                    <td className="num mono">{p.toolCalls ?? '—'}</td>
                    <td className="num mono">
                      {fmtCredits(p.credits)}
                      {STATUS_LABEL[p.status] && <span className="cut-est">{STATUS_LABEL[p.status]}</span>}
                    </td>
                  </tr>
                )];
                if (isOpen) {
                  out.push(
                    <tr key={`${p.id}-detail`} className="detail">
                      <td colSpan={6}>
                        <div className="cut-full">{p.promptText || '(no text)'}</div>
                        <div className="cut-kv">
                          <span>Credits <b className="mono">{fmtCredits(p.credits)}</b></span>
                          <span>Status <b>{p.status}</b></span>
                          <span>Agent steps <b className="mono">{p.toolCalls ?? '—'}</b></span>
                          <span>Work time <b className="mono">{fmtDuration(p.workMs)}</b></span>
                          {p.fileUrl && <span>File <b><a href={p.fileUrl} target="_blank" rel="noreferrer">{p.fileName || p.fileKey}</a></b></span>}
                          {p.figmaEmail && <span>Figma login <b>{p.figmaEmail}</b></span>}
                          {p.linkedClientName && <span>Client <b>{p.linkedClientName}</b></span>}
                          {p.linkedTaskName && <span>Task <b>{p.linkedTaskName}</b></span>}
                          <span>Figma action <b className="mono">{p.userActionUuid}</b></span>
                        </div>
                      </td>
                    </tr>,
                  );
                }
                return out;
              }) : <tr><td colSpan={6} className="cut-empty">{loading && !data ? 'Loading…' : 'No prompts match.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="cut-pager">
          <span>{total.toLocaleString()} rows · page {Math.min(page + 1, pages)} of {pages}</span>
          <button type="button" className="cut-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button type="button" className="cut-btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      </div>
    </div>
  );
}
