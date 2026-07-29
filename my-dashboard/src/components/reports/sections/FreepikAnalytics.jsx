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
import { ToCanvasButton, DrillableKpi } from './ExecutiveDashboard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, formatDayLabel, formatHour, initialsOf } from '../utils/format';
import { chartClick as rawChartClick } from '../utils/chartClick';

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

// Mirrors KlingAnalytics.jsx's shape - Freepik has real per-employee
// attribution (owner_user_id), unlike Kling's shared-login account, so there
// is no equivalent of KlingAccountsPanel here. It reports two distinct
// credit figures (an actual *charged* deduction vs. a pre-generation
// *estimated* cost - see FreepikGeneration.credits_charged/credits_estimated),
// so both get their own KPI card and leaderboard column rather than being
// collapsed into one number the way Kling's single credit figure is.
const FreepikAnalytics = ({ filters, onOpenUser, onDrill, onAddToCanvas }) => {
  const theme = useChartTheme();

  const summaryQ = useQuery({ queryKey: ['reports', 'freepik', 'summary', filters], queryFn: () => reportsAPI.freepikSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'freepik', 'trends', filters], queryFn: () => reportsAPI.freepikTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const usersQ = useQuery({ queryKey: ['reports', 'freepik', 'users', filters], queryFn: () => reportsAPI.freepikUsers({ ...filters, limit: 100 }), placeholderData: keepPreviousData, staleTime: 60_000 });

  const k = summaryQ.data?.kpis || {};
  const mediaBreakdown = summaryQ.data?.mediaBreakdown || [];
  const trends = trendsQ.data || {};
  const users = usersQ.data?.users || [];

  const topUser = users[0];
  const topDept = useMemo(() => {
    const list = trends.byDepartment || [];
    const total = list.reduce((s, d) => s + d.generations, 0);
    if (!list.length || !total) return null;
    return { ...list[0], share: Math.round((list[0].generations / total) * 100) };
  }, [trends.byDepartment]);

  const columns = [
    { key: 'rank', label: '#', num: false, sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'generations', label: 'Generations', num: true, render: (r) => formatNumber(r.generations) },
    { key: 'successRate', label: 'Success', num: true, render: (r) => successPill(r.successRate) },
    { key: 'creditsCharged', label: 'Credits Charged', num: true, render: (r) => formatFull(r.creditsCharged) },
    { key: 'creditsEstimated', label: 'Credits Estimated', num: true, render: (r) => formatFull(r.creditsEstimated) },
  ];

  const dateLabel = filters?.start && filters?.end ? `${filters.start} → ${filters.end}` : 'selected range';

  const dailyData = trends.daily || [];
  const deptData = (trends.byDepartment || []).slice(0, 8);
  const hourData = trends.byHour || [];

  const chartClick = (data, pick) => rawChartClick(data, pick, !!onDrill);

  return (
    <div>
      <SectionHeader
        title="Freepik Intelligence"
        subtitle={`Image/video generation analytics for Freepik & Magnific across the ${dateLabel}. Click any creator to open their detailed profile.`}
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move KPIs to canvas"
            title="Add the Freepik summary KPIs to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-freepik' }, 'Freepik summary KPIs')}
          />
        )}
      </SectionHeader>

      {summaryQ.isError ? (
        <div className="rpt-error">Failed to load Freepik summary: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      ) : (
        <>
          {topUser && (
            <InsightBanner
              recommendation={
                topDept
                  ? `${topDept.department} drives ${topDept.share}% of Freepik output — consider a dedicated credit allocation and a Freepik champion for that team.`
                  : 'Broaden Freepik adoption beyond the current top creators to reduce single-user dependency.'
              }
            >
              Freepik produced <b>{formatFull(k.totalGenerations?.value)}</b> generations{' '}
              {k.totalGenerations?.deltaPct != null && (<>(<b>{k.totalGenerations.deltaPct > 0 ? '+' : ''}{k.totalGenerations.deltaPct}%</b> vs prior period) </>)}
              from <b>{formatNumber(k.uniqueUsers?.value)}</b> creators.{' '}
              <b>{topUser.name}</b> leads with <b>{formatNumber(topUser.generations)}</b> generations
              {topDept && <> and <b>{topDept.department}</b> generated <b>{topDept.share}%</b> of all output</>}.
            </InsightBanner>
          )}

          <div className="rpt-kpi-grid">
            <DrillableKpi label="Total Generations" metric={k.totalGenerations} onDrill={onDrill} view="contributors:generations:freepik" hint="See who generated" />
            <DrillableKpi label="Unique Users" metric={k.uniqueUsers} onDrill={onDrill} view="contributors:generations:freepik" hint="See the creators" />
            <KpiCard label="Avg Generations / User" metric={k.avgGenerationsPerUser} format="full" />
            <KpiCard label="Success Rate" metric={k.successRate} format="pct" />
            <DrillableKpi label="Credits Charged" metric={k.creditsCharged} onDrill={onDrill} view="contributors:cost:freepik" hint="See who spent the credits" />
            <KpiCard label="Credits Estimated" metric={k.creditsEstimated} format="full" />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Generation trend" blockKind="live-freepik-trend" onAddToCanvas={onAddToCanvas} hint={onDrill ? 'Daily · click a day' : 'Daily'} height={250}>
              <AreaChart
                data={dailyData}
                margin={{ top: 8, right: 12, bottom: 0, left: -8 }}
                onClick={chartClick(dailyData, (d) => d.date && onDrill('contributors:generations:freepik', { date: d.date }))}
                style={onDrill ? { cursor: 'pointer' } : undefined}
              >
                <defs>
                  <linearGradient id="freepikTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.primary} stopOpacity={0.45} />
                    <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
                <Area type="monotone" name="Generations" dataKey="generations" stroke={theme.primary} strokeWidth={2} fill="url(#freepikTrend)" isAnimationActive={false} />
              </AreaChart>
            </ChartFrame>

            <ChartFrame title="Generation by department" blockKind="live-freepik-dept" onAddToCanvas={onAddToCanvas} hint={onDrill ? 'Top teams · click a bar' : 'Top teams'} height={250}>
              <BarChart
                data={deptData}
                layout="vertical"
                margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
                onClick={chartClick(deptData, (d) => d.department && onDrill('contributors:generations:freepik', { department: d.department }))}
                style={onDrill ? { cursor: 'pointer' } : undefined}
              >
                <CartesianGrid stroke={theme.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
                <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={96} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
                <Bar dataKey="generations" name="Generations" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Peak usage hours" blockKind="live-freepik-hours" onAddToCanvas={onAddToCanvas} hint={onDrill ? 'By hour of day (IST) · click a bar' : 'By hour of day (IST)'} height={230}>
              <BarChart
                data={hourData}
                margin={{ top: 4, right: 12, bottom: 0, left: -8 }}
                onClick={chartClick(hourData, (d) => d.hour != null && onDrill('contributors:generations:freepik', { hour: d.hour }))}
                style={onDrill ? { cursor: 'pointer' } : undefined}
              >
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="hour" tickFormatter={formatHour} tick={{ fill: theme.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: theme.grid }} interval={1} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={34} tickFormatter={formatNumber} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip labelFormatter={(h) => `${formatHour(h)} IST`} />} />
                <Bar dataKey="generations" name="Generations" fill={theme.info} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Images vs videos" blockKind="live-freepik-media" onAddToCanvas={onAddToCanvas} hint="Output type split" height={230}>
              <PieChart>
                <Pie
                  data={mediaBreakdown}
                  dataKey="count" nameKey="kind"
                  innerRadius={55} outerRadius={82} paddingAngle={2} isAnimationActive={false}
                >
                  {mediaBreakdown.map((entry, i) => (
                    <Cell key={i} fill={entry.kind === 'video' ? theme.indigo : theme.info} />
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
              initialSort="generations"
              onRowClick={(row) => onOpenUser?.(row.userId, row.name)}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default FreepikAnalytics;
