import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';

export const PROVIDER_LABELS = { kling: 'Kling', chatgpt: 'ChatGPT' };

// Which KPI card opened this drill, and how to describe it.
export const CONTRIBUTOR_METRICS = {
  generations: {
    title: 'AI Generations',
    subtitle: 'Who produced the generations in this period — click a person for their login timeline, then a date for that day.',
    sortKey: 'generations',
  },
  videos: {
    title: 'Videos Generated',
    subtitle: 'Who produced the videos in this period — click a person for their login timeline, then a date for that day.',
    sortKey: 'videos',
  },
  images: {
    title: 'Images Generated',
    subtitle: 'Who produced the images in this period — click a person for their login timeline, then a date for that day.',
    sortKey: 'images',
  },
  credits: {
    title: 'Credit Consumption',
    subtitle: 'Who consumed the credits in this period — click a person for their day-by-day spend, then a date for the individual generations.',
    sortKey: 'credits',
  },
  cost: {
    title: 'AI Cost',
    subtitle: 'Who consumed the credits in this period — click a person for their login timeline, then a date for that day.',
    sortKey: 'credits',
  },
};

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

// Drill behind the output KPIs (generations, videos, images, cost): who produced them.
// Every row carries all four measures, so the columns stay the same whichever
// card you came from — only the emphasis and sort change.
const hourLabel = (h) => {
  const n = Number(h);
  if (n === 0) return '12am';
  if (n === 12) return '12pm';
  return n < 12 ? `${n}am` : `${n - 12}pm`;
};
const dayLabel = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' })
  : '');

const ContributorsDrill = ({ metric = 'generations', provider, date, hour, department, filters, onOpenUser, onAddToCanvas }) => {
  const base = CONTRIBUTOR_METRICS[metric] || CONTRIBUTOR_METRICS.generations;
  const scope = [
    provider ? PROVIDER_LABELS[provider] || provider : null,
    department || null,
  ].filter(Boolean).join(' · ');
  const when = date ? dayLabel(date) : hour != null ? `${hourLabel(hour)}–${hourLabel((Number(hour) + 1) % 24)} IST` : '';
  const meta = {
    ...base,
    title: [scope, base.title].filter(Boolean).join(' · '),
    subtitle: when
      ? `Who produced the output ${date ? 'on' : 'during the'} ${when}${department ? ` in ${department}` : ''} — click a person${date ? ' to see exactly what they generated that day' : ' for their generation timeline'}.`
      : base.subtitle,
  };

  // A day/hour/department click narrows the same endpoint rather than adding new ones.
  const scopedFilters = {
    ...filters,
    ...(date ? { start: date, end: date } : {}),
    ...(department ? { department } : {}),
  };

  const q = useQuery({
    queryKey: ['reports', 'users', 'contributors', metric, provider || 'all', date || '', hour ?? '', department || '', scopedFilters],
    queryFn: () => reportsAPI.usersContributors({ ...scopedFilters, metric, provider, hour, limit: 200 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = q.data?.users || [];
  const totals = q.data?.totals || {};

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'generations', label: 'Generations', num: true, render: (r) => formatNumber(r.generations) },
    { key: 'videos', label: 'Videos', num: true, render: (r) => formatNumber(r.videos) },
    { key: 'images', label: 'Images', num: true, render: (r) => formatNumber(r.images) },
    { key: 'credits', label: 'Credits', num: true, render: (r) => formatFull(r.credits) },
    { key: 'activeDays', label: 'Active days', num: true, render: (r) => formatNumber(r.activeDays) },
    { key: 'sharePct', label: 'Share', num: true, render: (r) => `${r.sharePct}%` },
  ];

  if (q.isError) {
    return (
      <div>
        <SectionHeader title={meta.title} subtitle={meta.subtitle} />
        <div className="rpt-error">Failed to load contributors: {q.error?.response?.data?.detail || q.error?.message}</div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader title={meta.title} subtitle={meta.subtitle}>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title={`Add the ${meta.title.toLowerCase()} contributor table to the Report Builder`}
            onClick={() => onAddToCanvas({ kind: 'live-contributors', metric, provider, date, hour, department, metricTitle: meta.title }, `${meta.title} contributors`)}
          />
        )}
      </SectionHeader>

      {q.isLoading ? (
        <div className="rpt-card" style={{ padding: 16 }}>Loading contributors…</div>
      ) : users.length === 0 ? (
        <div className="rpt-card" style={{ padding: 16 }}>No generations recorded in this period.</div>
      ) : (
        <>
          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>
              {users.length} contributor{users.length === 1 ? '' : 's'}
            </h3>
            <span className="rpt-card-hint">
              {formatNumber(totals.generations)} generations · {formatFull(totals.credits)} credits
              {when ? ` · ${when}` : ''} · click a row for the detail
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={users}
            initialSort={meta.sortKey}
            onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined}
          />
        </>
      )}
    </div>
  );
};

export default ContributorsDrill;
