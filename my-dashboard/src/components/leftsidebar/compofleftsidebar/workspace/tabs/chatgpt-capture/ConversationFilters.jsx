import { FILTER_GROUPS } from './conversationFilterHelpers';

// Grouped Type / Status / Time filter chips for the conversation sidebar.
// Controlled: parent owns the { type, status, time } state.
export default function ConversationFilters({ filters, onChange }) {
  return (
    <div className="cgpt-conv-filters">
      {FILTER_GROUPS.map((group) => (
        <div key={group.axis} className="cgpt-conv-filter-group">
          <span className="cgpt-conv-filter-label">{group.label}</span>
          <div className="chatgpt-capture-quick-filters" role="group" aria-label={`Filter by ${group.label}`}>
            {group.options.map((opt) => (
              <button
                key={opt.key}
                type="button"
                className={`chatgpt-capture-quick-filter${filters[group.axis] === opt.key ? ' active' : ''}`}
                aria-pressed={filters[group.axis] === opt.key}
                onClick={() => onChange(group.axis, opt.key)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
