import { FILTER_GROUPS } from './conversationFilterHelpers';

// Type / Status / Time filters as a row of dropdowns (one select per axis)
// instead of stacked pill-button groups. Controlled: parent owns the
// { type, status, time } state.
export default function ConversationFilters({ filters, onChange }) {
  return (
    <div className="cgpt-conv-filters">
      {FILTER_GROUPS.map((group) => (
        <label key={group.axis} className="cgpt-conv-filter-group">
          <span className="cgpt-conv-filter-label">{group.label}</span>
          <select
            className="chatgpt-capture-select"
            aria-label={`Filter by ${group.label}`}
            value={filters[group.axis]}
            onChange={(event) => onChange(group.axis, event.target.value)}
          >
            {group.options.map((opt) => (
              <option key={opt.key} value={opt.key}>{opt.label}</option>
            ))}
          </select>
        </label>
      ))}
    </div>
  );
}
