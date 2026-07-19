import React from 'react';
import { presetRange } from './utils/format';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'custom', label: 'Custom' },
];

const GlobalFilters = ({ filters, preset, onChange, departments = [] }) => {
  const setPreset = (key) => {
    if (key === 'custom') {
      onChange({ preset: 'custom' });
      return;
    }
    const range = presetRange(key);
    onChange({ preset: key, start: range.start, end: range.end });
  };

  return (
    <div className="rpt-filters">
      <div className="rpt-filter-group">
        <span className="rpt-filter-label">Date</span>
        <div className="rpt-date-presets" role="group" aria-label="Date range preset">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={`rpt-date-preset ${preset === p.key ? 'active' : ''}`}
              onClick={() => setPreset(p.key)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {preset === 'custom' && (
        <div className="rpt-filter-group">
          <div className="rpt-date-inputs">
            <input
              type="date"
              className="rpt-input"
              value={filters.start || ''}
              max={filters.end || undefined}
              onChange={(e) => onChange({ start: e.target.value })}
              aria-label="Start date"
            />
            <span style={{ color: 'var(--color-text-muted)' }}>–</span>
            <input
              type="date"
              className="rpt-input"
              value={filters.end || ''}
              min={filters.start || undefined}
              onChange={(e) => onChange({ end: e.target.value })}
              aria-label="End date"
            />
          </div>
        </div>
      )}

      <div className="rpt-filter-group">
        <span className="rpt-filter-label">Department</span>
        <select
          className="rpt-select"
          value={filters.department || 'all'}
          onChange={(e) => onChange({ department: e.target.value })}
        >
          <option value="all">All departments</option>
          {departments.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      <div className="rpt-filter-group">
        <span className="rpt-filter-label">Tool</span>
        <select
          className="rpt-select"
          value={filters.tool || 'all'}
          onChange={(e) => onChange({ tool: e.target.value })}
        >
          <option value="all">All tools</option>
          <option value="kling">Kling AI</option>
          <option value="chatgpt">ChatGPT</option>
        </select>
      </div>
    </div>
  );
};

export default GlobalFilters;
