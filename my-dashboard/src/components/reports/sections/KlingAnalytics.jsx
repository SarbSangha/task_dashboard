import React, { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import DataTable from '../primitives/DataTable';
import KlingAccountsPanel from './KlingAccountsPanel';
import { formatNumber, formatFull, formatDayLabel, formatHour, initialsOf } from '../utils/format';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const successPill = (rate) => {
  const cls = rate >= 90 ? 'good' : rate >= 70 ? 'warn' : 'bad';
  return <span className={`rpt-pill ${cls}`}>{rate}%</span>;
};

const KlingAnalytics = ({ filters, onOpenUser }) => {
  const theme = useChartTheme();

  const summaryQ = useQuery({ queryKey: ['reports', 'kling', 'summary', filters], queryFn: () => reportsAPI.klingSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'kling', 'trends', filters], queryFn: () => reportsAPI.klingTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const usersQ = useQuery({ queryKey: ['reports', 'kling', 'users', filters], queryFn: () => reportsAPI.klingUsers({ ...filters, limit: 100 }), placeholderData: keepPreviousData, staleTime: 60_000 });

  const k = summaryQ.data?.kpis || {};
  const trends = trendsQ.data || {};
  const users = usersQ.data?.users || [];

  const topUser = users[0];
  const topDept = useMemo(() => {
    const list = trends.byDepartment || [];
    const total = list.reduce((s, d) => s + d.videos, 0);
    if (!list.length || !total) return null;
    return { ...list[0], share: Math.round((list[0].videos / total) * 100) };
  }, [trends.byDepartment]);

  const columns = [
    { key: 'rank', label: '#', num: false, sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'videos', label: 'Videos', num: true, render: (r) => formatNumber(r.videos) },
    { key: 'successRate', label: 'Success', num: true, render: (r) => successPill(r.successRate) },
    { key: 'credits', label: 'Credits', num: true, render: (r) => formatFull(r.credits) },
  ];

  const dateLabel = filters?.start && filters?.end ? `${filters.start} → ${filters.end}` : 'selected range';

  return (
    <div>
      <SectionHeader
        title="Kling Intelligence"
        subtitle={`Video generation analytics for Kling AI across the ${dateLabel}. Click any creator to open their detailed profile.`}
      />

      {summaryQ.isError ? (
        <div className="rpt-error">Failed to load Kling summary: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      ) : (
        <>
          {topUser && (
            <InsightBanner
              recommendation={
                topDept
                  ? `${topDept.department} drives ${topDept.share}% of Kling output — consider a dedicated credit allocation and a Kling champion for that team.`
                  : 'Broaden Kling adoption beyond the current top creators to reduce single-user dependency.'
              }
            >
              Kling produced <b>{formatFull(k.totalVideos?.value)}</b> videos{' '}
              {k.totalVideos?.deltaPct != null && (<>(<b>{k.totalVideos.deltaPct > 0 ? '+' : ''}{k.totalVideos.deltaPct}%</b> vs prior period) </>)}
              from <b>{formatNumber(k.uniqueUsers?.value)}</b> creators.{' '}
              <b>{topUser.name}</b> leads with <b>{formatNumber(topUser.videos)}</b> videos
              {topDept && <> and <b>{topDept.department}</b> generated <b>{topDept.share}%</b> of all output</>}.
            </InsightBanner>
          )}

          <div className="rpt-kpi-grid">
            <KpiCard label="Total Kling Videos" metric={k.totalVideos} />
            <KpiCard label="Unique Kling Users" metric={k.uniqueUsers} />
            <KpiCard label="Avg Videos / User" metric={k.avgVideosPerUser} format="full" />
            <KpiCard label="Success Rate" metric={k.successRate} format="pct" />
            <KpiCard label="Credits Consumed" metric={k.creditsConsumed} />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Video generation trend" hint="Daily" height={250}>
              <AreaChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="klingTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.primary} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
                <Area type="monotone" name="Videos" dataKey="videos" stroke={theme.primary} strokeWidth={2} fill="url(#klingTrend)" isAnimationActive={false} />
              </AreaChart>
            </ChartFrame>

            <ChartFrame title="Generation by department" hint="Top teams" height={250}>
              <BarChart data={(trends.byDepartment || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={theme.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
                <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={96} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
                <Bar dataKey="videos" name="Videos" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Peak usage hours" hint="Videos by hour of day" height={230}>
              <BarChart data={trends.byHour || []} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="hour" tickFormatter={formatHour} tick={{ fill: theme.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: theme.grid }} interval={1} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={34} tickFormatter={formatNumber} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip labelFormatter={(h) => `${formatHour(h)} hour`} />} />
                <Bar dataKey="videos" name="Videos" fill={theme.info} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Success vs failure" hint="Generation outcomes" height={230}>
              <PieChart>
                <Pie
                  data={trends.successVsFailure || []}
                  dataKey="count" nameKey="label"
                  innerRadius={55} outerRadius={82} paddingAngle={2} isAnimationActive={false}
                >
                  {(trends.successVsFailure || []).map((entry, i) => (
                    <Cell key={i} fill={entry.label === 'Success' ? theme.success : theme.danger} />
                  ))}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12, color: theme.text }} />
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ChartFrame>
          </div>

          <div style={{ marginTop: 20 }}>
            <div className="rpt-card-head">
              <h3 className="rpt-card-title" style={{ fontSize: 14 }}>Creator leaderboard</h3>
              <span className="rpt-card-hint">{users.length} creators · click a row for the full profile</span>
            </div>
            <DataTable
              columns={columns}
              rows={users}
              initialSort="videos"
              onRowClick={(row) => onOpenUser?.(row.userId, row.name)}
            />
          </div>
        </>
      )}

      <KlingAccountsPanel filters={filters} />
    </div>
  );
};

export default KlingAnalytics;
