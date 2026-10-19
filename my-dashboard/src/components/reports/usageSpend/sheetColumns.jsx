import React from 'react';
import { Avatar, DeptPill, OutputLink, ShareBar, ToolTag, fmtINR, fmtNum } from './shared';

/**
 * Column definitions for every table tab. Each column has
 * - sort(row): value to sort by (omit = not sortable)
 * - cell(row): what the cell shows
 * - num: right-aligned numeric column (sorts high → low first)
 */
export function buildColumns({ drill, openOutput }) {
  const personCell = (userId, name) => (
    <div className="zrs-person">
      <Avatar name={name} />
      <button type="button" className="zrs-cell-btn" onClick={() => drill({ user: userId })}>
        {name}
      </button>
    </div>
  );
  const clientCell = (name) =>
    name && name !== 'No client' ? (
      <button type="button" className="zrs-cell-btn" onClick={() => drill({ client: name })} title={`Show only ${name}`}>
        {name}
      </button>
    ) : (
      <span className="zrs-muted">{name || '—'}</span>
    );

  return {
    log: [
      {
        key: 'when',
        label: 'When',
        sort: (r) => `${r.date} ${r.time}`,
        td: 'nowrap',
        cell: (r) => (
          <>
            {r.date}
            <span className="sub">{r.time}</span>
          </>
        ),
      },
      { key: 'person', label: 'Person', sort: (r) => r.userName, cell: (r) => personCell(r.userId, r.userName) },
      {
        key: 'tool',
        label: 'Tool',
        sort: (r) => r.tool,
        cell: (r) => <ToolTag name={r.tool} onClick={() => drill({ tool: r.tool })} />,
      },
      {
        key: 'output',
        label: 'Output',
        sort: (r) => r.outputType,
        td: 'zrs-out',
        cell: (r) => (
          <>
            {r.outputType}
            <span className="sub">{r.whatGenerated}</span>
          </>
        ),
      },
      {
        key: 'prompt',
        label: 'Prompt',
        sort: (r) => r.prompt,
        td: 'zrs-prompt',
        title: (r) => r.prompt,
        cell: (r) => r.prompt,
      },
      { key: 'client', label: 'Client / Project', sort: (r) => r.client, td: 'nowrap', cell: (r) => clientCell(r.client) },
      { key: 'department', label: 'Department', sort: (r) => r.department, cell: (r) => <DeptPill name={r.department} /> },
      { key: 'credits', label: 'Credits', num: true, sort: (r) => Number(r.credits || 0), cell: (r) => fmtNum(r.credits) },
      {
        key: 'cost',
        label: 'Cost (₹)',
        num: true,
        td: 'money',
        sort: (r) => Number(r.spendRupees || 0),
        cell: (r) => fmtINR(r.spendRupees),
      },
      {
        key: 'actions',
        label: 'Link',
        sort: (r) => (r.hasOutput ? 1 : 0),
        cell: (r) => <OutputLink row={r} onOpen={openOutput} />,
      },
    ],

    users: [
      { key: 'person', label: 'Person', sort: (u) => u.userName, cell: (u) => personCell(u.userId, u.userName) },
      { key: 'department', label: 'Department', sort: (u) => u.department, cell: (u) => <DeptPill name={u.department} /> },
      {
        key: 'tools',
        label: 'Tools used',
        sort: (u) => (u.toolsUsed || []).length,
        td: 'zrs-wrap',
        cell: (u) => u.toolsUsedText,
      },
      { key: 'client', label: 'Top client', sort: (u) => u.topClient, td: 'nowrap', cell: (u) => clientCell(u.topClient) },
      { key: 'outputs', label: 'Outputs', num: true, sort: (u) => u.generations, cell: (u) => fmtNum(u.generations) },
      { key: 'days', label: 'Active days', num: true, sort: (u) => u.activeDays, cell: (u) => u.activeDays },
      { key: 'credits', label: 'Credits', num: true, sort: (u) => u.credits, cell: (u) => fmtNum(u.credits) },
      { key: 'spent', label: 'Spent', num: true, td: 'money', sort: (u) => u.spendRupees, cell: (u) => fmtINR(u.spendRupees) },
      {
        key: 'perOutput',
        label: 'Per output',
        num: true,
        sort: (u) => u.avgSpendPerOutput,
        cell: (u) => fmtINR(u.avgSpendPerOutput),
      },
      { key: 'share', label: 'Share', sort: (u) => u.sharePct, cell: (u) => <ShareBar pct={u.sharePct} /> },
    ],

    tools: [
      {
        key: 'tool',
        label: 'Tool',
        sort: (t) => t.tool,
        cell: (t) => <ToolTag name={t.tool} onClick={() => drill({ tool: t.tool })} />,
      },
      { key: 'category', label: 'Category', sort: (t) => t.outputCategory, td: 'zrs-muted', cell: (t) => t.outputCategory },
      { key: 'people', label: 'People', num: true, sort: (t) => t.users, cell: (t) => t.users },
      { key: 'topUser', label: 'Top user', sort: (t) => t.topUser, td: 'nowrap', cell: (t) => t.topUser },
      { key: 'outputs', label: 'Outputs', num: true, sort: (t) => t.generations, cell: (t) => fmtNum(t.generations) },
      { key: 'credits', label: 'Credits', num: true, sort: (t) => t.credits, cell: (t) => fmtNum(t.credits) },
      { key: 'usage', label: 'Usage', num: true, sort: (t) => t.itemSpendRupees, cell: (t) => fmtINR(t.itemSpendRupees) },
      {
        key: 'fee',
        label: 'Plan fee',
        num: true,
        sort: (t) => t.subscriptionFeeRupees,
        cell: (t) => fmtINR(t.subscriptionFeeRupees),
      },
      {
        key: 'total',
        label: 'Total',
        num: true,
        td: 'money',
        sort: (t) => t.totalSpendRupees,
        cell: (t) => fmtINR(t.totalSpendRupees),
      },
      {
        key: 'perOutput',
        label: 'Per output',
        num: true,
        sort: (t) => t.avgSpendPerOutput,
        cell: (t) => fmtINR(t.avgSpendPerOutput),
      },
      { key: 'share', label: 'Share', sort: (t) => t.sharePct, cell: (t) => <ShareBar pct={t.sharePct} /> },
    ],

    clients: [
      { key: 'client', label: 'Client / Project', sort: (c) => c.client, cell: (c) => clientCell(c.client) },
      { key: 'people', label: 'People', num: true, sort: (c) => c.users, cell: (c) => c.users },
      { key: 'topUser', label: 'Top user', sort: (c) => c.topUser, td: 'nowrap', cell: (c) => c.topUser },
      {
        key: 'topTool',
        label: 'Top tool',
        sort: (c) => c.topTool,
        cell: (c) => (c.topTool && c.topTool !== '—' ? <ToolTag name={c.topTool} /> : '—'),
      },
      { key: 'outputs', label: 'Outputs', num: true, sort: (c) => c.generations, cell: (c) => fmtNum(c.generations) },
      { key: 'credits', label: 'Credits', num: true, sort: (c) => c.credits, cell: (c) => fmtNum(c.credits) },
      { key: 'spent', label: 'Spent', num: true, td: 'money', sort: (c) => c.spendRupees, cell: (c) => fmtINR(c.spendRupees) },
      {
        key: 'perOutput',
        label: 'Per output',
        num: true,
        sort: (c) => c.avgSpendPerOutput,
        cell: (c) => fmtINR(c.avgSpendPerOutput),
      },
      { key: 'share', label: 'Share', sort: (c) => c.sharePct, cell: (c) => <ShareBar pct={c.sharePct} /> },
    ],

    daily: [
      {
        key: 'date',
        label: 'Date',
        sort: (d) => d.date,
        cell: (d) => (
          <button type="button" className="zrs-cell-btn" onClick={() => drill({ date: d.date })}>
            {d.date}
          </button>
        ),
      },
      { key: 'people', label: 'People', num: true, sort: (d) => d.activeUsers, cell: (d) => d.activeUsers },
      { key: 'outputs', label: 'Outputs', num: true, sort: (d) => d.generations, cell: (d) => fmtNum(d.generations) },
      {
        key: 'topTool',
        label: 'Top tool',
        sort: (d) => d.topTool,
        cell: (d) => (d.topTool ? <ToolTag name={d.topTool} /> : '—'),
      },
      { key: 'credits', label: 'Credits', num: true, sort: (d) => d.credits, cell: (d) => fmtNum(d.credits) },
      { key: 'spent', label: 'Spent', num: true, td: 'money', sort: (d) => d.spendRupees, cell: (d) => fmtINR(d.spendRupees) },
      {
        key: 'perOutput',
        label: 'Per output',
        num: true,
        sort: (d) => d.avgSpendPerOutput,
        cell: (d) => fmtINR(d.avgSpendPerOutput),
      },
    ],

    monthly: [
      { key: 'month', label: 'Month', sort: (m) => m.month, cell: (m) => m.monthLabel },
      { key: 'days', label: 'Active days', num: true, sort: (m) => m.activeDays, cell: (m) => m.activeDays },
      { key: 'people', label: 'People', num: true, sort: (m) => m.activeUsers, cell: (m) => m.activeUsers },
      { key: 'outputs', label: 'Outputs', num: true, sort: (m) => m.generations, cell: (m) => fmtNum(m.generations) },
      {
        key: 'topTool',
        label: 'Top tool',
        sort: (m) => m.topTool,
        cell: (m) => (m.topTool ? <ToolTag name={m.topTool} /> : '—'),
      },
      { key: 'credits', label: 'Credits', num: true, sort: (m) => m.credits, cell: (m) => fmtNum(m.credits) },
      { key: 'spent', label: 'Spent', num: true, td: 'money', sort: (m) => m.spendRupees, cell: (m) => fmtINR(m.spendRupees) },
      {
        key: 'perDay',
        label: 'Per active day',
        num: true,
        sort: (m) => m.avgSpendPerActiveDay,
        cell: (m) => fmtINR(m.avgSpendPerActiveDay),
      },
    ],

    departments: [
      {
        key: 'department',
        label: 'Department',
        sort: (d) => d.department,
        cell: (d) => (
          <button type="button" className="zrs-cell-btn" onClick={() => drill({ department: d.department })}>
            <DeptPill name={d.department} />
          </button>
        ),
      },
      { key: 'people', label: 'People', num: true, sort: (d) => d.users, cell: (d) => d.users },
      { key: 'topUser', label: 'Top user', sort: (d) => d.topUser, td: 'nowrap', cell: (d) => d.topUser },
      {
        key: 'topTool',
        label: 'Top tool',
        sort: (d) => d.topTool,
        cell: (d) => (d.topTool ? <ToolTag name={d.topTool} /> : '—'),
      },
      { key: 'outputs', label: 'Outputs', num: true, sort: (d) => d.generations, cell: (d) => fmtNum(d.generations) },
      { key: 'credits', label: 'Credits', num: true, sort: (d) => d.credits, cell: (d) => fmtNum(d.credits) },
      { key: 'spent', label: 'Spent', num: true, td: 'money', sort: (d) => d.spendRupees, cell: (d) => fmtINR(d.spendRupees) },
      {
        key: 'perPerson',
        label: 'Per person',
        num: true,
        sort: (d) => d.avgSpendPerUser,
        cell: (d) => fmtINR(d.avgSpendPerUser),
      },
      { key: 'share', label: 'Share', sort: (d) => d.sharePct, cell: (d) => <ShareBar pct={d.sharePct} /> },
    ],
  };
}

export const ROW_KEYS = {
  log: (r) => `${r.tool}-${r.recordId}-${r.rowNum}`,
  users: (u) => u.userId ?? u.userName,
  tools: (t) => t.tool,
  clients: (c) => c.client,
  daily: (d) => d.date,
  monthly: (m) => m.month,
  departments: (d) => d.department,
};
