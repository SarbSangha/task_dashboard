import { useEffect, useMemo, useState } from 'react';
import { rmwDataExportAPI } from '../../../../services/api';
import DateRangePicker from '../../../reports/DateRangePicker';
import { formatRange } from '../../../reports/dateRanges';
import { EMPTY_COMMON, loadToolOptions, resolveDates, usable, withCount } from './toolFilters';

/*
 * Filters for one tool's Excel export (every tool except Kling, which has its
 * own KlingExportOptions). The filters themselves come from the server
 * (GET /api/rmw-data/export/<tool>/options), chosen per tool from what its
 * data records, so this component only lays them out:
 *   Date range · People & attribution · Sheets (each with its own filters).
 * Reports { params, invalid, preview } through onChange for the popover footer.
 */

function SelectField({ label, value, onChange, anyLabel, options }) {
  return (
    <div className="kff-field">
      <span className="kff-label">{label}</span>
      <select className="kff-select" value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{withCount(option.label, option.count)}</option>
        ))}
      </select>
    </div>
  );
}

export default function ToolExportOptions({ tool, searchText = '', initial = null, onChange }) {
  const [options, setOptions] = useState(null);
  const [loadError, setLoadError] = useState('');
  // Start from the tab's Records filters (ToolRecordsTab), when there are any.
  const tabCommon = initial?.common || EMPTY_COMMON;
  const tabPerSheet = initial?.perSheet || {};
  const [common, setCommon] = useState(tabCommon);
  const [perSheet, setPerSheet] = useState(tabPerSheet);
  const [excluded, setExcluded] = useState(() => new Set());
  const [openSheet, setOpenSheet] = useState(initial?.sheetKey || null);
  const [useSearch, setUseSearch] = useState(true);
  const [preview, setPreview] = useState({ state: 'loading', sheets: {} });

  useEffect(() => {
    let cancelled = false;
    loadToolOptions(tool.key)
      .then((res) => {
        if (cancelled) return;
        setOptions(res);
        // Open the first sheet that has its own filters.
        setOpenSheet((current) => current ?? (res?.sheets || []).find((sheet) => sheet.filters.length)?.key ?? null);
      })
      .catch(() => { if (!cancelled) setLoadError('Could not load the filters for this tool.'); });
    return () => { cancelled = true; };
  }, [tool.key]);

  const sheets = useMemo(() => options?.sheets || [], [options]);
  const c = options?.common || {};
  const { from, to } = resolveDates(common);

  const invalid = useMemo(() => {
    if (from && to && from > to) return 'The start date is after the end date.';
    if (sheets.length && sheets.every((sheet) => excluded.has(sheet.key))) return 'Pick at least one sheet.';
    for (const sheet of sheets) {
      const values = perSheet[sheet.key] || {};
      for (const fd of sheet.filters) {
        if (fd.kind !== 'range') continue;
        const low = values[`${fd.key}_min`];
        const high = values[`${fd.key}_max`];
        if (low !== undefined && low !== '' && high !== undefined && high !== '' && Number(low) > Number(high)) {
          return `${sheet.title} · ${fd.label}: minimum is above maximum.`;
        }
      }
    }
    return '';
  }, [from, to, sheets, excluded, perSheet]);

  const params = useMemo(() => {
    const out = {};
    if (from) out.date_from = from;
    if (to) out.date_to = to;
    if (common.ownerUserId) out.owner_user_id = common.ownerUserId;
    if (common.department) out.department = common.department;
    if (common.linked) out.linked = common.linked;
    if (common.client) out.client = common.client;
    if (common.ownership) out.ownership = common.ownership;
    if (useSearch && searchText) out.q = searchText;
    if (excluded.size) out.sheets = sheets.filter((sheet) => !excluded.has(sheet.key)).map((sheet) => sheet.key).join(',');
    Object.entries(perSheet).forEach(([sheetKey, values]) => {
      Object.entries(values).forEach(([key, value]) => {
        if (value !== '' && value !== undefined && value !== null) out[`${sheetKey}.${key}`] = value;
      });
    });
    return out;
  }, [from, to, common, useSearch, searchText, excluded, sheets, perSheet]);
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    if (!options) return undefined;
    if (invalid) {
      setPreview({ state: 'invalid', sheets: {} });
      onChange({ params, invalid, preview: null });
      return undefined;
    }
    let cancelled = false;
    setPreview((prev) => ({ ...prev, state: 'loading' }));
    onChange({ params, invalid: '', preview: null });
    const timer = window.setTimeout(async () => {
      try {
        const res = await rmwDataExportAPI.preview(tool.key, params);
        if (cancelled) return;
        const bySheet = Object.fromEntries((res?.sheets || []).map((sheet) => [sheet.key, sheet]));
        setPreview({ state: 'ready', sheets: bySheet });
        const credits = (res?.sheets || []).reduce((sum, sheet) => sum + (sheet.credits || 0), 0);
        const hasCredits = (res?.sheets || []).some((sheet) => sheet.credits != null);
        onChange({ params, invalid: '', preview: { total: res?.total ?? 0, credits: hasCredits ? credits : null } });
      } catch {
        if (!cancelled) {
          setPreview({ state: 'error', sheets: {} });
          onChange({ params, invalid: '', preview: null });
        }
      }
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // paramsKey captures every input of `params`.
  }, [options, paramsKey, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loadError) return <div className="rmw-export-error rmw-export-error--box">{loadError}</div>;
  if (!options) return <div className="texp-loading">Loading filters…</div>;

  const setSheetValue = (sheetKey, patch) =>
    setPerSheet((prev) => ({ ...prev, [sheetKey]: { ...(prev[sheetKey] || {}), ...patch } }));
  const sheetActiveCount = (sheet) =>
    Object.values(perSheet[sheet.key] || {}).filter((value) => value !== '' && value !== undefined).length;
  const commonActive = ['ownerUserId', 'department', 'linked', 'client', 'ownership'].filter((key) => common[key]).length
    + (common.datePreset !== 'all' ? 1 : 0);
  const totalActive = commonActive + sheets.reduce((sum, sheet) => sum + sheetActiveCount(sheet), 0) + excluded.size;
  // Same rule as the tab: show the standard filters wherever the tool records them.
  const has = (list) => Array.isArray(list) && list.length > 0;
  const showPeople = has(c.owners) || has(c.departments) || has(c.clients) || Array.isArray(c.linked) || has(c.ownership);
  const dataRange = options.dateRange?.from ? formatRange(options.dateRange.from, options.dateRange.to) : null;

  const differsFromTab = Boolean(initial)
    && JSON.stringify({ common, perSheet }) !== JSON.stringify({ common: tabCommon, perSheet: tabPerSheet });

  const clearAll = () => {
    setCommon(EMPTY_COMMON);
    setPerSheet({});
    setExcluded(new Set());
  };

  return (
    <div className="texp">
      <div className="kexp-bar">
        <span className="kexp-bar-text">
          {totalActive ? `${totalActive} filter${totalActive === 1 ? '' : 's'} applied` : 'No filters: everything'}
        </span>
        <div className="kexp-bar-actions">
          {differsFromTab && (
            <button type="button" className="kexp-link" onClick={() => { setCommon(tabCommon); setPerSheet(tabPerSheet); }}>
              Use tab filters
            </button>
          )}
          {totalActive > 0 && <button type="button" className="kexp-link" onClick={clearAll}>Clear all</button>}
        </div>
      </div>

      <section className="kff-group">
        <h6 className="kff-group-title">Date range</h6>
        <DateRangePicker
          block
          allowAll
          portal
          ariaLabel="Export date range"
          start={from || ''}
          end={to || ''}
          presetKey={common.datePreset}
          onChange={(range, key) => setCommon((prev) => (
            key === 'custom'
              ? { ...prev, datePreset: 'custom', dateFrom: range.start, dateTo: range.end }
              : { ...prev, datePreset: key, dateFrom: '', dateTo: '' }
          ))}
        />
        {dataRange && <span className="texp-hint">Data available {dataRange}</span>}
      </section>

      {showPeople && (
        <section className="kff-group">
          <h6 className="kff-group-title">People & attribution</h6>
          <div className="kff-grid texp-grid">
            {has(c.owners) && (
              <SelectField label="Person" value={common.ownerUserId} anyLabel="Everyone" options={c.owners}
                onChange={(value) => setCommon((prev) => ({ ...prev, ownerUserId: value }))} />
            )}
            {has(c.departments) && (
              <SelectField label="Department" value={common.department} anyLabel="All departments" options={c.departments}
                onChange={(value) => setCommon((prev) => ({ ...prev, department: value }))} />
            )}
            {Array.isArray(c.linked) && (
              <SelectField label="Linked to" value={common.linked} anyLabel="Any" options={c.linked}
                onChange={(value) => setCommon((prev) => ({ ...prev, linked: value }))} />
            )}
            {has(c.clients) && (
              <SelectField label="Client" value={common.client} anyLabel="All clients" options={c.clients}
                onChange={(value) => setCommon((prev) => ({ ...prev, client: value }))} />
            )}
            {has(c.ownership) && (
              <SelectField label="Ownership" value={common.ownership} anyLabel="Any" options={c.ownership}
                onChange={(value) => setCommon((prev) => ({ ...prev, ownership: value }))} />
            )}
          </div>
        </section>
      )}

      <section className="kff-group">
        <h6 className="kff-group-title">Sheets in the workbook</h6>
        <div className="texp-sheets">
          {sheets.map((sheet) => {
            const included = !excluded.has(sheet.key);
            const result = preview.sheets[sheet.key];
            const active = sheetActiveCount(sheet);
            const isOpen = openSheet === sheet.key && included;
            const usableFilters = sheet.filters.filter((fd) => fd.kind === 'range' || usable(fd.options));
            return (
              <div key={sheet.key} className={`texp-sheet${included ? '' : ' is-off'}${isOpen ? ' is-open' : ''}`}>
                <div className="texp-sheet-head">
                  <label className="texp-sheet-check">
                    <input
                      type="checkbox"
                      checked={included}
                      onChange={() => setExcluded((prev) => {
                        const next = new Set(prev);
                        if (next.has(sheet.key)) next.delete(sheet.key); else next.add(sheet.key);
                        return next;
                      })}
                    />
                    <span className="texp-sheet-title">{sheet.title}</span>
                  </label>
                  <span className="texp-sheet-count">
                    {!included
                      ? 'Not included'
                      : preview.state === 'ready' && result
                        ? `${result.count.toLocaleString()} of ${sheet.count.toLocaleString()}${result.credits != null ? ` · ${Math.round(result.credits).toLocaleString()} cr` : ''}`
                        : `${sheet.count.toLocaleString()} rows`}
                  </span>
                  {included && usableFilters.length > 0 && (
                    <button
                      type="button"
                      className={`texp-sheet-toggle${active ? ' has-active' : ''}`}
                      onClick={() => setOpenSheet(isOpen ? null : sheet.key)}
                      aria-expanded={isOpen}
                    >
                      Filters{active ? ` · ${active}` : ''}
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                        {isOpen ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
                      </svg>
                    </button>
                  )}
                </div>
                {isOpen && (
                  <div className="kff-grid texp-grid texp-sheet-body">
                    {usableFilters.map((fd) => {
                      const values = perSheet[sheet.key] || {};
                      if (fd.kind === 'range') {
                        return (
                          <div key={fd.key} className="kff-field">
                            <span className="kff-label">{fd.label}</span>
                            <div className="kff-pair">
                              <input type="number" min="0" className="kff-select" placeholder={`Min ${fd.min}`}
                                value={values[`${fd.key}_min`] ?? ''} aria-label={`${fd.label} minimum`}
                                onChange={(event) => setSheetValue(sheet.key, { [`${fd.key}_min`]: event.target.value })} />
                              <input type="number" min="0" className="kff-select" placeholder={`Max ${fd.max}`}
                                value={values[`${fd.key}_max`] ?? ''} aria-label={`${fd.label} maximum`}
                                onChange={(event) => setSheetValue(sheet.key, { [`${fd.key}_max`]: event.target.value })} />
                            </div>
                          </div>
                        );
                      }
                      return (
                        <SelectField key={fd.key} label={fd.label} value={values[fd.key] ?? ''} anyLabel="Any"
                          options={fd.options} onChange={(value) => setSheetValue(sheet.key, { [fd.key]: value })} />
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {searchText && (
        <label className="rmw-export-check texp-search">
          <input type="checkbox" checked={useSearch} onChange={(event) => setUseSearch(event.target.checked)} />
          <span>Only rows matching “{searchText}”</span>
        </label>
      )}
    </div>
  );
}
