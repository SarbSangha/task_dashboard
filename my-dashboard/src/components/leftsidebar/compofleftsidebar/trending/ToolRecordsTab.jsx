import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { rmwDataExportAPI } from '../../../../services/api';
import DateRangePicker from '../../../reports/DateRangePicker';
import { formatShortDateTime, getAvatarHue, getInitials } from '../../../../utils/taskPresentation';
import { formatDateTimeIndia } from '../../../../utils/dateTime';
import {
  EMPTY_STATE, buildToolParams, datePatch, describeToolFilters, invalidReason, loadToolOptions, resolveDates, usable,
  withCount,
} from './toolFilters';
import { TOOL_CARDS } from './toolCardRegistry';
import FilterPopover from './FilterPopover';
import './ToolRecordsTab.css';

/*
 * Records view for a tool tab (every tool except Kling and the text-first
 * tools): a filter bar built from that tool's own data (server-defined, same
 * filters as its Excel export), a live total, and the matching records shown
 * with the tool's own cards and detail drawers (toolCardRegistry.js).
 */

const PAGE_SIZE = 48;

function Select({ label, value, onChange, anyLabel, options }) {
  return (
    <div className="kff-field">
      <span className="kff-label">{label}</span>
      <select className="kff-select" value={value ?? ''} onChange={(event) => onChange(event.target.value)} aria-label={label}>
        <option value="">{anyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>{withCount(option.label, option.count)}</option>
        ))}
      </select>
    </div>
  );
}

function RangeField({ label, min, max, low, high, onChange }) {
  return (
    <div className="kff-field">
      <span className="kff-label">{label}</span>
      <div className="kff-pair">
        <input type="number" min="0" className="kff-select" placeholder={`Min ${min}`} value={low ?? ''} aria-label={`${label} minimum`}
          onChange={(event) => onChange('min', event.target.value)} />
        <input type="number" min="0" className="kff-select" placeholder={`Max ${max}`} value={high ?? ''} aria-label={`${label} maximum`}
          onChange={(event) => onChange('max', event.target.value)} />
      </div>
    </div>
  );
}

const KIND_ICONS = {
  audio: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  video: <><rect x="3" y="5" width="14" height="14" rx="2" /><path d="m17 10 4-2v8l-4-2" /></>,
  image: <><rect x="3" y="4" width="18" height="16" rx="2" /><circle cx="9" cy="10" r="2" /><path d="m21 16-5-5L5 20" /></>,
  text: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
};

function RecordMedia({ row }) {
  const [failed, setFailed] = useState(false);
  if (!failed && row.kind === 'video' && row.mediaUrl) {
    return (
      <video
        className="trc-media"
        src={row.mediaUrl}
        poster={row.thumbnailUrl || undefined}
        preload="none"
        controls
        muted
        onError={() => setFailed(true)}
      />
    );
  }
  if (!failed && (row.thumbnailUrl || (row.kind === 'image' && row.mediaUrl))) {
    return (
      <img
        className="trc-media"
        src={row.thumbnailUrl || row.mediaUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <div className={`trc-tile trc-tile--${row.kind}`}>
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {KIND_ICONS[row.kind] || KIND_ICONS.text}
      </svg>
      {row.kind === 'text' && row.title && <p className="trc-tile-text">{row.title}</p>}
    </div>
  );
}

function RecordCard({ row, creditsLabel }) {
  const person = row.person?.name || 'Unassigned';
  const openUrl = row.mediaUrl || row.link;
  // Text-only records (prompts, stock items without a thumbnail) have nothing
  // to preview: skip the box and let the title use the space instead.
  const hasPreview = !(row.kind === 'text' && !row.thumbnailUrl);
  const credits = row.credits != null && (
    <span className="trc-credits" title={creditsLabel}>
      {Number(row.credits).toLocaleString()}{creditsLabel === 'Credits' ? ' cr' : ''}
    </span>
  );
  return (
    <article className={`trc-card${hasPreview ? '' : ' trc-card--text'}`}>
      {hasPreview && (
        <div className={`trc-preview trc-preview--${row.kind}`}>
          <RecordMedia row={row} />
          {credits}
        </div>
      )}
      {row.kind === 'audio' && row.mediaUrl && (
        <audio className="trc-audio" src={row.mediaUrl} controls preload="none" />
      )}
      <div className="trc-body">
        {!hasPreview && (
          <div className="trc-text-head">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {KIND_ICONS.text}
            </svg>
            {credits}
          </div>
        )}
        <h4 className="trc-title" title={row.title || ''}>{row.title || 'Untitled'}</h4>
        {row.facts.length > 0 && (
          <div className="trc-facts">
            {row.facts.slice(0, 3).map((fact) => (
              <span key={fact.label} className="trc-fact" title={`${fact.label}: ${fact.value}`}>{fact.value}</span>
            ))}
          </div>
        )}
        {(row.linkedTask || row.client) && (
          <div className="trc-links">
            {row.linkedTask && <span title="Linked task">Task: {row.linkedTask}</span>}
            {row.client && <span title="Client">Client: {row.client}</span>}
          </div>
        )}
      </div>
      <footer className="trc-foot">
        <span className="trc-avatar" style={{ '--hue': getAvatarHue(person) }} aria-hidden="true">{getInitials(person)}</span>
        <span className="trc-person" title={row.person?.department ? `${person} · ${row.person.department}` : person}>{person}</span>
        <span className="trc-time" title={row.time ? formatDateTimeIndia(row.time) : undefined}>
          {row.time ? formatShortDateTime(row.time) : '—'}
        </span>
        {openUrl && (
          <a className="trc-open" href={openUrl} target="_blank" rel="noreferrer" aria-label="Open in a new tab" title="Open">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
            </svg>
          </a>
        )}
      </footer>
    </article>
  );
}

export default function ToolRecordsTab({ tool, searchInput = '', onFiltersChange }) {
  const [options, setOptions] = useState(null);
  const [optionsError, setOptionsError] = useState('');
  const [sheetKey, setSheetKey] = useState(null);
  const [state, setState] = useState(EMPTY_STATE);
  const [applied, setApplied] = useState(EMPTY_STATE);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState('latest');
  const [rows, setRows] = useState([]);
  const [rowsSheet, setRowsSheet] = useState(null); // which sheet `rows` belong to
  const [openRecord, setOpenRecord] = useState(null);
  const [summary, setSummary] = useState(null);
  const [canSortByCredits, setCanSortByCredits] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(null);
  const [error, setError] = useState('');
  const requestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    loadToolOptions(tool.key)
      .then((res) => {
        if (cancelled) return;
        setOptions(res);
        setSheetKey((current) => current || res?.sheets?.[0]?.key || null);
      })
      .catch(() => { if (!cancelled) setOptionsError('Could not load the filters for this tool.'); });
    return () => { cancelled = true; };
  }, [tool.key]);

  // Debounce typing (search box, number ranges) before querying.
  useEffect(() => {
    const timer = window.setTimeout(() => setApplied(state), 250);
    return () => window.clearTimeout(timer);
  }, [state]);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  // The export popover starts from what the tab shows.
  useEffect(() => { onFiltersChange?.({ ...state, q, sheetKey }); }, [state, q, sheetKey, onFiltersChange]);

  const sheets = useMemo(() => options?.sheets || [], [options]);
  const sheet = sheets.find((item) => item.key === sheetKey) || null;
  const cardEntry = TOOL_CARDS[`${tool.key}.${sheetKey}`] || null;
  const invalid = invalidReason(applied, sheet ? [sheet] : []);
  const params = useMemo(
    () => buildToolParams(applied, { q: q || undefined, onlySheet: sheetKey }),
    [applied, q, sheetKey],
  );
  const paramsKey = JSON.stringify(params);

  const fetchPage = useCallback(async (offset) => {
    const res = await rmwDataExportAPI.getRows(tool.key, {
      ...params, sheet: sheetKey, sort, limit: PAGE_SIZE, offset, format: cardEntry ? 'native' : 'summary',
    });
    return res;
  }, [tool.key, params, sheetKey, sort, cardEntry]);

  useEffect(() => {
    if (!sheetKey || invalid) return;
    const requestId = ++requestRef.current;
    setLoading(true);
    setError('');
    fetchPage(0)
      .then((res) => {
        if (requestId !== requestRef.current) return;
        setRows(res?.rows || []);
        setRowsSheet(sheetKey);
        setSummary(res?.summary || null);
        setCanSortByCredits(Boolean(res?.canSortByCredits));
        setNextOffset(res?.hasMore ? res.nextOffset : null);
      })
      .catch(() => { if (requestId === requestRef.current) setError('Could not load records right now.'); })
      .finally(() => { if (requestId === requestRef.current) setLoading(false); });
    // paramsKey captures fetchPage's inputs.
  }, [sheetKey, paramsKey, sort, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (loadingMore || nextOffset == null) return;
    setLoadingMore(true);
    try {
      const res = await fetchPage(nextOffset);
      setRows((prev) => [...prev, ...(res?.rows || [])]);
      setNextOffset(res?.hasMore ? res.nextOffset : null);
    } catch {
      setError('Could not load more records.');
    } finally {
      setLoadingMore(false);
    }
  };

  const setCommon = (patch) => setState((prev) => ({ ...prev, common: { ...prev.common, ...patch } }));
  const setSheetValue = (patch) => setState((prev) => ({
    ...prev,
    perSheet: { ...prev.perSheet, [sheetKey]: { ...(prev.perSheet[sheetKey] || {}), ...patch } },
  }));

  const c = options?.common || {};
  const { from, to } = resolveDates(state.common);
  const sheetValues = state.perSheet[sheetKey] || {};

  // "When & who": the same filters on every tool, shown wherever the tool
  // records them (even with one choice, so the bar is predictable).
  const has = (list) => Array.isArray(list) && list.length > 0;
  const whoFields = [];
  if (sheet?.hasOwner && has(c.owners)) {
    whoFields.push(<Select key="owner" label="Person" anyLabel="Everyone" options={c.owners} value={state.common.ownerUserId} onChange={(v) => setCommon({ ownerUserId: v })} />);
  }
  if (sheet?.hasOwner && has(c.departments)) {
    whoFields.push(<Select key="dept" label="Department" anyLabel="All departments" options={c.departments} value={state.common.department} onChange={(v) => setCommon({ department: v })} />);
  }
  if (sheet?.hasLinked && Array.isArray(c.linked)) {
    whoFields.push(<Select key="linked" label="Linked to" anyLabel="Any" options={c.linked} value={state.common.linked} onChange={(v) => setCommon({ linked: v })} />);
  }
  if (sheet?.hasLinked && has(c.clients)) {
    whoFields.push(<Select key="client" label="Client" anyLabel="All clients" options={c.clients} value={state.common.client} onChange={(v) => setCommon({ client: v })} />);
  }
  if (sheet?.hasOwnership && has(c.ownership)) {
    whoFields.push(<Select key="ownership" label="Ownership" anyLabel="Any" options={c.ownership} value={state.common.ownership} onChange={(v) => setCommon({ ownership: v })} />);
  }
  // "Details": this record type's own filters (only where values differ).
  const detailFields = [];
  (sheet?.filters || []).forEach((fd) => {
    if (fd.kind === 'range') {
      detailFields.push(
        <RangeField key={fd.key} label={fd.label} min={fd.min} max={fd.max} low={sheetValues[`${fd.key}_min`]} high={sheetValues[`${fd.key}_max`]}
          onChange={(end, value) => setSheetValue({ [`${fd.key}_${end}`]: value })} />,
      );
    } else if (usable(fd.options)) {
      detailFields.push(<Select key={fd.key} label={fd.label} anyLabel="Any" options={fd.options} value={sheetValues[fd.key]} onChange={(v) => setSheetValue({ [fd.key]: v })} />);
    }
  });

  const chips = options ? describeToolFilters(state, options, sheetKey) : [];
  const creditsLabel = sheet?.filters?.find((fd) => fd.kind === 'range')?.label || 'Credits';

  // Drawer edits/deletes, applied to the loaded list in place.
  const handleRecordUpdated = (data) => {
    if (!data?.id) return;
    setRows((prev) => prev.map((row) => (row.id === data.id ? { ...row, ...data } : row)));
  };
  const handleRecordDeleted = (id) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
    setSummary((prev) => (prev ? { ...prev, count: Math.max(0, prev.count - 1) } : prev));
    setOpenRecord(null);
  };
  const visibleRows = rowsSheet === sheetKey ? rows : [];
  const Drawer = cardEntry?.Drawer;

  return (
    <div className="trc-root">
      <div className="trc-subnav">
        <div className="trc-sheets" role="tablist" aria-label={`${tool.label} record types`}>
          {sheets.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.key === sheetKey}
              className={`trc-sheet-tab${item.key === sheetKey ? ' active' : ''}`}
              onClick={() => setSheetKey(item.key)}
            >
              {item.title}
              <span className="trc-sheet-count">{item.count.toLocaleString()}</span>
            </button>
          ))}
        </div>
      </div>

      {optionsError && <div className="trc-state trc-state--error">{optionsError}</div>}

      {options && sheet && (
        <div className="trc-filters">
          <div className="ftb">
            <div className="ftb-date">
              <DateRangePicker
                block
                allowAll
                portal
                align="left"
                ariaLabel="Date range"
                start={from || ''}
                end={to || ''}
                presetKey={state.common.datePreset}
                onChange={(range, key) => setCommon(datePatch(range, key))}
              />
            </div>

            <FilterPopover
              activeCount={chips.filter((chip) => chip.key !== 'date').length}
              onClear={() => setState((prev) => ({ ...EMPTY_STATE, common: { ...EMPTY_STATE.common, datePreset: prev.common.datePreset, dateFrom: prev.common.dateFrom, dateTo: prev.common.dateTo } }))}
            >
              {whoFields.length > 0 && (
                <section className="fpop-section">
                  <h6 className="fpop-section-title">People &amp; attribution</h6>
                  <div className="fpop-grid">{whoFields}</div>
                </section>
              )}
              {detailFields.length > 0 && (
                <section className="fpop-section">
                  <h6 className="fpop-section-title">{sheet.title} details</h6>
                  <div className="fpop-grid">{detailFields}</div>
                </section>
              )}
            </FilterPopover>

            <div className="kfb-summary" aria-live="polite">
              {invalid ? (
                <span className="kfb-invalid">{invalid}</span>
              ) : loading || !summary ? (
                <span className="kfb-count kfb-count--muted">Counting…</span>
              ) : (
                <span className="kfb-count">
                  <strong>{summary.count.toLocaleString()}</strong> {sheet.title.toLowerCase()}
                  {summary.credits != null && (
                    <>
                      <span className="kfb-dot">·</span>
                      <strong>{Math.round(summary.credits).toLocaleString()}</strong> {creditsLabel.toLowerCase()}
                    </>
                  )}
                </span>
              )}
              {chips.map((chip) => (
                <span key={chip.key} className="kfb-chip">
                  {chip.label}
                  <button type="button" onClick={() => setState(chip.apply)} aria-label={`Remove filter ${chip.label}`}>×</button>
                </span>
              ))}
              {chips.length > 0 && (
                <button type="button" className="kfb-clear" onClick={() => setState(EMPTY_STATE)}>Clear all</button>
              )}
            </div>

            <div className="kfb-controls">
              <label className="kfb-sort">
                <span>Sort</span>
                <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="Sort records">
                  <option value="latest">Newest first</option>
                  <option value="oldest">Oldest first</option>
                  {canSortByCredits && <option value="credits">Most {creditsLabel.toLowerCase()}</option>}
                </select>
              </label>
            </div>
          </div>
        </div>
      )}

      <div className="trc-results">
        {error && <div className="trc-state trc-state--error">{error}</div>}
        {!options && !optionsError && <div className="trc-state">Loading {tool.label}…</div>}
        {options && !error && !invalid && loading && visibleRows.length === 0 && <div className="trc-state">Loading records…</div>}
        {options && !error && !invalid && !loading && visibleRows.length === 0 && (
          <div className="trc-state">
            No {sheet?.title.toLowerCase() || 'records'} match these filters.
            {chips.length > 0 && <button type="button" className="kfb-clear" onClick={() => setState(EMPTY_STATE)}>Clear all filters</button>}
          </div>
        )}
        {visibleRows.length > 0 && (
          <>
            <div className={`trc-grid${cardEntry ? ' trc-grid--native' : ''}${loading ? ' is-refreshing' : ''}`}>
              {visibleRows.map((row) => (cardEntry ? (
                <div key={row.id} className="trc-cell">
                  <cardEntry.Card {...{ [cardEntry.prop]: row }} onOpen={Drawer ? (record) => setOpenRecord(record) : undefined} />
                </div>
              ) : (
                <RecordCard key={row.id} row={row} creditsLabel={creditsLabel} />
              )))}
            </div>
            {nextOffset != null && (
              <div className="trc-more">
                <button type="button" className="kfb-btn" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Show more (${(summary?.count || 0) - visibleRows.length} left)`}
                </button>
              </div>
            )}
          </>
        )}
      </div>

      {Drawer && cardEntry.drawer === 'id' && (
        <Drawer
          generationId={openRecord?.id ?? null}
          onClose={() => setOpenRecord(null)}
          onGenerationUpdated={handleRecordUpdated}
          onGenerationDeleted={handleRecordDeleted}
        />
      )}
      {Drawer && cardEntry.drawer === 'object' && (
        <Drawer download={openRecord} onClose={() => setOpenRecord(null)} />
      )}
    </div>
  );
}
