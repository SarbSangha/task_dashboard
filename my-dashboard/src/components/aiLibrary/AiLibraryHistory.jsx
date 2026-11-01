import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { aiLibraryAPI } from '../../services/aiLibrary';
import { downloadBlobResponse } from '../../services/reports';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import DateRangePicker from '../reports/DateRangePicker';
import { DATE_PRESETS, computePresetDates, formatRange } from '../reports/dateRanges';
import FilterPopover from '../leftsidebar/compofleftsidebar/trending/FilterPopover';
import { formatDateTimeIndia, toIndiaISODate } from '../../utils/dateTime';
import { formatShortDateTime } from '../../utils/taskPresentation';
import { formatBytes } from './aiLibraryFormat';

/*
 * AI Library upload history: summary strip, one-row toolbar (date range,
 * search, Filters popover, totals + chips, sort, Excel export) and the table.
 * Filters map 1:1 onto backend HistoryFilters (routers/ai_library_router.py),
 * shared by the list, the counts and the Excel export.
 */

const PAGE_SIZE = 25;

const EMPTY_FILTERS = Object.freeze({
  datePreset: 'all', dateFrom: '', dateTo: '', clientId: '', userId: '', status: '', kind: '', minMb: '', maxMb: '', search: '',
});

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'largest', label: 'Largest first' },
  { value: 'smallest', label: 'Smallest first' },
  { value: 'name', label: 'File name A–Z' },
];

const STATUS_LABELS = { complete: 'Uploaded', pending: 'Incomplete', failed: 'Failed' };
const DATE_LABELS = Object.fromEntries(DATE_PRESETS.map((preset) => [preset.key, preset.label]));

const KIND_ICONS = {
  video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5L5 20" /></>,
  audio: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  document: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
  archive: <><rect x="3" y="4" width="18" height="5" rx="1" /><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4" /></>,
  other: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5" /></>,
};

const resolveDates = (f) => {
  if (!f.datePreset || f.datePreset === 'all') return { from: null, to: null };
  if (f.datePreset === 'custom') return { from: f.dateFrom || null, to: f.dateTo || null };
  const { start, end } = computePresetDates(f.datePreset);
  return { from: start, to: end };
};

const datePatch = (range, key) => (
  key === 'custom' ? { datePreset: 'custom', dateFrom: range.start, dateTo: range.end } : { datePreset: key, dateFrom: '', dateTo: '' }
);

/** Backend params for list / export. */
function toParams(f, search) {
  const { from, to } = resolveDates(f);
  return {
    start: from || undefined,
    end: to || undefined,
    clientId: f.clientId || undefined,
    userId: f.userId || undefined,
    status: f.status || undefined,
    kind: f.kind || undefined,
    minMb: f.minMb === '' ? undefined : f.minMb,
    maxMb: f.maxMb === '' ? undefined : f.maxMb,
    q: (search ?? f.search)?.trim() || undefined,
  };
}

const invalidReason = (f) => {
  const { from, to } = resolveDates(f);
  if (from && to && from > to) return '"From" date must be on or before the "To" date.';
  if (f.minMb !== '' && f.maxMb !== '' && Number(f.minMb) > Number(f.maxMb)) return 'Minimum size is above the maximum size.';
  return '';
};

function describe(f, options) {
  const chips = [];
  const label = (list, id) => list.find((item) => String(item.id ?? item.value) === String(id))?.name
    ?? list.find((item) => String(item.id ?? item.value) === String(id))?.label ?? id;
  if (f.datePreset && f.datePreset !== 'all') {
    const { from, to } = resolveDates(f);
    chips.push({ key: 'date', label: f.datePreset === 'custom' ? formatRange(from, to) : DATE_LABELS[f.datePreset], reset: { datePreset: 'all', dateFrom: '', dateTo: '' } });
  }
  if (f.clientId) chips.push({ key: 'client', label: `Client: ${label(options.clients, f.clientId)}`, reset: { clientId: '' } });
  if (f.userId) chips.push({ key: 'user', label: `By: ${label(options.users, f.userId)}`, reset: { userId: '' } });
  if (f.status) chips.push({ key: 'status', label: STATUS_LABELS[f.status], reset: { status: '' } });
  if (f.kind) chips.push({ key: 'kind', label: label(options.kinds, f.kind), reset: { kind: '' } });
  if (f.minMb !== '' || f.maxMb !== '') chips.push({ key: 'size', label: `Size ${f.minMb || 0}–${f.maxMb || '∞'} MB`, reset: { minMb: '', maxMb: '' } });
  if (f.search.trim()) chips.push({ key: 'search', label: `“${f.search.trim()}”`, reset: { search: '' } });
  return chips;
}

const withCount = (text, count) => (Number.isFinite(count) ? `${text} · ${count.toLocaleString()}` : text);

/** Client / uploader / status / type / size controls (popover + export). */
function FilterFields({ value, onChange, options, canManage }) {
  const set = (key) => (event) => onChange({ [key]: event.target.value });
  return (
    <div className="ail-fields">
      <label className="ail-field">
        <span>Client</span>
        <select value={value.clientId} onChange={set('clientId')}>
          <option value="">All clients</option>
          {options.clients.map((c) => <option key={c.id} value={c.id}>{withCount(c.name, c.count)}</option>)}
        </select>
      </label>
      {canManage && (
        <label className="ail-field">
          <span>Uploaded by</span>
          <select value={value.userId} onChange={set('userId')}>
            <option value="">Everyone</option>
            {options.users.map((u) => <option key={u.id} value={u.id}>{withCount(u.name, u.count)}</option>)}
          </select>
        </label>
      )}
      <label className="ail-field">
        <span>File type</span>
        <select value={value.kind} onChange={set('kind')}>
          <option value="">All types</option>
          {options.kinds.map((k) => <option key={k.value} value={k.value}>{withCount(k.label, k.count)}</option>)}
        </select>
      </label>
      <label className="ail-field">
        <span>Status</span>
        <select value={value.status} onChange={set('status')}>
          <option value="">Any</option>
          {['complete', 'pending', 'failed'].map((key) => {
            const hit = options.statuses.find((s) => s.value === key);
            return <option key={key} value={key}>{withCount(STATUS_LABELS[key], hit?.count ?? 0)}</option>;
          })}
        </select>
      </label>
      <div className="ail-field">
        <span>Size (MB)</span>
        <div className="ail-pair">
          <input type="number" min="0" placeholder="Min" value={value.minMb} onChange={set('minMb')} aria-label="Minimum size in MB" />
          <input type="number" min="0" placeholder={options.largestMb ? `Max ${Math.ceil(options.largestMb)}` : 'Max'} value={value.maxMb} onChange={set('maxMb')} aria-label="Maximum size in MB" />
        </div>
      </div>
    </div>
  );
}

const readBlobError = async (error) => {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try { const parsed = JSON.parse(await data.text()); if (typeof parsed?.detail === 'string') return parsed.detail; } catch { /* not JSON */ }
  }
  return 'Could not build the export. Try again.';
};

/** "Export to Excel" with its own filters, starting from the history's. */
function ExportButton({ initial, options, canManage }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState(initial);
  const [count, setCount] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const wrapRef = useRef(null);
  const invalid = invalidReason(f);
  const paramsKey = JSON.stringify(toParams(f));

  useEffect(() => { if (open) { setF(initial); setError(''); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    const inPicker = (target) => Boolean(target?.closest?.('.drp-pop'));
    const onDown = (event) => { if (!wrapRef.current?.contains(event.target) && !inPicker(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape' && !busy && !document.querySelector('.drp-pop')) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, busy]);

  useEffect(() => {
    if (!open || invalid) { setCount(null); return undefined; }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const res = await aiLibraryAPI.list({ ...toParams(f), page: 1, pageSize: 1 });
        if (!cancelled) setCount(res?.summary || { count: res?.total ?? 0, totalBytes: 0 });
      } catch { if (!cancelled) setCount(null); }
    }, 250);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [open, paramsKey, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError('');
    try {
      const res = await aiLibraryAPI.exportUploads(toParams(f));
      downloadBlobResponse(res, `ai-library_uploads_${toIndiaISODate(new Date())}.xlsx`);
      setOpen(false);
    } catch (err) {
      setError(await readBlobError(err));
    } finally {
      setBusy(false);
    }
  };

  const { from, to } = resolveDates(f);
  return (
    <div className="ail-export" ref={wrapRef}>
      <button type="button" className={`ail-export-btn${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13l2.5 3L9 19M15 13l-2.5 3 2.5 3" />
        </svg>
        {busy ? 'Preparing…' : 'Export to Excel'}
      </button>
      {open && (
        <div className="ail-export-pop" role="dialog" aria-label="Export upload history to Excel">
          <header className="ail-export-head">
            <strong>Export upload history</strong>
            <span>Summary (by client, uploader, month, type, status) + every upload with its Drive link</span>
          </header>
          <div className="ail-export-body">
            <div className="ail-field">
              <span>Date range</span>
              <DateRangePicker block allowAll portal align="right" ariaLabel="Export date range"
                start={from || ''} end={to || ''} presetKey={f.datePreset}
                onChange={(range, key) => setF((prev) => ({ ...prev, ...datePatch(range, key) }))} />
            </div>
            <FilterFields value={f} onChange={(patch) => setF((prev) => ({ ...prev, ...patch }))} options={options} canManage={canManage} />
            <label className="ail-field">
              <span>File name contains</span>
              <input type="search" placeholder="Any file" value={f.search} onChange={(e) => setF((prev) => ({ ...prev, search: e.target.value }))} />
            </label>
            {error && <div className="ail-export-error" role="alert">{error}</div>}
          </div>
          <footer className="ail-export-foot">
            <span className={invalid ? 'is-invalid' : ''}>
              {invalid || (count
                ? (count.count ? <><strong>{count.count.toLocaleString()}</strong> uploads · <strong>{formatBytes(count.totalBytes)}</strong></> : 'Nothing matches these filters')
                : 'Counting…')}
            </span>
            <div className="ail-export-actions">
              <button type="button" className="ail-link-btn" onClick={() => setF(EMPTY_FILTERS)}>Clear</button>
              <button type="button" className="ail-export-go" onClick={download} disabled={busy || !!invalid || count?.count === 0}>
                {busy ? 'Preparing…' : 'Download .xlsx'}
              </button>
            </div>
          </footer>
        </div>
      )}
    </div>
  );
}

export default function AiLibraryHistory({ isOpen, refreshKey, canManage }) {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const search = useDebouncedValue(filters.search, 400);
  const [sort, setSort] = useState('newest');
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState({ items: [], total: 0, summary: null });
  const [options, setOptions] = useState({ clients: [], users: [], kinds: [], statuses: [], largestMb: 0, summary: null });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  const invalid = invalidReason(filters);
  const params = useMemo(() => toParams(filters, search), [filters, search]);
  const paramsKey = JSON.stringify(params);

  const load = useCallback(async () => {
    if (invalid) return;
    const id = ++requestRef.current;
    setLoading(true);
    try {
      const [list, opts] = await Promise.all([
        aiLibraryAPI.list({ ...params, sort, page, pageSize: PAGE_SIZE }),
        aiLibraryAPI.options(),
      ]);
      if (requestRef.current !== id) return;
      setHistory({ items: list.items || [], total: list.total || 0, summary: list.summary || null });
      setOptions({
        clients: opts.clients || [], users: opts.users || [], kinds: opts.kinds || [], statuses: opts.statuses || [],
        largestMb: opts.largestMb || 0, summary: opts.summary || null,
      });
      setError('');
    } catch (err) {
      if (requestRef.current === id) setError(err?.response?.data?.detail || 'Could not load upload history.');
    } finally {
      if (requestRef.current === id) setLoading(false);
    }
  }, [paramsKey, sort, page, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (isOpen) load(); }, [isOpen, load, refreshKey]);

  const update = (patch) => { setPage(1); setFilters((prev) => ({ ...prev, ...patch })); };
  const chips = describe(filters, options);
  const popoverActive = chips.filter((c) => c.key !== 'date' && c.key !== 'search').length;
  const totalPages = Math.max(1, Math.ceil(history.total / PAGE_SIZE));
  const { from, to } = resolveDates(filters);
  const s = history.summary;
  const all = options.summary;

  return (
    <section className="ail-history">
      <div className="ail-history-head">
        <h3>Upload history{!canManage && ' (yours)'}</h3>
        <ExportButton initial={filters} options={options} canManage={canManage} />
      </div>

      {all && (
        <div className="ail-kpis">
          <div className="ail-kpi"><span>Uploads</span><strong>{(s?.count ?? 0).toLocaleString()}</strong>{chips.length > 0 && <em>of {all.count.toLocaleString()}</em>}</div>
          <div className="ail-kpi"><span>Total size</span><strong>{formatBytes(s?.totalBytes)}</strong>{chips.length > 0 && <em>of {formatBytes(all.totalBytes)}</em>}</div>
          <div className="ail-kpi"><span>Clients</span><strong>{s?.clients ?? 0}</strong></div>
          {canManage && <div className="ail-kpi"><span>Uploaders</span><strong>{s?.uploaders ?? 0}</strong></div>}
        </div>
      )}

      <div className="ail-toolbar">
        <div className="ail-toolbar-date">
          <DateRangePicker block allowAll portal align="left" ariaLabel="Date range"
            start={from || ''} end={to || ''} presetKey={filters.datePreset}
            onChange={(range, key) => update(datePatch(range, key))} />
        </div>
        <input
          type="search"
          className="ail-toolbar-search"
          placeholder="Search file names…"
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
          aria-label="Search file names"
        />
        <FilterPopover
          activeCount={popoverActive}
          onClear={() => update({ clientId: '', userId: '', status: '', kind: '', minMb: '', maxMb: '' })}
        >
          <section className="fpop-section">
            <h6 className="fpop-section-title">Uploads</h6>
            <FilterFields value={filters} onChange={update} options={options} canManage={canManage} />
          </section>
        </FilterPopover>
        <label className="ail-sort">
          <span>Sort</span>
          <select value={sort} onChange={(e) => { setPage(1); setSort(e.target.value); }} aria-label="Sort uploads">
            {SORTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
        <button type="button" className="ail-icon-btn" onClick={load} disabled={loading} aria-label="Refresh" title="Refresh">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={loading ? 'is-spinning' : ''}>
            <path d="M21 12a9 9 0 1 1-2.64-6.36M21 4v5h-5" />
          </svg>
        </button>
      </div>

      {(chips.length > 0 || invalid) && (
        <div className="ail-chips">
          {invalid && <span className="ail-invalid">{invalid}</span>}
          {chips.map((chip) => (
            <span key={chip.key} className="ail-chip">
              {chip.label}
              <button type="button" onClick={() => update(chip.reset)} aria-label={`Remove filter ${chip.label}`}>×</button>
            </span>
          ))}
          {chips.length > 0 && <button type="button" className="ail-link-btn" onClick={() => { setPage(1); setFilters(EMPTY_FILTERS); }}>Clear all</button>}
        </div>
      )}

      {error && <div className="trp-error" role="alert">{error}</div>}

      {history.items.length === 0 ? (
        <div className="ail-empty">
          {loading ? 'Loading…' : chips.length ? 'No uploads match these filters.' : 'No uploads yet.'}
        </div>
      ) : (
        <div className="ail-table-wrap">
          <table className="ail-table">
            <thead>
              <tr>
                <th>File</th>
                <th>Client</th>
                {canManage && <th>Uploaded by</th>}
                <th className="num">Size</th>
                <th>Uploaded</th>
                <th>Status</th>
                <th aria-label="Drive link" />
              </tr>
            </thead>
            <tbody>
              {history.items.map((row) => (
                <tr key={row.id}>
                  <td>
                    <div className="ail-file">
                      <span className={`ail-file-icon ail-file-icon--${row.fileKind || 'other'}`} aria-hidden="true">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                          {KIND_ICONS[row.fileKind] || KIND_ICONS.other}
                        </svg>
                      </span>
                      <div className="ail-file-text">
                        <span className="ail-file-name" title={row.fileName}>{row.fileName}</span>
                        {row.folderPath && <span className="ail-file-path" title={row.folderPath}>{row.folderPath}</span>}
                      </div>
                    </div>
                  </td>
                  <td>{row.clientName || '—'}</td>
                  {canManage && <td>{row.userName || '—'}</td>}
                  <td className="num">{formatBytes(row.sizeBytes)}</td>
                  <td title={formatDateTimeIndia(row.completedAt || row.createdAt)}>{formatShortDateTime(row.completedAt || row.createdAt) || '—'}</td>
                  <td>
                    <span className={`ail-pill ail-pill--${row.status}`} title={row.error || undefined}>
                      {STATUS_LABELS[row.status] || row.status}
                    </span>
                  </td>
                  <td className="ail-open-cell">
                    {row.driveLink && <a className="ail-open-link" href={row.driveLink} target="_blank" rel="noreferrer">Open in Drive</a>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {history.total > PAGE_SIZE && (
        <div className="ail-pager">
          <button type="button" className="ail-secondary-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span>Page {page} of {totalPages} · {history.total.toLocaleString()} uploads</span>
          <button type="button" className="ail-secondary-btn" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </section>
  );
}
