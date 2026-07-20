import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';
import { formatNumber, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const dayLabel = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
  : '');

// Drill behind the task KPIs and charts: per-person load, split into what they
// CREATED (authored) and what they RECEIVED (were assigned), each with its own
// completed count so raisers and finishers are distinguishable.
const TaskContributorsDrill = ({ date, priority, filters, onOpenUser, onAddToCanvas }) => {
  const q = useQuery({
    queryKey: ['reports', 'tasks', 'contributors', date || '', priority || 'all', filters],
    queryFn: () => reportsAPI.tasksContributors({ ...filters, date, priority, limit: 200 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = q.data?.users || [];
  const totals = q.data?.totals || {};
  const scope = [
    priority && priority !== 'all' ? `${priority} priority` : null,
    date ? dayLabel(date) : null,
  ].filter(Boolean).join(' · ');

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'created', label: 'Created', num: true, render: (r) => formatNumber(r.created) },
    { key: 'createdCompleted', label: 'Created · done', num: true, render: (r) => formatNumber(r.createdCompleted) },
    { key: 'received', label: 'Received', num: true, render: (r) => formatNumber(r.received) },
    { key: 'receivedCompleted', label: 'Received · done', num: true, render: (r) => formatNumber(r.receivedCompleted) },
    {
      key: 'completionRate',
      label: 'Completion',
      num: true,
      render: (r) => {
        const cls = r.completionRate >= 70 ? 'good' : r.completionRate >= 40 ? 'warn' : 'bad';
        return r.received ? <span className={`rpt-pill ${cls}`}>{r.completionRate}%</span> : <span className="rpt-pill muted">—</span>;
      },
    },
  ];

  const title = scope ? `Task Load — ${scope}` : 'Task Load by Person';

  if (q.isError) {
    return (
      <div>
        <SectionHeader title={title} />
        <div className="rpt-error">Failed to load task contributors: {q.error?.response?.data?.detail || q.error?.message}</div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title={title}
        subtitle="Tasks each person raised versus tasks assigned to them, with how many of each are complete. Completion % is on received work — what they were asked to finish."
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add this task-load table to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-task-contributors', date, priority, scopeLabel: scope }, `Task load${scope ? ` — ${scope}` : ''}`)}
          />
        )}
      </SectionHeader>

      {q.isLoading ? (
        <div className="rpt-card" style={{ padding: 16 }}>Loading task load…</div>
      ) : users.length === 0 ? (
        <div className="rpt-card" style={{ padding: 16 }}>No tasks in this scope.</div>
      ) : (
        <>
          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>{users.length} people</h3>
            <span className="rpt-card-hint">
              {formatNumber(totals.created)} tasks created · {formatNumber(totals.completed)} completed ({totals.completionRate}%)
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={users}
            initialSort="created"
            onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined}
          />
        </>
      )}
    </div>
  );
};

export default TaskContributorsDrill;
