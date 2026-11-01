import DateRangePicker from '../../../../reports/DateRangePicker';
import FilterPopover from '../FilterPopover';
import KlingFilterFields from './KlingFilterFields';
import { KLING_DEFAULT_FILTERS, SORT_OPTIONS, describeKlingFilters, isFilterInvalid, resolveDateRange } from './klingFilters';

/**
 * Kling's one-row toolbar: date range inline, every other filter behind the
 * shared "Filters" popover (same pattern as the other tool tabs), then the
 * live total with removable chips, Favourites and Sort.
 */
export default function KlingFilterBar({
  filters,
  onChange,
  onReset,
  options,
  sortBy,
  onSortChange,
  summary,
  loading,
  collectionFilter,
  onClearCollectionFilter,
}) {
  const chips = describeKlingFilters(filters, options);
  const invalid = isFilterInvalid(filters);
  const hasAnyFilter = chips.length > 0 || Boolean(collectionFilter);
  const { from, to } = resolveDateRange(filters);
  // Favourites has its own toggle and the date its own picker.
  const popoverActive = chips.filter((chip) => chip.key !== 'date' && chip.key !== 'favoritesOnly').length;

  const clearPopoverFilters = () => onChange({
    ...KLING_DEFAULT_FILTERS,
    datePreset: filters.datePreset,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    favoritesOnly: filters.favoritesOnly,
  });

  return (
    <div className="kling-filter-bar">
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
            presetKey={filters.datePreset}
            onChange={(range, key) => onChange(
              key === 'custom'
                ? { datePreset: 'custom', dateFrom: range.start, dateTo: range.end }
                : { datePreset: key, dateFrom: '', dateTo: '' },
            )}
          />
        </div>

        <FilterPopover activeCount={popoverActive} onClear={clearPopoverFilters}>
          <KlingFilterFields filters={filters} onChange={onChange} options={options} showAdvanced layout="stack" hideDate />
        </FilterPopover>

        <div className="kfb-summary" aria-live="polite">
          {invalid ? (
            <span className="kfb-invalid">{invalid}</span>
          ) : loading || !summary ? (
            <span className="kfb-count kfb-count--muted">Counting…</span>
          ) : (
            <span className="kfb-count">
              <strong>{summary.count.toLocaleString()}</strong> generation{summary.count === 1 ? '' : 's'}
              <span className="kfb-dot">·</span>
              <strong>{Math.round(summary.credits).toLocaleString()}</strong> credits
            </span>
          )}

          {collectionFilter && (
            <span className="kfb-chip kfb-chip--accent">
              Collection: {collectionFilter.name}
              <button type="button" onClick={onClearCollectionFilter} aria-label="Clear collection filter">×</button>
            </span>
          )}
          {chips.map((chip) => (
            <span key={chip.key} className="kfb-chip">
              {chip.label}
              <button type="button" onClick={() => onChange(chip.reset)} aria-label={`Remove filter ${chip.label}`}>×</button>
            </span>
          ))}
          {hasAnyFilter && (
            <button type="button" className="kfb-clear" onClick={onReset}>Clear all</button>
          )}
        </div>

        <div className="kfb-controls">
          <button
            type="button"
            className={`kfb-btn${filters.favoritesOnly ? ' is-active' : ''}`}
            onClick={() => onChange({ favoritesOnly: !filters.favoritesOnly })}
            aria-pressed={filters.favoritesOnly}
          >
            ★ Favourites
          </button>
          <label className="kfb-sort">
            <span>Sort</span>
            <select value={sortBy} onChange={(event) => onSortChange(event.target.value)} aria-label="Sort generations">
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>
    </div>
  );
}
