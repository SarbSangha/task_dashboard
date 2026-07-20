import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';
import { ToCanvasButton } from './ExecutiveDashboard';
import { formatNumber, formatFull, initialsOf } from '../utils/format';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const whenLabel = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// Drill-down behind the "Active Users" KPI: who was actually active in the period.
// Clicking a row opens that person's full profile + login timeline.
const ActiveUsersDrill = ({ filters, label, initialSort, onOpenUser, onAddToCanvas }) => {
  const q = useQuery({
    queryKey: ['reports', 'users', 'active', filters],
    queryFn: () => reportsAPI.usersActive({ ...filters, limit: 200 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = q.data?.users || [];
  const dept = filters?.department && filters.department !== 'all' ? ` in ${filters.department}` : '';
  const range = (filters?.start && filters?.end
    ? (filters.start === filters.end ? ` on ${filters.start}` : ` between ${filters.start} and ${filters.end}`)
    : ' in the selected period') + dept;

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'activeDays', label: 'Active days', num: true, render: (r) => formatNumber(r.activeDays) },
    { key: 'sessionMinutes', label: 'Session (min)', num: true, render: (r) => formatFull(r.sessionMinutes) },
    { key: 'activeMinutes', label: 'Active (min)', num: true, render: (r) => formatFull(r.activeMinutes) },
    { key: 'lastSeen', label: 'Last seen', render: (r) => whenLabel(r.lastSeen) },
  ];

  if (q.isError) {
    return (
      <div>
        <SectionHeader title={label ? `${label} — Active Users` : 'Active Users'} subtitle={`Who was active${range}.`} />
        <div className="rpt-error">Failed to load active users: {q.error?.response?.data?.detail || q.error?.message}</div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title={label ? `${label} — Active Users` : 'Active Users'}
        subtitle={`Everyone who logged in or was tracked active${range} — click a person to see their day-by-day session time.`}
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add the active-users table to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-active-users', start: filters?.start, end: filters?.end, department: filters?.department, label }, `${label || 'Active users'} table`)}
          />
        )}
      </SectionHeader>
      {q.isLoading ? (
        <div className="rpt-card" style={{ padding: 16 }}>Loading active users…</div>
      ) : users.length === 0 ? (
        <div className="rpt-card" style={{ padding: 16 }}>No active users in this period.</div>
      ) : (
        <>
          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>{users.length} active users</h3>
            <span className="rpt-card-hint">Click a row for the full profile</span>
          </div>
          <DataTable
            columns={columns}
            rows={users}
            initialSort={initialSort || 'activeDays'}
            onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined}
          />
        </>
      )}
    </div>
  );
};

export default ActiveUsersDrill;
