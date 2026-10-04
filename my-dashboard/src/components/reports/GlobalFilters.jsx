import React from 'react';
import { presetRange } from './utils/format';

const PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: 'month', label: 'This month' },
  { key: 'prev_month', label: 'Last month' },
  { key: 'quarter', label: 'Quarter' },
  { key: '90d', label: '90 Days' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

// Display names for GenerationRecord providers; anything not listed falls
// back to a capitalised form of its id.
const TOOL_LABELS = {
  kling: 'Kling AI',
  freepik: 'Freepik',
  heygen: 'HeyGen',
  suno: 'Suno',
  higgsfield: 'Higgsfield',
  elevenlabs: 'ElevenLabs',
  envato: 'Envato',
  flow: 'Flow',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  splice: 'Splice',
  epidemicsound: 'Epidemic Sound',
  genspark: 'GenSpark',
  semrush: 'Semrush',
};
const toolLabel = (id) => TOOL_LABELS[id] || `${id || ''}`.replace(/(^|[-_ ])(\w)/g, (_m, sep, ch) => `${sep ? ' ' : ''}${ch.toUpperCase()}`);

const GlobalFilters = ({ filters, preset, onChange, departments = [], tools = [], toolScopes = null, klingAccounts = [], klingUsers = [] }) => {
  // Every tool in the system (backend /reports/filters `tools`: {id, name},
  // or plain provider ids from older backends), sorted by display name. The
  // current selection stays listed even if it is no longer offered.
  const nameById = new Map();
  tools.forEach((t) => {
    const id = typeof t === 'string' ? t : t?.id;
    if (id) nameById.set(id, TOOL_LABELS[id] || (typeof t === 'string' ? toolLabel(t) : t.name) || toolLabel(id));
  });
  if (filters.tool && filters.tool !== 'all' && !nameById.has(filters.tool)) nameById.set(filters.tool, toolLabel(filters.tool));
  const toolOptions = [...nameById.entries()].sort((a, b) => a[1].localeCompare(b[1]));

  // Account and User follow the Tool: "All tools" lists every account/user,
  // a specific tool lists only its own. Older backends without toolScopes
  // fall back to the Kling-only lists.
  const selectedTool = filters.tool || 'all';
  const scope = toolScopes
    ? (toolScopes[selectedTool] || { accounts: [], users: [] })
    : { accounts: klingAccounts, users: klingUsers };
  const accountOptions = scope.accounts || [];
  // A chosen department narrows the people too (the selected user stays
  // listed so the dropdown never shows a value it doesn't contain).
  const department = filters.department && filters.department !== 'all' ? filters.department : '';
  const userOptions = (scope.users || []).filter((u) => (
    !department || u.department === department || `${u.userId}` === `${filters.klingUser}`
  ));
  const toolName = selectedTool === 'all' ? '' : (nameById.get(selectedTool) || toolLabel(selectedTool));

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
      <div className="rpt-filters-row">
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
      </div>

      <div className="rpt-filters-grid">
        <label className="rpt-filter-field">
          <span className="rpt-filter-label">Department</span>
          <select
            className="rpt-select"
            value={filters.department || 'all'}
            onChange={(e) => onChange({ department: e.target.value, klingUser: 'all' })}
          >
            <option value="all">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>

        <label className="rpt-filter-field">
          <span className="rpt-filter-label">Tool</span>
          <select
            className="rpt-select"
            value={selectedTool}
            // A new tool means a new set of accounts/users - reset both so a
            // stale choice from the previous tool never silently filters.
            onChange={(e) => onChange({ tool: e.target.value, account: 'all', klingUser: 'all' })}
          >
            <option value="all">All tools</option>
            {toolOptions.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>

        <label className="rpt-filter-field">
          <span className="rpt-filter-label">{toolName ? `${toolName} account` : 'Account'}</span>
          <select
            className="rpt-select"
            value={filters.account || 'all'}
            onChange={(e) => onChange({ account: e.target.value })}
            title="The tool login (ID) that was used"
            disabled={!accountOptions.length}
          >
            <option value="all">{accountOptions.length ? 'All accounts' : 'No accounts recorded'}</option>
            {accountOptions.map((a) => (
              <option key={a.credentialId} value={a.credentialId}>{a.label}</option>
            ))}
          </select>
        </label>

        <label className="rpt-filter-field">
          <span className="rpt-filter-label">{toolName ? `${toolName} user` : 'User'}</span>
          <select
            className="rpt-select"
            value={filters.klingUser || 'all'}
            onChange={(e) => onChange({ klingUser: e.target.value })}
            title="The person who actually used the tool"
            disabled={!userOptions.length}
          >
            <option value="all">{userOptions.length ? 'All users' : (department ? 'No users in this department' : 'No users recorded')}</option>
            {userOptions.map((u) => (
              <option key={u.userId} value={u.userId}>
                {u.name}{u.department ? ` — ${u.department}` : ''}{u.generations ? ` (${u.generations})` : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
};

export default GlobalFilters;
