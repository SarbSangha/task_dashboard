import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { claudeCodeCaptureAPI } from '../../../../../../services/api';
import ClaudeCodeComputersPanel from './ClaudeCodeComputersPanel';
import { DAY, dayKey, fmtN, fmtTime, fmtUSD, normalizeApiError } from './claudeCodeCaptureUtils';
// The Cursor tab's look (.cut), shared so both usage pages read the same.
import '../cursor-capture/CursorUsageDashboard.css';

/**
 * The Claude Code tab's usage page - same layout as the Cursor tab (tiles,
 * By person, Daily burn, By model, Every prompt), fed by
 * GET /api/providers/claude-code/view. Unlike Cursor there's no CSV: every
 * model call arrives with Claude Code's own tokens and cost, so nothing waits
 * for an upload. The server does the totals and paging; search/sort/page
 * just ask it again.
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
const readStore = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };
const personOf = (p) => p.ownerName || (p.ownerUserId ? `User #${p.ownerUserId}` : 'Unknown');
const promptLabel = (p) => {
  if (!p.hasPrompt) return 'Background requests (no typed prompt)';
  if (p.promptText) return p.promptText;
  if (p.commandName) return `/${p.commandName}`;
  return '(prompt text not sent)';
};
const shortSession = (id) => (id ? `Session ${String(id).slice(0, 8)}` : '');

function bounds(range) {
  const now = new Date();
  const sod = new Date(now);
  sod.setHours(0, 0, 0, 0);
  if (range === 'today') return [sod.getTime(), Date.now() + 60000];
  if (range === 'month') return [new Date(now.getFullYear(), now.getMonth(), 1).getTime(), Date.now() + 60000];
  return [sod.getTime() - (Number(range) - 1) * DAY, Date.now() + 60000];
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x || 0.01)));
  const f = x / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
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

  if (!daily.length) return <div className="cut-daily" ref={ref}><div className="cut-empty">No Claude Code usage in this period.</div></div>;

  // Every day of the period gets a slot, so quiet days show as gaps.
  const [from, to] = bounds(range);
  const byDay = new Map();
  for (let t = from; t < to - 60000; t += DAY) byDay.set(dayKey(t), { usd: 0, n: 0 });
  for (const d of daily) byDay.set(d.date, { usd: d.costUsd, n: d.prompts });
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const W = Math.max(width, 280); const H = 220; const padL = 44; const padB = 22; const padT = 8;
  const max = Math.max(...days.map(([, d]) => d.usd), 0.01);
  const step = niceStep(max / 4);
  const topV = Math.ceil(max / step) * step || step;
  const cw = (W - padL) / days.length; const bw = Math.max(2, Math.min(36, cw - 4));
  const y = (v) => padT + (H - padT - padB) * (1 - v / topV);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor((W - padL) / 52)));
  const gridLines = [];
  for (let v = 0; v <= topV + 1e-9; v += step) gridLines.push(v);

  return (
    <div className="cut-daily" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily Claude Code cost bar chart" onMouseLeave={() => setTip(null)}>
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="var(--cut-grid)" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fill="var(--cut-muted)" fontSize="11">
              ${v === 0 ? '0' : v < 1 ? v.toFixed(v < 0.1 ? 3 : 2) : v.toFixed(v % 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        {days.map(([k, d], i) => {
          const x = padL + i * cw + (cw - bw) / 2; const top = y(d.usd); const h = Math.max(0, H - padB - top);
          const r = Math.min(4, bw / 2, h);
          const label = new Date(`${k}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          const tipText = `${new Date(`${k}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtUSD(d.usd)} · ${d.n} prompt${d.n === 1 ? '' : 's'}`;
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

function ByModel({ models }) {
  const total = models.reduce((s, m) => s + m.costUsd, 0) || 1;
  const shown = models.slice(0, 7);
  if (models.length > 7) {
    shown.push(models.slice(7).reduce((a, m) => ({
      model: 'Other', costUsd: a.costUsd + m.costUsd, requests: a.requests + m.requests, totalTokens: a.totalTokens + m.totalTokens,
    }), { model: 'Other', costUsd: 0, requests: 0, totalTokens: 0 }));
  }
  if (!shown.length) return <div className="cut-empty">No data</div>;
  return shown.map((m) => (
    <div className="cut-model-row" key={m.model} title={`${m.model} · ${fmtUSD(m.costUsd)} · ${m.requests} model calls · ${fmtN(m.totalTokens)} tokens`}>
      <div className="name">{m.model}</div>
      <div className="amt mono">{fmtUSD(m.costUsd)}</div>
      <div className="cut-track"><div className="cut-fill" style={{ width: `${((m.costUsd / total) * 100).toFixed(1)}%` }} /></div>
      <div className="meta">{Math.round((m.costUsd / total) * 100)}% · {m.requests} call{m.requests === 1 ? '' : 's'} · avg {fmtUSD(m.costUsd / Math.max(m.requests, 1))}</div>
    </div>
  ));
}

export default function ClaudeCodeUsageDashboard({ searchInput = '' }) {
  const [range, setRange] = useState(() => readStore('claudeCodeTab.range', '7'));
  const [personId, setPersonId] = useState(() => readStore('claudeCodeTab.person', ''));
  const [search, setSearch] = useState(searchInput);
  const [sort, setSort] = useState({ key: 'ts', dir: -1 });
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [open, setOpen] = useState(() => new Set());
  const [showComputers, setShowComputers] = useState(false);
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
      const response = await claudeCodeCaptureAPI.getView(params());
      if (token !== requestRef.current) return;
      setData(response.data);
      setError('');
    } catch (fetchError) {
      if (token !== requestRef.current) return;
      setError(normalizeApiError(fetchError, 'Unable to load Claude Code usage.'));
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
  // A remembered person with no usage in this period: show everyone instead
  // of an empty page with nobody picked in the list.
  useEffect(() => {
    if (personId && data && !data.people.some((p) => String(p.userId) === String(personId))) {
      setPersonId('');
      writeStore('claudeCodeTab.person', '');
    }
  }, [data, personId]);
  const rows = data?.prompts || [];
  const totals = data?.totals;
  const total = data?.pagination?.total || 0;
  const pages = Math.max(1, Math.ceil(total / PAGE));
  const activePerson = personId && people.some((p) => String(p.userId) === String(personId)) ? String(personId) : '';
  const activeName = activePerson ? people.find((p) => String(p.userId) === activePerson)?.name : '';
  const everyoneCost = people.reduce((s, p) => s + p.costUsd, 0);

  const changeRange = (r) => { setRange(r); writeStore('claudeCodeTab.range', r); setOpen(new Set()); setPage(0); };
  const changePerson = (id) => { const v = id ? String(id) : ''; setPersonId(v); writeStore('claudeCodeTab.person', v); setPage(0); };
  const sortBy = (key) => {
    setSort((cur) => ({ key, dir: cur.key === key ? -cur.dir : (key === 'model' || key === 'person' ? 1 : -1) }));
    setPage(0);
  };
  const arrow = (key) => (sort.key === key ? (sort.dir < 0 ? ' ▾' : ' ▴') : '');
  const toggleRow = (id) => setOpen((cur) => { const next = new Set(cur); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all = [];
      for (let offset = 0; ; offset += EXPORT_PAGE) {
        const response = await claudeCodeCaptureAPI.getView(params({ limit: EXPORT_PAGE, offset }));
        all.push(...response.data.prompts);
        if (all.length >= response.data.pagination.total || !response.data.prompts.length) break;
      }
      const head = ['time', 'person', 'where', 'session', 'prompt', 'models', 'requests', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'total_tokens', 'cost_usd', 'claude_login'];
      const lines = [head.join(',')].concat(all.map((p) => [
        p.promptedAt, personOf(p), p.surface, p.sessionId, promptLabel(p), p.models.join(' + '), p.requests,
        p.tokens.input, p.tokens.output, p.tokens.cacheRead, p.tokens.cacheWrite, p.totalTokens, p.costUsd.toFixed(6), p.claudeAccountEmail,
      ].map(q).join(',')));
      downloadText(lines.join('\n'), `claude-code-usage-${dayKey(Date.now())}.csv`);
    } catch (exportError) {
      setError(normalizeApiError(exportError, 'Export failed.'));
    } finally {
      setExporting(false);
    }
  };

  const downloadReport = () => {
    const [from, to] = bounds(range);
    const L = [q(`Claude Code usage report ${dayKey(from)} to ${dayKey(Math.min(to, Date.now()))}`), q('Cost is what Claude Code reports at API prices.'), ''];
    L.push(['person', 'prompts', 'model_calls', 'tokens', 'cost_share_pct', 'credit_usd', 'background_usd', 'last_active'].map(q).join(','));
    for (const p of people) {
      L.push([p.name, p.prompts, p.requests, p.totalTokens, everyoneCost ? ((p.costUsd / everyoneCost) * 100).toFixed(1) : '0',
        p.costUsd.toFixed(6), p.backgroundCostUsd.toFixed(6), p.lastActiveAt].map(q).join(','));
    }
    L.push(['TOTAL', people.reduce((s, p) => s + p.prompts, 0), people.reduce((s, p) => s + p.requests, 0),
      people.reduce((s, p) => s + p.totalTokens, 0), '100', everyoneCost.toFixed(6),
      people.reduce((s, p) => s + p.backgroundCostUsd, 0).toFixed(6), ''].map(q).join(','));
    L.push('', [activeName ? `date (${activeName})` : 'date', 'prompts', 'model_calls', 'credit_usd'].map(q).join(','));
    for (const d of data?.daily || []) L.push([d.date, d.prompts, d.requests, d.costUsd.toFixed(6)].map(q).join(','));
    downloadText(L.join('\n'), `claude-code-usage-report-${dayKey(from)}.csv`);
  };

  const promptCost = totals?.promptCostUsd || 0;
  const cacheShare = totals?.totalTokens ? Math.round((totals.cacheReadTokens / totals.totalTokens) * 100) : 0;

  return (
    <div className="cut">
      <div className="cut-header">
        <div>
          <h1>Claude Code credit burn</h1>
          <div className="cut-sub">
            {data?.lastIngestAt ? `Last data received ${fmtTime(data.lastIngestAt)}` : 'No data received yet. Connect a computer under Computers.'}
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
          <button type="button" className={`cut-btn ${showComputers ? 'on' : ''}`} onClick={() => setShowComputers((v) => !v)}>Computers</button>
        </div>
      </div>

      {showComputers && <ClaudeCodeComputersPanel />}

      {error && <div className="cut-note error">{error}</div>}
      <div className="cut-note">
        Costs are the API-price value Claude Code reports for each model call. With a Pro, Max or Team subscription nobody is billed this per request; it shows how much of the plan each person uses.
      </div>
      {totals?.backgroundCostUsd > 0 && (
        <div className="cut-note">
          {fmtUSD(totals.backgroundCostUsd)} in this period is Claude Code's own background calls (e.g. when a session starts), with no typed prompt. It's included in the totals and listed as “Background requests”.
        </div>
      )}

      <div className="cut-tiles">
        <div className="cut-tile">
          <div className="k">Credit burned</div>
          <div className="v mono">{totals ? fmtUSD(totals.costUsd) : '—'}</div>
          <div className="h">{totals && !totals.costComplete ? 'some calls had no cost reported' : 'as reported by Claude Code'}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Prompts</div>
          <div className="v mono">{totals ? totals.prompts.toLocaleString() : '—'}</div>
          <div className="h">{totals?.activeDays ? `across ${totals.activeDays} active day${totals.activeDays > 1 ? 's' : ''} · ${totals.requests.toLocaleString()} model calls` : ''}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Average per prompt</div>
          <div className="v mono">{totals?.prompts ? fmtUSD(promptCost / totals.prompts) : '—'}</div>
          <div className="h">{totals?.topPromptCostUsd != null ? `most expensive: ${fmtUSD(totals.topPromptCostUsd)}` : 'mean cost'}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Tokens</div>
          <div className="v mono">{totals?.totalTokens ? fmtN(totals.totalTokens) : '—'}</div>
          <div className="h">{cacheShare ? `${cacheShare}% cache reads` : 'input + output + cache'}</div>
        </div>
      </div>

      <div className="cut-card spaced">
        <div className="cut-tablebar">
          <div>
            <h2>By person</h2>
            <div className="cut-sub" style={{ margin: 0 }}>Who used how much in this period. Click a name to filter.</div>
          </div>
          <button type="button" className="cut-btn" onClick={downloadReport} disabled={!people.length}>Download report</button>
        </div>
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr>
                <th>Person</th><th className="num">Prompts</th><th className="num">Model calls</th><th className="num">Tokens</th>
                <th style={{ width: '26%' }}>Share of cost</th><th className="num">Credit burned</th><th>Last active</th>
              </tr>
            </thead>
            <tbody>
              {people.length ? people.map((p) => {
                const pct = everyoneCost ? (p.costUsd / everyoneCost) * 100 : 0;
                const id = String(p.userId);
                return (
                  <tr key={id} className={`prow ${activePerson && activePerson !== id ? 'dim' : ''}`} onClick={() => changePerson(activePerson === id ? '' : id)}>
                    <td><b>{p.name || `User #${p.userId}`}</b></td>
                    <td className="num mono">{p.prompts.toLocaleString()}</td>
                    <td className="num mono">{p.requests.toLocaleString()}</td>
                    <td className="num mono">{fmtN(p.totalTokens)}</td>
                    <td>
                      <div className="cut-model-row" style={{ margin: '3px 0 0' }}>
                        <div className="cut-track"><div className="cut-fill" style={{ width: `${pct.toFixed(1)}%` }} /></div>
                        <div className="meta">{Math.round(pct)}%{p.backgroundCostUsd > 0 ? ` · ${fmtUSD(p.backgroundCostUsd)} background` : ''}</div>
                      </div>
                    </td>
                    <td className="num mono">{fmtUSD(p.costUsd)}</td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.lastActiveAt)}</td>
                  </tr>
                );
              }) : <tr><td colSpan={7} className="cut-empty">{loading && !data ? 'Loading…' : 'No Claude Code usage in this period'}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="cut-grid2">
        <div className="cut-card">
          <h2>Daily burn</h2>
          <div className="cut-sub">Cost of all Claude Code calls per day (USD){activeName ? ` · ${activeName}` : ''}</div>
          <DailyChart daily={data?.daily || []} range={range} />
        </div>
        <div className="cut-card">
          <h2>By model</h2>
          <div className="cut-sub">Share of credit burned, per model call</div>
          <ByModel models={data?.byModel || []} />
        </div>
      </div>

      <div className="cut-card">
        <div className="cut-tablebar">
          <div>
            <h2>Every prompt</h2>
            <div className="cut-sub" style={{ margin: 0 }}>Click a row to see the full prompt and token breakdown. Search from the box at the top.</div>
          </div>
        </div>
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => sortBy('ts')}>Time{arrow('ts')}</th>
                <th className="sortable" onClick={() => sortBy('person')}>Person{arrow('person')}</th>
                <th>Where</th>
                <th>Prompt</th>
                <th className="sortable" onClick={() => sortBy('model')}>Model{arrow('model')}</th>
                <th className="sortable num" onClick={() => sortBy('requests')}>Calls{arrow('requests')}</th>
                <th className="sortable num" onClick={() => sortBy('tokens')}>Tokens{arrow('tokens')}</th>
                <th className="sortable num" onClick={() => sortBy('cost')}>Cost{arrow('cost')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.flatMap((p) => {
                const isOpen = open.has(p.id);
                const label = promptLabel(p);
                const out = [(
                  <tr key={p.id} className={`row ${p.hasPrompt ? '' : 'unassigned'}`} onClick={() => toggleRow(p.id)}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.promptedAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{personOf(p)}</td>
                    <td><span className="cut-chip">{p.surface.replace(/^Claude Code · /, '') || 'Claude Code'}</span></td>
                    <td>
                      <div className="cut-ptext">{label}</div>
                      {p.sessionId && <div className="cut-conv">{shortSession(p.sessionId)}</div>}
                    </td>
                    <td>{p.models.length ? p.models.map((m) => <span key={m} className="cut-chip">{m}</span>) : <span className="cut-conv">—</span>}</td>
                    <td className="num mono">{p.requests || '—'}</td>
                    <td className="num mono">{p.requests ? fmtN(p.totalTokens) : '—'}</td>
                    <td className="num mono">
                      {p.requests ? fmtUSD(p.costUsd) : '—'}
                      {p.requests > 0 && !p.costComplete && <span className="cut-est" title="Claude Code sent no cost for some of these calls">part</span>}
                    </td>
                  </tr>
                )];
                if (isOpen) {
                  out.push(
                    <tr key={`${p.id}-detail`} className="detail">
                      <td colSpan={8}>
                        <div className="cut-full">
                          {p.hasPrompt
                            ? (p.promptText || (p.commandName ? `/${p.commandName}` : `Prompt text was not sent from this computer (${p.promptLength.toLocaleString()} characters). Turn on Send prompt text in the extension to see it.`))
                            : 'Model calls Claude Code made by itself in this session, with no typed prompt - for example when a session starts.'}
                        </div>
                        <div className="cut-kv">
                          <span>Input <b className="mono">{p.tokens.input.toLocaleString()}</b></span>
                          <span>Output <b className="mono">{p.tokens.output.toLocaleString()}</b></span>
                          <span>Cache read <b className="mono">{p.tokens.cacheRead.toLocaleString()}</b></span>
                          <span>Cache write <b className="mono">{p.tokens.cacheWrite.toLocaleString()}</b></span>
                          <span>Model calls <b className="mono">{p.requests}</b></span>
                          <span>Cost source <b>Claude Code-reported (API price)</b></span>
                          <span>Where <b>{p.surface}</b></span>
                          {p.claudeAccountEmail && <span>Claude login <b>{p.claudeAccountEmail}</b></span>}
                          {p.claudeVersion && <span>Claude Code <b className="mono">{p.claudeVersion}</b></span>}
                          {p.sessionId && <span>Session <b className="mono">{p.sessionId}</b></span>}
                        </div>
                      </td>
                    </tr>,
                  );
                }
                return out;
              }) : <tr><td colSpan={8} className="cut-empty">{loading && !data ? 'Loading…' : 'No prompts match.'}</td></tr>}
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
