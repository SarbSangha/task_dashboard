import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cursorCaptureAPI } from '../../../../../../services/api';
import CursorDevicesPanel from './CursorDevicesPanel';
import { normalizeApiError } from './cursorCaptureUtils';
import './CursorUsageDashboard.css';

/**
 * The Cursor tab's usage page - a clone of the standalone Cursor Usage Tracker
 * site's dashboard (tiles, By person, Daily burn, By model, Every prompt), fed
 * by GET /api/providers/cursor/view instead of that site's /api/data. Tokens
 * and cost come from the uploaded Cursor usage CSV; prompts with no matching
 * row show "—", never 0.
 */

const DAY = 86400000;
const PAGE = 50;
const RANGES = [
  { r: 'today', label: 'Today' },
  { r: '7', label: '7 days' },
  { r: 'month', label: 'This month' },
  { r: '30', label: '30 days' },
  { r: '90', label: '90 days' },
];
const UNASSIGNED = 'Unassigned';

const fmtUSD = (c) => (c === null || c === undefined ? '—' : `$${(c / 100).toFixed(c >= 10 ? 2 : 3)}`);
const fmtN = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(Math.round(n)));
const fmtTime = (ts) => new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const dayKey = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const personOf = (p) => p.ownerName || (p.ownerUserId ? `User #${p.ownerUserId}` : 'Unknown');
const modelsOf = (p) => (p.models?.length ? p.models : p.localModels || []);
const tokensOf = (p) => p.tokens?.total || 0;
const readStore = (key, fallback) => { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } };
const writeStore = (key, value) => { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } };

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

// Large exports go up in pieces under the 1 MB request limit common in front of
// the API (nginx's default); safe because the backend dedupes rows.
const CSV_CHUNK_BYTES = 512 * 1024;
function splitCsvForUpload(text) {
  if (text.length <= CSV_CHUNK_BYTES) return [text];
  const [header, ...lines] = text.split(/\r?\n/);
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (current.length && size + line.length > CSV_CHUNK_BYTES) {
      chunks.push([header, ...current].join('\n'));
      current = [];
      size = 0;
    }
    current.push(line);
    size += line.length + 1;
  }
  if (current.length) chunks.push([header, ...current].join('\n'));
  return chunks;
}

// One row per person, plus "Unassigned" for usage no one had a prompt running
// for, so the rows add up to the account total in Cursor's CSV.
function summarize(list, unmatched = []) {
  const m = new Map();
  for (const p of list) {
    const key = personOf(p);
    const d = m.get(key) || { person: key, prompts: 0, tokens: 0, cents: 0, last: 0, pending: 0, shared: 0 };
    d.prompts += 1;
    d.tokens += tokensOf(p);
    d.cents += p.costCents || 0;
    d.last = Math.max(d.last, new Date(p.promptedAt).getTime());
    if (!p.tokens) d.pending += 1;
    if (p.shared) d.shared += 1;
    m.set(key, d);
  }
  const rows = [...m.values()].sort((a, b) => b.tokens - a.tokens || b.prompts - a.prompts);
  if (unmatched.length) {
    rows.push({
      person: UNASSIGNED, unassigned: true, prompts: 0, pending: 0, shared: 0,
      tokens: unmatched.reduce((s, e) => s + e.tokens.total, 0),
      cents: unmatched.reduce((s, e) => s + (e.costCents || 0), 0),
      last: Math.max(...unmatched.map((e) => new Date(e.occurredAt).getTime())),
    });
  }
  return rows;
}

function DailyChart({ prompts, range }) {
  const ref = useRef(null);
  const [width, setWidth] = useState(600);
  const [tip, setTip] = useState(null);

  useEffect(() => {
    if (!ref.current) return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);

  if (!prompts.length) return <div className="cut-daily" ref={ref}><div className="cut-empty">No prompts in this period.</div></div>;

  const [from, to] = bounds(range);
  const byDay = new Map();
  for (let t = from; t < to - 60000; t += DAY) byDay.set(dayKey(t), { cents: 0, n: 0 });
  for (const p of prompts) {
    const k = dayKey(new Date(p.promptedAt).getTime());
    const d = byDay.get(k) || { cents: 0, n: 0 };
    d.cents += p.costCents || 0;
    d.n += 1;
    byDay.set(k, d);
  }
  const days = [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const W = Math.max(width, 280); const H = 220; const padL = 44; const padB = 22; const padT = 8;
  const max = Math.max(...days.map(([, d]) => d.cents), 1);
  const step = niceStep(max / 100 / 4);
  const topV = Math.ceil(max / 100 / step) * step || step;
  const cw = (W - padL) / days.length; const bw = Math.max(2, Math.min(36, cw - 4));
  const y = (v) => padT + (H - padT - padB) * (1 - v / topV);
  const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor((W - padL) / 52)));
  const gridLines = [];
  for (let v = 0; v <= topV + 1e-9; v += step) gridLines.push(v);

  return (
    <div className="cut-daily" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Daily cost bar chart" onMouseLeave={() => setTip(null)}>
        {gridLines.map((v) => (
          <g key={v}>
            <line x1={padL} x2={W} y1={y(v)} y2={y(v)} stroke="var(--cut-grid)" />
            <text x={padL - 6} y={y(v) + 4} textAnchor="end" fill="var(--cut-muted)" fontSize="11">
              ${v < 1 ? v.toFixed(2) : v.toFixed(v % 1 ? 1 : 0)}
            </text>
          </g>
        ))}
        {days.map(([k, d], i) => {
          const x = padL + i * cw + (cw - bw) / 2; const top = y(d.cents / 100); const h = Math.max(0, H - padB - top);
          const r = Math.min(4, bw / 2, h);
          const label = new Date(`${k}T00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
          const tipText = `${new Date(`${k}T00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtUSD(d.cents)} · ${d.n} prompt${d.n === 1 ? '' : 's'}`;
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

function ByModel({ priced }) {
  const m = new Map();
  for (const p of priced) {
    const name = modelsOf(p).length ? modelsOf(p).join(' + ') : 'unknown';
    const d = m.get(name) || { cents: 0, n: 0, tok: 0 };
    d.cents += p.costCents || 0; d.n += 1; d.tok += tokensOf(p);
    m.set(name, d);
  }
  const rows = [...m.entries()].sort((a, b) => b[1].cents - a[1].cents);
  const total = rows.reduce((s, [, d]) => s + d.cents, 0) || 1;
  const shown = rows.slice(0, 7);
  if (rows.length > 7) {
    shown.push(['Other', rows.slice(7).reduce((a, [, d]) => ({ cents: a.cents + d.cents, n: a.n + d.n, tok: a.tok + d.tok }), { cents: 0, n: 0, tok: 0 })]);
  }
  if (!shown.length) return <div className="cut-empty">No data</div>;
  return shown.map(([name, d]) => (
    <div className="cut-model-row" key={name} title={`${name} · ${fmtUSD(d.cents)} · ${d.n} prompts · ${fmtN(d.tok)} tokens`}>
      <div className="name">{name}</div>
      <div className="amt mono">{fmtUSD(d.cents)}</div>
      <div className="cut-track"><div className="cut-fill" style={{ width: `${((d.cents / total) * 100).toFixed(1)}%` }} /></div>
      <div className="meta">{Math.round((d.cents / total) * 100)}% · {d.n} prompt{d.n === 1 ? '' : 's'} · avg {fmtUSD(d.cents / d.n)}</div>
    </div>
  ));
}

export default function CursorUsageDashboard({ searchInput = '' }) {
  const [range, setRange] = useState(() => readStore('cursorTab.range', '7'));
  const [person, setPerson] = useState(() => readStore('cursorTab.person', ''));
  const [accounts, setAccounts] = useState([]);
  const [accountEmail, setAccountEmail] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState({ key: 'ts', dir: -1 });
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState(() => new Set());
  const [fullText, setFullText] = useState({});
  const [uploading, setUploading] = useState(false);
  const [uploadNote, setUploadNote] = useState(null);
  const [showDevices, setShowDevices] = useState(false);
  const fileRef = useRef(null);
  const requestRef = useRef(0);

  useEffect(() => {
    cursorCaptureAPI.listAccounts()
      .then((response) => {
        const list = (response.data || []).filter((a) => a.email);
        setAccounts(list);
        if (list.length === 1) setAccountEmail((current) => current || list[0].email);
      })
      .catch(() => setAccounts([]));
  }, [data?.latestUpload?.id]);

  const load = useCallback(async () => {
    const token = ++requestRef.current;
    const [from, to] = bounds(range);
    setLoading(true);
    try {
      const response = await cursorCaptureAPI.getView({ from_ms: from, to_ms: to, account_email: accountEmail || undefined });
      if (token !== requestRef.current) return;
      setData(response.data);
      setError('');
    } catch (fetchError) {
      if (token !== requestRef.current) return;
      setError(normalizeApiError(fetchError, 'Unable to load Cursor usage.'));
    } finally {
      if (token === requestRef.current) setLoading(false);
    }
  }, [range, accountEmail]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) load(); }, 60000);
    return () => clearInterval(timer);
  }, [load]);

  const all = useMemo(() => data?.prompts || [], [data]);
  const unmatched = useMemo(() => data?.unmatched || [], [data]);
  const people = useMemo(() => [...new Set(all.map(personOf))].sort(), [all]);
  const activePerson = person && people.includes(person) ? person : '';
  const scoped = useMemo(() => (activePerson ? all.filter((p) => personOf(p) === activePerson) : all), [all, activePerson]);
  const priced = useMemo(() => scoped.filter((p) => p.costCents !== null && p.costCents !== undefined), [scoped]);

  const view = useMemo(() => {
    const s = (searchInput || '').trim().toLowerCase();
    const rows = scoped.filter((p) => !s
      || (p.text || '').toLowerCase().includes(s)
      || personOf(p).toLowerCase().includes(s)
      || (p.conversationName || '').toLowerCase().includes(s)
      || modelsOf(p).join(' ').toLowerCase().includes(s));
    const val = (p) => {
      switch (sort.key) {
        case 'ts': return new Date(p.promptedAt).getTime();
        case 'person': return personOf(p);
        case 'text': return p.text || '';
        case 'model': return modelsOf(p).join();
        case 'requests': return p.requests || -1;
        case 'tokens': return p.tokens ? p.tokens.total : -1;
        case 'cents': return p.costCents ?? -1;
        default: return 0;
      }
    };
    return rows.sort((a, b) => { const va = val(a); const vb = val(b); return (va > vb ? 1 : va < vb ? -1 : 0) * sort.dir; });
  }, [scoped, searchInput, sort]);

  const pages = Math.max(1, Math.ceil(view.length / PAGE));
  const safePage = Math.min(page, pages - 1);
  const slice = view.slice(safePage * PAGE, safePage * PAGE + PAGE);

  const changeRange = (r) => { setRange(r); writeStore('cursorTab.range', r); setOpen(new Set()); setPage(0); };
  const changePerson = (p) => { setPerson(p); writeStore('cursorTab.person', p); setPage(0); };
  const sortBy = (key) => setSort((cur) => ({ key, dir: cur.key === key ? -cur.dir : (key === 'text' || key === 'model' || key === 'person' ? 1 : -1) }));
  const arrow = (key) => (sort.key === key ? (sort.dir < 0 ? ' ▾' : ' ▴') : '');

  const toggleRow = async (p) => {
    setOpen((cur) => { const next = new Set(cur); if (next.has(p.id)) next.delete(p.id); else next.add(p.id); return next; });
    if (p.textTruncated && fullText[p.id] === undefined) {
      try {
        const response = await cursorCaptureAPI.getPrompt(p.id);
        setFullText((cur) => ({ ...cur, [p.id]: response.data.promptText || '' }));
      } catch {
        setFullText((cur) => ({ ...cur, [p.id]: null }));
      }
    }
  };

  const handleUpload = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (accounts.length > 1 && !accountEmail) {
      setUploadNote({ error: true, text: 'Pick which Cursor login this CSV was exported from first (the account selector), then upload.' });
      return;
    }
    setUploading(true);
    try {
      const totals = { rowCount: 0, addedCount: 0, matchedCount: 0, unassignedCount: 0, skippedCount: 0 };
      for (const chunk of splitCsvForUpload(await file.text())) {
        const response = await cursorCaptureAPI.uploadUsageCsv(chunk, { accountEmail: accountEmail || accounts[0]?.email, fileName: file.name });
        for (const key of Object.keys(totals)) totals[key] += response.data[key] || 0;
      }
      setUploadNote({
        text: `Imported ${file.name}: ${totals.rowCount.toLocaleString()} requests (${totals.addedCount.toLocaleString()} new), `
          + `${totals.matchedCount.toLocaleString()} matched to a prompt, ${totals.unassignedCount.toLocaleString()} unassigned`
          + (totals.skippedCount ? `, ${totals.skippedCount} rows skipped (unreadable date)` : '') + '.',
      });
      await load();
    } catch (uploadError) {
      setUploadNote({ error: true, text: `Couldn't import ${file.name}: ${normalizeApiError(uploadError, 'upload failed')}` });
    } finally {
      setUploading(false);
    }
  };

  const exportCsv = () => {
    const head = ['time', 'person', 'chat', 'mode', 'prompt', 'models', 'requests', 'agent_steps', 'input_tokens', 'output_tokens', 'cache_read', 'cache_write', 'total_tokens', 'cost_usd', 'split'];
    const lines = [head.join(',')].concat(view.map((p) => [
      p.promptedAt, personOf(p), p.conversationName, p.mode, fullText[p.id] || p.text, modelsOf(p).join(' + '), p.requests, p.steps,
      p.tokens?.input ?? '', p.tokens?.output ?? '', p.tokens?.cacheRead ?? '', p.tokens?.cacheWrite ?? '', p.tokens?.total ?? '',
      p.costCents === null || p.costCents === undefined ? '' : (p.costCents / 100).toFixed(4), p.shared ? 'yes' : 'no',
    ].map(q).join(',')));
    downloadText(lines.join('\n'), `cursor-usage-${dayKey(Date.now())}.csv`);
  };

  const downloadReport = () => {
    const [from, to] = bounds(range);
    const rows = summarize(all, unmatched);
    const totalTok = rows.reduce((s, r) => s + r.tokens, 0) || 1;
    const L = [q(`Cursor usage report ${dayKey(from)} to ${dayKey(Math.min(to, Date.now()))}`), ''];
    L.push(['person', 'prompts', 'tokens', 'token_share_pct', 'credit_usd', 'prompts_waiting_for_csv'].map(q).join(','));
    for (const r of rows) L.push([r.person, r.prompts, r.tokens, ((r.tokens / totalTok) * 100).toFixed(1), (r.cents / 100).toFixed(4), r.pending].map(q).join(','));
    L.push(['TOTAL', rows.reduce((s, r) => s + r.prompts, 0), rows.reduce((s, r) => s + r.tokens, 0), '100', (rows.reduce((s, r) => s + r.cents, 0) / 100).toFixed(4), rows.reduce((s, r) => s + r.pending, 0)].map(q).join(','));
    L.push('', ['date', 'person', 'prompts', 'tokens', 'credit_usd'].map(q).join(','));
    const daily = new Map();
    for (const p of all) {
      const k = `${dayKey(new Date(p.promptedAt).getTime())}|${personOf(p)}`;
      const d = daily.get(k) || { n: 0, t: 0, c: 0 };
      d.n += 1; d.t += tokensOf(p); d.c += p.costCents || 0;
      daily.set(k, d);
    }
    for (const [k, d] of [...daily.entries()].sort()) { const [day, who] = k.split('|'); L.push([day, who, d.n, d.t, (d.c / 100).toFixed(4)].map(q).join(',')); }
    downloadText(L.join('\n'), `cursor-usage-report-${dayKey(from)}.csv`);
  };

  // ---- derived numbers for the tiles / notes ----
  const total = priced.reduce((s, p) => s + p.costCents, 0);
  const tokens = scoped.reduce((s, p) => s + tokensOf(p), 0);
  const cacheRead = scoped.reduce((s, p) => s + (p.tokens?.cacheRead || 0), 0);
  const activeDays = new Set(scoped.map((p) => dayKey(new Date(p.promptedAt).getTime()))).size;
  const top = priced.slice().sort((a, b) => b.costCents - a.costCents)[0];
  const anyPartial = priced.some((p) => !p.costKnown);
  const peopleRows = summarize(all, unmatched);
  const totalTok = peopleRows.reduce((s, r) => s + r.tokens, 0);
  const sharedN = peopleRows.reduce((s, r) => s + r.shared, 0);
  const upload = data?.latestUpload;
  const waiting = all.filter((p) => p.usageStatus === 'pending').length;
  const unassignedTokens = unmatched.reduce((s, e) => s + e.tokens.total, 0);
  const unassignedCost = unmatched.reduce((s, e) => s + (e.costCents || 0), 0);
  const devices = useMemo(() => {
    const m = new Map();
    for (const p of all) {
      if (!p.deviceName) continue;
      const d = m.get(p.deviceName) || { name: p.deviceName, person: personOf(p), last: 0, account: p.cursorAccountEmail };
      d.last = Math.max(d.last, new Date(p.promptedAt).getTime());
      m.set(p.deviceName, d);
    }
    return [...m.values()];
  }, [all]);

  return (
    <div className="cut">
      <div className="cut-header">
        <div>
          <h1>Cursor credit burn</h1>
          <div className="cut-sub">
            {data?.lastIngestAt ? `Last data received ${fmtTime(data.lastIngestAt)}` : 'No data received yet. Connect a computer under People & devices.'}
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
              {people.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          )}
          {accounts.length > 1 && (
            <select className="cut-btn" value={accountEmail} onChange={(e) => { setAccountEmail(e.target.value); changePerson(''); }} aria-label="Cursor login">
              <option value="">All Cursor logins</option>
              {accounts.map((a) => <option key={a.email} value={a.email}>{a.email}</option>)}
            </select>
          )}
          <button type="button" className="cut-btn" onClick={() => fileRef.current?.click()} disabled={uploading} title="cursor.com → Dashboard → Usage → Export CSV">
            {uploading ? 'Uploading…' : 'Upload Cursor CSV'}
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={handleUpload} />
          <button type="button" className="cut-btn" onClick={load}>Refresh</button>
          <button type="button" className="cut-btn" onClick={exportCsv}>Export CSV</button>
          <button type="button" className={`cut-btn ${showDevices ? 'on' : ''}`} onClick={() => setShowDevices((v) => !v)}>People &amp; devices</button>
        </div>
      </div>

      {showDevices && <CursorDevicesPanel />}

      {uploadNote && <div className={`cut-note ${uploadNote.error ? 'error' : ''}`}>{uploadNote.text}</div>}
      {error && <div className="cut-note error">{error}</div>}
      {!upload && (
        <div className="cut-note">
          Tokens and cost come from Cursor's usage file. On cursor.com go to <b>Dashboard → Usage → Export CSV</b>, then click <b>Upload Cursor CSV</b> here. Prompts without a matching usage row show “—”.
        </div>
      )}
      {upload && (
        <div className="cut-note">
          Last Cursor CSV: {upload.rowCount.toLocaleString()} requests from {fmtTime(upload.rangeStart)} to {fmtTime(upload.rangeEnd)}, uploaded {fmtTime(upload.createdAt)}.
          {waiting ? ` ${waiting} prompt${waiting === 1 ? ' is' : 's are'} newer than the uploaded usage. Upload a fresh export to fill in their tokens.` : ''}
        </div>
      )}
      {unmatched.length > 0 && (
        <div className="cut-note">
          {fmtN(unassignedTokens)} tokens{unassignedCost > 0 ? ` (${fmtUSD(unassignedCost)})` : ''} in this period ran when no one had a prompt running (e.g. Tab, background agents, or a computer without the extension). They're listed as “Unassigned” under By person.
        </div>
      )}

      <div className="cut-tiles">
        <div className="cut-tile">
          <div className="k">Credit burned</div>
          <div className="v mono">{priced.length ? fmtUSD(total) : '—'}</div>
          <div className="h">{priced.length ? (anyPartial ? 'some requests reported as Included' : 'as reported by Cursor') : 'waiting for Cursor CSV'}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Prompts</div>
          <div className="v mono">{scoped.length.toLocaleString()}</div>
          <div className="h">{activeDays ? `across ${activeDays} active day${activeDays > 1 ? 's' : ''}` : ''}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Average per prompt</div>
          <div className="v mono">{priced.length ? fmtUSD(total / priced.length) : '—'}</div>
          <div className="h">{top ? `most expensive: ${fmtUSD(top.costCents)}` : 'mean cost'}</div>
        </div>
        <div className="cut-tile">
          <div className="k">Tokens</div>
          <div className="v mono">{tokens ? fmtN(tokens) : '—'}</div>
          <div className="h">{cacheRead ? `${Math.round((cacheRead / Math.max(tokens, 1)) * 100)}% cache reads` : 'input + output'}</div>
        </div>
      </div>

      <div className="cut-card spaced">
        <div className="cut-tablebar">
          <div>
            <h2>By person</h2>
            <div className="cut-sub" style={{ margin: 0 }}>
              {totalTok ? `${fmtN(totalTok)} tokens used on the account in this period. Click a name to filter.` : 'Who used how much in this period. Click a name to filter.'}
            </div>
          </div>
          <button type="button" className="cut-btn" onClick={downloadReport}>Download report</button>
        </div>
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr><th>Person</th><th className="num">Prompts</th><th className="num">Tokens</th><th style={{ width: '28%' }}>Share of tokens</th><th className="num">Credit burned</th><th>Last active</th></tr>
            </thead>
            <tbody>
              {peopleRows.length ? peopleRows.map((r) => {
                const pct = totalTok ? (r.tokens / totalTok) * 100 : 0;
                return (
                  <tr
                    key={r.person}
                    className={`${r.unassigned ? 'unassigned' : 'prow'} ${activePerson && activePerson !== r.person ? 'dim' : ''}`}
                    onClick={r.unassigned ? undefined : () => changePerson(activePerson === r.person ? '' : r.person)}
                  >
                    <td><b>{r.person}</b></td>
                    <td className="num mono">{r.unassigned ? '—' : r.prompts.toLocaleString()}</td>
                    <td className="num mono">{totalTok ? fmtN(r.tokens) : '—'}</td>
                    <td>
                      <div className="cut-model-row" style={{ margin: '3px 0 0' }}>
                        <div className="cut-track"><div className="cut-fill" style={{ width: `${pct.toFixed(1)}%` }} /></div>
                        <div className="meta">
                          {totalTok ? `${Math.round(pct)}% · ${fmtN(r.tokens)} of ${fmtN(totalTok)}` : 'waiting for Cursor CSV'}
                          {r.pending && totalTok ? ` · ${r.pending} waiting for CSV` : ''}
                        </div>
                      </div>
                    </td>
                    <td className="num mono">{totalTok ? fmtUSD(r.cents) : '—'}</td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{r.last ? fmtTime(r.last) : '—'}</td>
                  </tr>
                );
              }) : <tr><td colSpan={6} className="cut-empty">No data</td></tr>}
            </tbody>
          </table>
        </div>
        {sharedN > 0 && (
          <div className="cut-sub" style={{ margin: '10px 0 0' }}>
            {sharedN} prompt{sharedN === 1 ? '' : 's'} ran while someone else on the same Cursor login was using the same model; Cursor doesn't say which computer made each request, so those requests were split by each person's agent steps (marked “split”).
          </div>
        )}
      </div>

      <div className="cut-grid2">
        <div className="cut-card">
          <h2>Daily burn</h2>
          <div className="cut-sub">Cost of all prompts per day (USD)</div>
          <DailyChart prompts={scoped} range={range} />
        </div>
        <div className="cut-card">
          <h2>By model</h2>
          <div className="cut-sub">Share of credit burned</div>
          <ByModel priced={priced} />
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
                <th className="sortable" onClick={() => sortBy('text')}>Prompt{arrow('text')}</th>
                <th className="sortable" onClick={() => sortBy('model')}>Model{arrow('model')}</th>
                <th className="sortable num" onClick={() => sortBy('requests')}>Requests{arrow('requests')}</th>
                <th className="sortable num" onClick={() => sortBy('tokens')}>Tokens{arrow('tokens')}</th>
                <th className="sortable num" onClick={() => sortBy('cents')}>Cost{arrow('cents')}</th>
              </tr>
            </thead>
            <tbody>
              {slice.length ? slice.flatMap((p) => {
                const isOpen = open.has(p.id);
                const text = p.text || '(prompt text not sent)';
                const rows = [(
                  <tr key={p.id} className="row" onClick={() => toggleRow(p)}>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(p.promptedAt)}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{personOf(p)}</td>
                    <td>
                      <div className="cut-ptext">{text}</div>
                      {p.conversationName && <div className="cut-conv">{p.conversationName}{p.mode ? ` · ${p.mode}` : ''}</div>}
                    </td>
                    <td>{modelsOf(p).length ? modelsOf(p).map((m) => <span key={m} className="cut-chip">{m}</span>) : <span className="cut-conv">—</span>}</td>
                    <td className="num mono">{p.requests || '—'}</td>
                    <td className="num mono">{p.tokens ? fmtN(p.tokens.total) : '—'}</td>
                    <td className="num mono">
                      {p.tokens ? fmtUSD(p.costCents) : '—'}
                      {p.tokens && !p.costKnown && <span className="cut-est" title="Cursor reported part of this as Included, without an amount">incl.</span>}
                      {p.shared && <span className="cut-est" title="Someone else on this login was using the same model at the same moment; split by agent steps">split</span>}
                    </td>
                  </tr>
                )];
                if (isOpen) {
                  const full = fullText[p.id];
                  rows.push(
                    <tr key={`${p.id}-detail`} className="detail">
                      <td colSpan={7}>
                        <div className="cut-full">
                          {p.textTruncated ? (full === undefined ? `${text}\n… loading full prompt` : full === null ? `${text}\n… (couldn't load the full prompt)` : full) : text}
                        </div>
                        <div className="cut-kv">
                          {p.tokens ? (
                            <>
                              <span>Input <b className="mono">{p.tokens.input.toLocaleString()}</b></span>
                              <span>Output <b className="mono">{p.tokens.output.toLocaleString()}</b></span>
                              <span>Cache read <b className="mono">{p.tokens.cacheRead.toLocaleString()}</b></span>
                              <span>Cache write <b className="mono">{p.tokens.cacheWrite.toLocaleString()}</b></span>
                            </>
                          ) : <span><b>Waiting for Cursor CSV</b> — tokens and cost appear after the next upload covering this time</span>}
                          <span>Cursor requests <b className="mono">{p.requests || 0}</b></span>
                          <span>Agent steps <b className="mono">{p.steps}</b></span>
                          <span>Cost source <b>{p.tokens ? 'Cursor usage CSV' : '—'}</b></span>
                          {p.deviceName && <span>Computer <b>{p.deviceName}</b></span>}
                          {p.cursorAccountEmail && <span>Cursor login <b>{p.cursorAccountEmail}</b></span>}
                          {p.shared && <span><b>Split:</b> another person was using the same model at the same time</span>}
                        </div>
                      </td>
                    </tr>,
                  );
                }
                return rows;
              }) : <tr><td colSpan={7} className="cut-empty">{loading && !data ? 'Loading…' : 'No prompts match.'}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="cut-pager">
          <span>{view.length.toLocaleString()} prompts · page {safePage + 1} of {pages}</span>
          <button type="button" className="cut-btn" disabled={safePage === 0} onClick={() => setPage(safePage - 1)}>Previous</button>
          <button type="button" className="cut-btn" disabled={safePage >= pages - 1} onClick={() => setPage(safePage + 1)}>Next</button>
        </div>
      </div>

      <div className="cut-footer">
        {devices.map((d) => `${d.name} (${d.person}${d.account ? `, ${d.account}` : ''}) · last prompt ${fmtTime(d.last)}`).join('  ·  ')}
      </div>
    </div>
  );
}
