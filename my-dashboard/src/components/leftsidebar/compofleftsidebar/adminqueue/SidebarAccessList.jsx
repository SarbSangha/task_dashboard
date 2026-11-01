import './SidebarAccessList.css';

/*
 * A copy of the real sidebar (components/leftsidebar/Leftside.jsx), grouped the
 * same way, with one control per entry. Three kinds of entry:
 *   section - shown to everyone unless hidden here (user.sectionVisibility)
 *   feature - hidden until granted here (user.featureAccess)
 *   admin   - comes with admin access; not separately grantable
 * Keep this in step with Leftside.jsx when sidebar entries change.
 */
const SIDEBAR_GROUPS = [
  {
    label: 'Work',
    items: [
      { kind: 'section', key: 'tracking', label: 'Tracking', icon: 'tracking' },
      { kind: 'section', key: 'create_task', label: 'Create Task', icon: 'plus', hint: 'Also the "+ Assign Task" shortcut' },
      { kind: 'section', key: 'inbox', label: 'Inbox', icon: 'inbox' },
      { kind: 'section', key: 'outbox', label: 'Outbox', icon: 'send' },
      { kind: 'section', key: 'workspace', label: 'Workspace', icon: 'grid', hint: 'Includes AI Tools' },
    ],
  },
  {
    label: 'Communication',
    items: [{ kind: 'section', key: 'messages', label: 'Messages', icon: 'chat' }],
  },
  {
    label: 'Insight',
    items: [
      { kind: 'feature', key: 'rmw_data', label: 'RMW Data', icon: 'trend' },
      {
        kind: 'feature',
        key: 'buffer',
        label: 'Buffer',
        icon: 'box',
        children: [{ kind: 'feature', key: 'buffer_sheet_edit', label: 'Purpose Sheet Editing', hint: 'Create purposes and edit rows' }],
      },
      { kind: 'admin', key: 'admin_queue', label: 'Admin Queue', icon: 'shield' },
    ],
  },
  {
    label: 'Analytics',
    items: [
      { kind: 'admin', key: 'reports', label: 'Reports & Spend', icon: 'bars' },
      { kind: 'admin', key: 'task_report', label: 'Task Report', icon: 'check' },
    ],
  },
  {
    label: 'Credit Report',
    items: [{ kind: 'feature', key: 'credit_report', label: 'Credit Report', icon: 'bars', hint: 'Opened from Reports & Spend in the top bar' }],
  },
  {
    label: 'Sheets',
    items: [
      {
        kind: 'feature',
        key: 'sheet_activity',
        label: 'Sheets',
        icon: 'sheet',
        hint: 'Registered Google Sheets',
        children: [{ kind: 'feature', key: 'sheets_add', label: 'Add Sheets', hint: 'Register new sheets' }],
      },
    ],
  },
  {
    label: 'AI Library',
    items: [{ kind: 'feature', key: 'ai_library', label: 'AI Library', icon: 'library' }],
  },
];

const KNOWN_FEATURES = new Set(
  SIDEBAR_GROUPS.flatMap((group) => group.items.flatMap((item) => [item, ...(item.children || [])]))
    .filter((item) => item.kind === 'feature')
    .map((item) => item.key),
);

const ICON_PATHS = {
  tracking: <><rect x="6" y="4" width="12" height="17" rx="2" /><path d="M9 4h6v3H9zM9.5 13.5l2 2 3.5-4" /></>,
  plus: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M12 8v8M8 12h8" /></>,
  inbox: <><path d="M4 13h4l1.5 3h5L16 13h4" /><path d="M5.5 6h13L20 13v5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-5Z" /></>,
  send: <path d="M21 3 10 14M21 3l-7 18-4-7-7-4Z" />,
  grid: <><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></>,
  chat: <path d="M5 5h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9l-4 3V6a1 1 0 0 1 1-1Z" />,
  trend: <path d="M3 17l6-6 4 4 8-8M15 7h6v6" />,
  box: <><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9Z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>,
  shield: <><path d="M12 3 19 6v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6Z" /><path d="m9 12 2 2 4-4" /></>,
  bars: <><path d="M4 20h16" /><path d="M7 16v-4M12 16V8M17 16v-7" /></>,
  check: <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  sheet: <><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4M9 12h6M9 16h6" /></>,
  library: <><path d="M5 4h4v16H5zM10 4h4v16h-4z" /><path d="m15.5 5 3.5-.8 2 15.6-3.5.8Z" /></>,
  more: <><circle cx="6" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="18" cy="12" r="1.3" /></>,
};

function SectionIcon({ name }) {
  return (
    <span className="sal-icon" aria-hidden="true">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        {ICON_PATHS[name] || ICON_PATHS.more}
      </svg>
    </span>
  );
}

function Toggle({ checked, disabled, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`udd-switch${checked ? ' is-on' : ''}`}
      onClick={onChange}
      disabled={disabled}
    >
      <span className="udd-switch-thumb" />
    </button>
  );
}

export default function SidebarAccessList({ user, catalog = [], busyKey, onToggleFeature, onToggleSection }) {
  const exempt = Boolean(user.isFeatureExempt);
  const featureAccess = user.featureAccess || {};
  const sectionVisibility = user.sectionVisibility || {};

  // Features the server knows about but this layout does not (added later)
  // still get a switch, so the drawer never silently drops one.
  const extraFeatures = catalog.filter((feature) => !KNOWN_FEATURES.has(feature.key));
  const groups = extraFeatures.length
    ? [...SIDEBAR_GROUPS, {
      label: 'Other',
      items: extraFeatures.map((feature) => ({ kind: 'feature', key: feature.key, label: feature.label, icon: 'more' })),
    }]
    : SIDEBAR_GROUPS;

  const isOn = (item) => {
    if (exempt) return true;
    if (item.kind === 'section') return sectionVisibility[item.key] !== false;
    if (item.kind === 'feature') return featureAccess[item.key] === true;
    return Boolean(user.isAdmin);
  };

  const topLevel = groups.flatMap((group) => group.items);
  const visibleCount = topLevel.filter(isOn).length;

  const renderControl = (item, parentOff) => {
    const label = item.label;
    if (exempt) return <span className="sal-pill sal-pill--on">Always on</span>;
    if (item.kind === 'admin') return <span className="sal-pill">Admins only</span>;
    const busy = busyKey === `${item.kind}:${item.key}`;
    if (item.kind === 'section') {
      return (
        <Toggle
          label={`Show ${label}`}
          checked={isOn(item)}
          disabled={busy}
          onChange={() => onToggleSection(item)}
        />
      );
    }
    return (
      <Toggle
        label={`Grant ${label}`}
        checked={isOn(item)}
        disabled={busy || (parentOff && !isOn(item))}
        onChange={() => onToggleFeature(item)}
      />
    );
  };

  const renderRow = (item, { child = false, parent = null } = {}) => {
    const on = isOn(item);
    const parentOff = parent ? !isOn(parent) : false;
    const hint = parentOff && !exempt ? `Needs ${parent.label} first` : item.hint;
    return (
      <div
        key={item.key}
        className={`sal-row${child ? ' sal-row--child' : ''}${on ? ' is-on' : ' is-off'}${item.kind === 'admin' ? ' is-admin' : ''}`}
      >
        {child ? <span className="sal-branch" aria-hidden="true" /> : <SectionIcon name={item.icon} />}
        <div className="sal-copy">
          <span className="sal-title">{item.label}</span>
          {hint && <span className="sal-hint">{hint}</span>}
        </div>
        {renderControl(item, parentOff)}
      </div>
    );
  };

  return (
    <div className="sal">
      <div className="udd-section-head">
        <h5 className="udd-section-title">Sidebar sections</h5>
        <span className="sal-count">
          {visibleCount} of {topLevel.length} visible
        </span>
      </div>
      {!exempt && (
        <p className="sal-legend">
          Work and Messages are on for everyone unless you hide them. Other sections stay hidden until you turn them on.
        </p>
      )}

      <div className="sal-groups">
        {groups.map((group) => (
          <div key={group.label} className="sal-group">
            <div className="sal-group-label">{group.label}</div>
            <div className="sal-group-rows">
              {group.items.map((item) => (
                <div key={item.key} className="sal-item">
                  {renderRow(item)}
                  {item.children?.map((child) => renderRow(child, { child: true, parent: item }))}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
