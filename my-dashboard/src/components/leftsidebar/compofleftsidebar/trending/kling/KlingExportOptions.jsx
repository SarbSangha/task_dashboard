import { useEffect, useState } from 'react';
import KlingFilterFields from './KlingFilterFields';
import {
  KLING_DEFAULT_FILTERS,
  countAdvancedActive,
  describeKlingFilters,
  isFilterInvalid,
  loadKlingFilterOptions,
  toKlingQueryParams,
} from './klingFilters';

/**
 * Filter sections of the Kling "Export to Excel" popover. Starts from the
 * tab's current filters (`initial`), can be changed independently, and
 * reports the export query params (or an error) through `onParamsChange`;
 * the popover footer shows the matching count.
 */
export default function KlingExportOptions({ initial, onParamsChange }) {
  const tabFilters = initial?.filters || KLING_DEFAULT_FILTERS;
  const [filters, setFilters] = useState(tabFilters);
  const [useSearch, setUseSearch] = useState(Boolean(initial?.q));
  const [useCollection, setUseCollection] = useState(Boolean(initial?.collectionId));
  const [showMore, setShowMore] = useState(countAdvancedActive(tabFilters) > 0);
  const [options, setOptions] = useState({});

  useEffect(() => {
    let cancelled = false;
    loadKlingFilterOptions().then((res) => { if (!cancelled) setOptions(res || {}); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const invalid = isFilterInvalid(filters);
  const params = toKlingQueryParams(filters, {
    q: useSearch && initial?.q ? initial.q : undefined,
    collection_id: useCollection && initial?.collectionId ? initial.collectionId : undefined,
  });
  const paramsKey = JSON.stringify(params);

  useEffect(() => {
    onParamsChange(params, invalid);
    // paramsKey captures every input of `params`.
  }, [paramsKey, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  const chips = describeKlingFilters(filters, options);
  const differsFromTab = JSON.stringify(filters) !== JSON.stringify(tabFilters);
  const advancedCount = countAdvancedActive(filters);

  return (
    <div className="kexp">
      <div className="kexp-bar">
        <span className="kexp-bar-text">
          {chips.length ? `${chips.length} filter${chips.length === 1 ? '' : 's'} applied` : 'No filters: every generation'}
        </span>
        <div className="kexp-bar-actions">
          {differsFromTab && (
            <button type="button" className="kexp-link" onClick={() => setFilters(tabFilters)}>Use tab filters</button>
          )}
          {chips.length > 0 && (
            <button type="button" className="kexp-link" onClick={() => setFilters(KLING_DEFAULT_FILTERS)}>Clear all</button>
          )}
        </div>
      </div>

      {chips.length > 0 && (
        <div className="kexp-chips">
          {chips.map((chip) => (
            <span key={chip.key} className="kexp-chip">
              {chip.label}
              <button type="button" onClick={() => setFilters((prev) => ({ ...prev, ...chip.reset }))} aria-label={`Remove ${chip.label}`}>×</button>
            </span>
          ))}
        </div>
      )}

      <KlingFilterFields
        filters={filters}
        onChange={(patch) => setFilters((prev) => ({ ...prev, ...patch }))}
        options={options}
        showAdvanced={showMore}
        layout="stack"
      />

      <button type="button" className="kexp-more" onClick={() => setShowMore((value) => !value)} aria-expanded={showMore}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          {showMore ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
        </svg>
        {showMore ? 'Hide audit & data quality filters' : 'Audit & data quality filters'}
        {!showMore && advancedCount > 0 && <span className="kexp-badge">{advancedCount}</span>}
      </button>

      {(initial?.q || initial?.collectionId) && (
        <div className="kexp-checks">
          {initial?.q && (
            <label className="rmw-export-check">
              <input type="checkbox" checked={useSearch} onChange={(event) => setUseSearch(event.target.checked)} />
              <span>Only rows matching “{initial.q}”</span>
            </label>
          )}
          {initial?.collectionId && (
            <label className="rmw-export-check">
              <input type="checkbox" checked={useCollection} onChange={(event) => setUseCollection(event.target.checked)} />
              <span>Only collection “{initial.collectionName}”</span>
            </label>
          )}
        </div>
      )}
    </div>
  );
}
