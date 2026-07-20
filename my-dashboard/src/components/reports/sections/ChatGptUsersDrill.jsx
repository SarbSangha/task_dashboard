import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const stamp = (iso) => (iso
  ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', year: '2-digit', hour: '2-digit', minute: '2-digit' })
  : '—');

// Drill behind the ChatGPT user count: who is actually using ChatGPT, with
// conversation, prompt and message volume plus their activity window.
const ChatGptUsersDrill = ({ filters, onOpenUser, onAddToCanvas }) => {
  const q = useQuery({
    queryKey: ['reports', 'chatgpt', 'users', filters],
    queryFn: () => reportsAPI.chatgptUsers({ ...filters, limit: 200 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = q.data?.users || [];
  const totals = q.data?.totals || {};

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'conversations', label: 'Conversations', num: true, render: (r) => formatNumber(r.conversations) },
    { key: 'prompts', label: 'Prompts', num: true, render: (r) => formatNumber(r.prompts) },
    { key: 'responses', label: 'Responses', num: true, render: (r) => formatNumber(r.responses) },
    { key: 'messages', label: 'Messages', num: true, render: (r) => formatNumber(r.messages) },
    { key: 'avgDepth', label: 'Avg depth', num: true, render: (r) => formatFull(r.avgDepth) },
    { key: 'activeDays', label: 'Active days', num: true, render: (r) => formatNumber(r.activeDays) },
    { key: 'firstActive', label: 'First used', render: (r) => stamp(r.firstActive) },
    { key: 'lastActive', label: 'Last used', render: (r) => stamp(r.lastActive) },
  ];

  if (q.isError) {
    return (
      <div>
        <SectionHeader title="ChatGPT Users" subtitle="Who is using ChatGPT in this period." />
        <div className="rpt-error">Failed to load ChatGPT users: {q.error?.response?.data?.detail || q.error?.message}</div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title="ChatGPT Users"
        subtitle="Everyone using ChatGPT in the selected period — conversations started, prompts sent, responses received and when they were active."
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add the ChatGPT user table to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-cg-users' }, 'ChatGPT users')}
          />
        )}
      </SectionHeader>

      {q.isLoading ? (
        <div className="rpt-card" style={{ padding: 16 }}>Loading ChatGPT users…</div>
      ) : users.length === 0 ? (
        <div className="rpt-card" style={{ padding: 16 }}>No ChatGPT activity in this period.</div>
      ) : (
        <>
          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>
              {formatNumber(totals.users)} user{totals.users === 1 ? '' : 's'}
            </h3>
            <span className="rpt-card-hint">
              {formatNumber(totals.conversations)} conversations · {formatNumber(totals.prompts)} prompts · {formatNumber(totals.messages)} messages
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={users}
            initialSort="conversations"
            onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined}
          />
        </>
      )}
    </div>
  );
};

export default ChatGptUsersDrill;
