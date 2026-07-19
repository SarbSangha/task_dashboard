import React, { useState } from 'react';

const Icon = ({ path }) => (
  <svg className="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    {path}
  </svg>
);

const ICONS = {
  executive: <path d="M3 3v18h18M7 14l3-3 3 3 5-6" />,
  adoption: <><circle cx="12" cy="12" r="9" /><path d="M12 3a9 9 0 0 1 0 18" /></>,
  kling: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3z" /></>,
  chatgpt: <><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></>,
  tools: <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.1 2.1-2-2z" />,
  users: <><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /></>,
  tasks: <><path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" /></>,
  prompt: <><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /></>,
  cost: <><circle cx="12" cy="12" r="9" /><path d="M12 7v10M9.5 9.5h4a1.5 1.5 0 0 1 0 3h-3a1.5 1.5 0 0 0 0 3h4" /></>,
  reco: <path d="M12 2l2.4 7.4H22l-6 4.4 2.3 7.2-6.3-4.6L5.7 21 8 13.8 2 9.4h7.6z" />,
  build: <><path d="M4 4h16v4H4zM4 12h10v8H4zM17 12h3v8h-3z" /></>,
  history: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 8v4l3 2M8 3 5 6M16 3l3 3" /></>,
};

// section keys map to what ReportsPanel renders; `soon` marks placeholders.
const TREE = [
  { type: 'item', key: 'executive', label: 'Executive Overview', icon: 'executive' },
  { type: 'item', key: 'adoption', label: 'AI Adoption', icon: 'adoption', soon: true },
  {
    type: 'group', key: 'tool', label: 'Tool Intelligence', icon: 'tools',
    children: [
      { key: 'kling', label: 'Kling Analytics', icon: 'kling' },
      { key: 'chatgpt', label: 'ChatGPT Analytics', icon: 'chatgpt' },
      { key: 'other-tools', label: 'Other Tools', icon: 'tools', soon: true },
    ],
  },
  {
    type: 'group', key: 'user', label: 'User Intelligence', icon: 'users',
    children: [
      { key: 'user-activity', label: 'User Activity', icon: 'users' },
      { key: 'user-retention', label: 'User Retention', icon: 'users' },
      { key: 'power-users', label: 'Power Users', icon: 'users' },
      { key: 'ai-maturity', label: 'User AI Maturity', icon: 'users' },
    ],
  },
  {
    type: 'group', key: 'task', label: 'Task Intelligence', icon: 'tasks',
    children: [
      { key: 'productivity', label: 'Productivity', icon: 'tasks' },
      { key: 'completion', label: 'Completion Analysis', icon: 'tasks' },
      { key: 'task-ai-impact', label: 'AI Impact', icon: 'tasks' },
      { key: 'bottlenecks', label: 'Bottlenecks', icon: 'tasks' },
    ],
  },
  {
    type: 'group', key: 'prompt', label: 'Prompt Intelligence', icon: 'prompt',
    children: [
      { key: 'prompt-performance', label: 'Prompt Performance', icon: 'prompt' },
      { key: 'golden-prompts', label: 'Golden Prompt Library', icon: 'prompt' },
      { key: 'prompt-leaderboard', label: 'Prompt Leaderboard', icon: 'prompt' },
      { key: 'prompt-evolution', label: 'Prompt Evolution', icon: 'prompt' },
    ],
  },
  {
    type: 'group', key: 'cost', label: 'Cost Intelligence', icon: 'cost',
    children: [
      { key: 'credit-usage', label: 'Credit Usage', icon: 'cost' },
      { key: 'token-analysis', label: 'Token Analysis', icon: 'cost' },
      { key: 'roi-analysis', label: 'ROI Analysis', icon: 'cost' },
    ],
  },
  { type: 'item', key: 'recommendations', label: 'AI Recommendations', icon: 'reco' },
  { type: 'item', key: 'report-builder', label: 'Report Builder', icon: 'build' },
  { type: 'item', key: 'library', label: 'Analytics Library', icon: 'build' },
  { type: 'item', key: 'report-history', label: 'Report History', icon: 'history' },
  { type: 'item', key: 'scheduled-reports', label: 'Scheduled Reports', icon: 'clock' },
];

const TreeItem = ({ node, active, onSelect, nested }) => (
  <button
    type="button"
    className={`rpt-tree-item ${nested ? 'nested' : ''} ${active === node.key ? 'active' : ''}`}
    onClick={() => onSelect(node.key)}
  >
    <Icon path={ICONS[node.icon] || ICONS.executive} />
    <span>{node.label}</span>
    {node.soon && <span className="badge-soon">Soon</span>}
  </button>
);

const ReportsSidebarTree = ({ active, onSelect }) => {
  const [collapsed, setCollapsed] = useState({});
  const toggle = (key) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  return (
    <>
      {TREE.map((node) => {
        if (node.type === 'item') {
          return <TreeItem key={node.key} node={node} active={active} onSelect={onSelect} />;
        }
        const isCollapsed = collapsed[node.key];
        return (
          <div className="rpt-tree-group" key={node.key}>
            <button
              type="button"
              className={`rpt-tree-grouphead ${isCollapsed ? 'collapsed' : ''}`}
              onClick={() => toggle(node.key)}
            >
              {node.label}
              <svg className="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
            </button>
            {!isCollapsed && node.children.map((child) => (
              <TreeItem key={child.key} node={child} active={active} onSelect={onSelect} nested />
            ))}
          </div>
        );
      })}
    </>
  );
};

export default ReportsSidebarTree;
