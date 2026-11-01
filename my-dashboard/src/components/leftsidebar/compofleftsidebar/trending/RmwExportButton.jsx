import { useCallback, useEffect, useRef, useState } from 'react';
import { generationRecordsAPI, rmwDataExportAPI } from '../../../../services/api';
import { downloadBlobResponse } from '../../../../services/reports';
import { toIndiaISODate } from '../../../../utils/dateTime';
import ToolLogo from '../../../common/ToolLogo';
import KlingExportOptions from './kling/KlingExportOptions';
import ToolExportOptions from './ToolExportOptions';
import './RmwExportButton.css';

// Kling's search box understands `department:Marketing`-style filters; the
// export only takes free text, so those tokens are dropped from it.
const exportableSearch = (text = '') =>
  `${text}`.replace(/\b[a-z_]+:("[^"]*"|\S+)/gi, '').replace(/\s+/g, ' ').trim();

// An error body arrives as a Blob because the request asked for one.
const readErrorDetail = async (error) => {
  const data = error?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      if (typeof parsed?.detail === 'string') return parsed.detail;
    } catch {
      /* not JSON */
    }
  }
  if (error?.code === 'ECONNABORTED') return 'The export took too long. Try a shorter date range.';
  return 'Could not build the export. Try again.';
};

const SheetIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
    <path d="M14 3v5h5M9 13l2.5 3L9 19M15 13l-2.5 3 2.5 3" />
  </svg>
);

let cachedSheets = null;

export default function RmwExportButton({ tool, searchText = '', toolFilters = null }) {
  const isKling = tool.key === 'kling';
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sheets, setSheets] = useState(cachedSheets);
  // Kling exports take the tab's full filter set (KlingExportOptions).
  const [klingExport, setKlingExport] = useState({ params: {}, invalid: '' });
  const [preview, setPreview] = useState({ state: 'idle' });
  const wrapRef = useRef(null);
  // Fit the popover between the button and the bottom of the window, so the
  // footer (count + Download) is always visible.
  const [maxHeight, setMaxHeight] = useState(null);
  useEffect(() => {
    if (!open) return undefined;
    const fit = () => {
      const rect = wrapRef.current?.getBoundingClientRect();
      if (rect) setMaxHeight(Math.max(260, Math.min(720, window.innerHeight - rect.bottom - 16)));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [open]);

  const handleKlingParams = useCallback((params, invalid) => setKlingExport({ params, invalid }), []);
  // Every other tool: server-defined filters (ToolExportOptions).
  const [toolExport, setToolExport] = useState({ params: {}, invalid: '', preview: null });
  const handleToolChange = useCallback((next) => setToolExport(next), []);
  const searchForExport = exportableSearch(searchText);

  useEffect(() => {
    if (!open) return undefined;
    // The date picker renders its calendar on <body>; clicks and Escape
    // there belong to the picker, not to this popover.
    const inPicker = (target) => Boolean(target?.closest?.('.drp-pop'));
    const onDown = (event) => {
      if (wrapRef.current?.contains(event.target) || inPicker(event.target)) return;
      setOpen(false);
    };
    const onKey = (event) => {
      if (event.key !== 'Escape' || busy) return;
      if (document.querySelector('.drp-pop')) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, busy]);

  useEffect(() => {
    if (!open || cachedSheets) return;
    rmwDataExportAPI.listTools()
      .then((res) => {
        cachedSheets = Object.fromEntries((res?.tools || []).map((t) => [t.key, t.sheets]));
        setSheets(cachedSheets);
      })
      .catch(() => {});
  }, [open]);

  useEffect(() => {
    setOpen(false);
    setError('');
  }, [tool.key]);

  // Kling: count what the export will contain, as the filters change.
  const klingKey = JSON.stringify(klingExport.params);
  useEffect(() => {
    if (!open || !isKling) return undefined;
    if (klingExport.invalid) {
      setPreview({ state: 'invalid' });
      return undefined;
    }
    let cancelled = false;
    setPreview((prev) => ({ ...prev, state: 'loading' }));
    const timer = window.setTimeout(async () => {
      try {
        const res = await generationRecordsAPI.search({ ...klingExport.params, limit: 1, offset: 0 });
        if (!cancelled) setPreview({ state: 'ready', ...(res?.summary || { count: 0, credits: 0 }) });
      } catch {
        if (!cancelled) setPreview({ state: 'error' });
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, isKling, klingKey, klingExport.invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  const blocked = isKling
    ? Boolean(klingExport.invalid) || (preview.state === 'ready' && preview.count === 0)
    : Boolean(toolExport.invalid) || toolExport.preview?.total === 0;

  const runExport = async () => {
    if (busy || blocked) return;
    setBusy(true);
    setError('');
    try {
      const params = isKling ? klingExport.params : toolExport.params;
      const res = await rmwDataExportAPI.exportTool(tool.key, params);
      // Cross-origin responses may hide Content-Disposition, so build the
      // same descriptive name the server would have sent.
      const from = params.date_from;
      const to = params.date_to;
      const rangePart = from || to ? `_${from || 'start'}_to_${to || 'today'}` : '';
      downloadBlobResponse(res, `rmw-data_${tool.key}${rangePart}_${toIndiaISODate(new Date())}.xlsx`);
      setOpen(false);
    } catch (err) {
      setError(await readErrorDetail(err));
    } finally {
      setBusy(false);
    }
  };

  const sheetNames = sheets?.[tool.key] || [];

  return (
    <div className="rmw-export" ref={wrapRef}>
      <button
        type="button"
        className={`rmw-export-btn${open ? ' is-open' : ''}`}
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={busy}
      >
        {busy ? <span className="rmw-export-spinner" aria-hidden="true" /> : <SheetIcon />}
        {busy ? 'Preparing…' : 'Export to Excel'}
      </button>

      {open && (
        <div
          className="rmw-export-pop rmw-export-pop--wide"
          style={maxHeight ? { maxHeight } : undefined}
          role="dialog" aria-label={`Export ${tool.label} data to Excel`}>
          <header className="rmw-export-head">
            <span className="rmw-export-head-icon">
              <ToolLogo name={tool.label} websiteUrl={tool.website} size={20} />
            </span>
            <div className="rmw-export-head-copy">
              <strong>Export {tool.label} to Excel</strong>
              <div className="rmw-export-sheets">
                {['Summary', ...sheetNames].map((name) => (
                  <span key={name} className="rmw-export-sheet">{name}</span>
                ))}
              </div>
            </div>
            <button type="button" className="rmw-export-close" onClick={() => setOpen(false)} aria-label="Close export">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </header>

          <div className="rmw-export-body">
            {isKling ? (
              <KlingExportOptions initial={toolFilters} onParamsChange={handleKlingParams} />
            ) : (
              <ToolExportOptions key={tool.key} tool={tool} searchText={searchForExport} initial={toolFilters} onChange={handleToolChange} />
            )}
            {error && <div className="rmw-export-error rmw-export-error--box" role="alert">{error}</div>}
          </div>

          <footer className="rmw-export-foot">
            <div
              className={`rmw-export-status rmw-export-status--${isKling ? preview.state : toolExport.invalid ? 'invalid' : 'idle'}`}
              aria-live="polite"
            >
              {isKling ? (
                <>
                  {preview.state === 'invalid' && klingExport.invalid}
                  {preview.state === 'loading' && 'Counting…'}
                  {preview.state === 'error' && 'Count unavailable'}
                  {preview.state === 'ready' && (preview.count > 0 ? (
                    <>
                      <strong>{preview.count.toLocaleString()}</strong> rows · <strong>{Math.round(preview.credits).toLocaleString()}</strong> credits
                    </>
                  ) : 'Nothing matches these filters')}
                </>
              ) : toolExport.invalid ? (
                toolExport.invalid
              ) : toolExport.preview ? (
                toolExport.preview.total > 0 ? (
                  <>
                    <strong>{toolExport.preview.total.toLocaleString()}</strong> rows
                    {toolExport.preview.credits != null && (
                      <> · <strong>{Math.round(toolExport.preview.credits).toLocaleString()}</strong> credits</>
                    )}
                  </>
                ) : 'Nothing matches these filters'
              ) : 'Counting…'}
            </div>
            <button type="button" className="rmw-export-go" onClick={runExport} disabled={busy || blocked}>
              {busy ? <span className="rmw-export-spinner rmw-export-spinner--light" aria-hidden="true" /> : <SheetIcon />}
              {busy ? 'Preparing…' : 'Download .xlsx'}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
