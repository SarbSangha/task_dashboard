import DateRangePicker from '../../../../reports/DateRangePicker';
import {
  CAPTURE_OPTIONS,
  CREDIT_PRESETS,
  DUPLICATE_OPTIONS,
  LINKED_OPTIONS,
  OUTPUT_OPTIONS,
  OWNERSHIP_OPTIONS,
  QUALITY_OPTIONS,
  resolveDateRange,
} from './klingFilters';

const withCount = (label, count) => (Number.isFinite(count) ? `${label} · ${count.toLocaleString()}` : label);

function Field({ label, wide = false, children }) {
  return (
    <div className={`kff-field${wide ? ' kff-field--wide' : ''}`}>
      <span className="kff-label">{label}</span>
      {children}
    </div>
  );
}

function Select({ value, onChange, anyLabel, options, ariaLabel }) {
  return (
    <select className="kff-select" value={value} onChange={(event) => onChange(event.target.value)} aria-label={ariaLabel}>
      {anyLabel && <option value="">{anyLabel}</option>}
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  );
}

function Group({ title, layout, children }) {
  if (layout !== 'stack') return children;
  return (
    <section className="kff-group">
      <h6 className="kff-group-title">{title}</h6>
      <div className="kff-grid">{children}</div>
    </section>
  );
}

/**
 * The Kling filter controls, shared by the tab's filter bar (layout "bar":
 * one compact grid) and the Excel export popover (layout "stack": grouped,
 * two columns) so both always offer the same choices. Options and counts
 * come from GET /api/generations/filters.
 */
export default function KlingFilterFields({ filters, onChange, options = {}, showAdvanced = false, layout = 'bar', hideDate = false }) {
  const counts = options.counts || {};
  const set = (key) => (value) => onChange({ [key]: value });
  const fromCounts = (list) => list.map((item) => ({ value: item.value, label: withCount(item.label, counts[item.count]) }));

  const owners = (options.owners || []).map((owner) => ({ value: String(owner.userId), label: withCount(owner.name, owner.count) }));
  const departments = (options.departments || []).map((dept) => ({ value: dept.value, label: withCount(dept.value, dept.count) }));
  const accounts = (options.accounts || []).map((account) => ({ value: account.value, label: withCount(account.value, account.count) }));
  const clients = (options.clients || []).map((client) => ({ value: String(client.id), label: withCount(client.name, client.count) }));
  const models = (options.models || []).map((model) => ({ value: model, label: model }));
  const resolutions = (options.resolutions || []).map((resolution) => ({ value: resolution, label: resolution }));
  const tags = options.tags || [];
  const { from, to } = resolveDateRange(filters);

  const dateField = (
    <Field label="Date range" wide>
      <DateRangePicker
        block
        allowAll
        portal
        ariaLabel="Date range"
        align={layout === 'stack' ? 'right' : 'left'}
        start={from || ''}
        end={to || ''}
        presetKey={filters.datePreset}
        onChange={(range, key) => onChange(
          key === 'custom'
            ? { datePreset: 'custom', dateFrom: range.start, dateTo: range.end }
            : { datePreset: key, dateFrom: '', dateTo: '' },
        )}
      />
    </Field>
  );

  const content = (
    <>
      {!hideDate && <Group title="Date range" layout={layout}>{dateField}</Group>}

      <Group title="People" layout={layout}>
        <Field label="Person">
          <Select value={filters.ownerUserId} onChange={set('ownerUserId')} anyLabel="Everyone" options={owners} ariaLabel="Person" />
        </Field>
        <Field label="Department">
          <Select value={filters.department} onChange={set('department')} anyLabel="All departments" options={departments} ariaLabel="Department" />
        </Field>
      </Group>

      <Group title="Generations" layout={layout}>
        <Field label="Kling account">
          <Select value={filters.account} onChange={set('account')} anyLabel="All accounts" options={accounts} ariaLabel="Kling account" />
        </Field>
        <Field label="Output">
          <Select value={filters.outputType} onChange={set('outputType')} anyLabel="Video & image" options={fromCounts(OUTPUT_OPTIONS)} ariaLabel="Output type" />
        </Field>
        <Field label="Credits">
          <Select value={filters.creditsPreset} onChange={set('creditsPreset')} options={CREDIT_PRESETS} ariaLabel="Credits" />
        </Field>
        {filters.creditsPreset === 'custom' && (
          <Field label="Min – max credits">
            <div className="kff-pair">
              <input
                type="number"
                min="0"
                inputMode="numeric"
                className="kff-select"
                placeholder={options.creditRange?.min != null ? `${options.creditRange.min}` : 'min'}
                value={filters.creditsMin}
                onChange={(event) => onChange({ creditsMin: event.target.value })}
                aria-label="Minimum credits"
              />
              <input
                type="number"
                min="0"
                inputMode="numeric"
                className="kff-select"
                placeholder={options.creditRange?.max != null ? `${options.creditRange.max}` : 'max'}
                value={filters.creditsMax}
                onChange={(event) => onChange({ creditsMax: event.target.value })}
                aria-label="Maximum credits"
              />
            </div>
          </Field>
        )}
      </Group>

      {showAdvanced && (
        <Group title="Audit & data quality" layout={layout}>
          <Field label="Linked to">
            <Select value={filters.linked} onChange={set('linked')} anyLabel="Any" options={fromCounts(LINKED_OPTIONS)} ariaLabel="Linked to" />
          </Field>
          {clients.length > 0 && (
            <Field label="Client">
              <Select value={filters.clientId} onChange={set('clientId')} anyLabel="All clients" options={clients} ariaLabel="Client" />
            </Field>
          )}
          <Field label="Data quality">
            <Select value={filters.quality} onChange={set('quality')} anyLabel="Any" options={fromCounts(QUALITY_OPTIONS)} ariaLabel="Data quality" />
          </Field>
          <Field label="Duplicates">
            <Select value={filters.duplicates} onChange={set('duplicates')} anyLabel="Include" options={fromCounts(DUPLICATE_OPTIONS)} ariaLabel="Duplicates" />
          </Field>
          <Field label="Captured by">
            <Select value={filters.capture} onChange={set('capture')} anyLabel="Any method" options={fromCounts(CAPTURE_OPTIONS)} ariaLabel="Capture method" />
          </Field>
          <Field label="Ownership">
            <Select value={filters.ownership} onChange={set('ownership')} anyLabel="Any" options={OWNERSHIP_OPTIONS} ariaLabel="Ownership" />
          </Field>
          {models.length > 0 && (
            <Field label="Model">
              <Select value={filters.model} onChange={set('model')} anyLabel="All models" options={models} ariaLabel="Model" />
            </Field>
          )}
          {resolutions.length > 0 && (
            <Field label="Resolution">
              <Select value={filters.resolution} onChange={set('resolution')} anyLabel="All resolutions" options={resolutions} ariaLabel="Resolution" />
            </Field>
          )}
          {tags.length > 0 && (
            <Field label="Tag">
              <input
                className="kff-select"
                list="kff-tag-options"
                placeholder="Any tag"
                value={filters.tag}
                onChange={(event) => onChange({ tag: event.target.value })}
                aria-label="Tag"
              />
              <datalist id="kff-tag-options">
                {tags.map((tag) => <option key={tag} value={tag} />)}
              </datalist>
            </Field>
          )}
        </Group>
      )}
    </>
  );

  return (
    <div className={`kff kff--${layout}`}>
      {layout === 'stack' ? content : <div className="kff-grid">{content}</div>}
    </div>
  );
}
