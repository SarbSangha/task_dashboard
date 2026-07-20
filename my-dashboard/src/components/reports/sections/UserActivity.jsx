import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AreaChart, Area, LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import { ToCanvasButton, DrillableKpi } from './ExecutiveDashboard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatFull, formatDayLabel } from '../utils/format';
import { chartClick as rawChartClick } from '../utils/chartClick';

const STATUS_COLORS = (theme) => ({ active: theme.success, idle: theme.warning, away: theme.info, offline: theme.axis });

const UserActivity = ({ filters, onDrill, onAddToCanvas }) => {
  const theme = useChartTheme();
  const summaryQ = useQuery({ queryKey: ['reports', 'users', 'summary', filters], queryFn: () => reportsAPI.usersSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'users', 'trends', filters], queryFn: () => reportsAPI.usersActivityTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });

  const s = summaryQ.data || {};
  const k = s.kpis || {};
  const trends = trendsQ.data || {};
  const statusColors = STATUS_COLORS(theme);

  if (summaryQ.isError) {
    return (
      <div>
        <SectionHeader title="User Activity" />
        <div className="rpt-error">Failed to load activity: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      </div>
    );
  }

  const topDept = (trends.byDepartment || [])[0];

  // DAU/WAU/MAU are rolling windows anchored on the period end, not the global
  // filter range — the drill has to use the same window or it won't match.
  const periodEnd = s.period?.end;
  const back = (days) => {
    if (!periodEnd) return undefined;
    const d = new Date(`${periodEnd}T00:00:00`);
    d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  };
  const win = (days) => (periodEnd ? { start: back(days), end: periodEnd } : {});

  // Hoisted so the click handlers can resolve the clicked datum by index.
  const dailyData = trends.daily || [];
  const deptData = (trends.byDepartment || []).slice(0, 8);

  const chartClick = (data, pick) => rawChartClick(data, pick, !!onDrill);

  return (
    <div>
      <SectionHeader
        title="User Activity"
        subtitle="Real presence analytics from session tracking — active users, engagement cadence and session depth across the workforce."
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move KPIs to canvas"
            title="Add the user activity KPIs to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-users' }, 'User activity KPIs')}
          />
        )}
      </SectionHeader>

      <InsightBanner
        recommendation={
          (s.stickiness ?? 0) < 30
            ? 'Stickiness (DAU/MAU) is low — usage is occasional rather than habitual. Focus on daily-value workflows and reminders.'
            : 'Healthy daily engagement — protect the habit and extend it to lagging departments.'
        }
      >
        <b>{formatNumber(k.activeUsers?.value)}</b> people were active this period
        {k.activeUsers?.deltaPct != null && (<> (<b>{k.activeUsers.deltaPct > 0 ? '+' : ''}{k.activeUsers.deltaPct}%</b> vs prior)</>)}.
        Daily active is <b>{formatNumber(s.dau)}</b>, weekly <b>{formatNumber(s.wau)}</b>, monthly <b>{formatNumber(s.mau)}</b>{' '}
        — a stickiness of <b>{s.stickiness ?? 0}%</b>. {topDept && <>Most active team: <b>{topDept.department}</b>.</>}
      </InsightBanner>

      {/* Each card drills to who those people are, then per-person daily session time. */}
      <div className="rpt-kpi-grid">
        <DrillableKpi label="Active Users" metric={k.activeUsers} onDrill={onDrill} view="active-users" hint="See who was active" />
        <DrillableKpi label="Daily Active (DAU)" metric={{ value: s.dau, deltaPct: null, direction: 'flat' }} onDrill={onDrill} view="active-users" ctx={{ ...win(0), label: 'Daily Active' }} hint="See today's active users" />
        <DrillableKpi label="Weekly Active (WAU)" metric={{ value: s.wau, deltaPct: null, direction: 'flat' }} onDrill={onDrill} view="active-users" ctx={{ ...win(6), label: 'Weekly Active' }} hint="See the last 7 days' active users" />
        <DrillableKpi label="Monthly Active (MAU)" metric={{ value: s.mau, deltaPct: null, direction: 'flat' }} onDrill={onDrill} view="active-users" ctx={{ ...win(29), label: 'Monthly Active' }} hint="See the last 30 days' active users" />
        <DrillableKpi label="Avg Session" metric={k.avgSessionMinutes} format="full" onDrill={onDrill} view="active-users" ctx={{ sort: 'sessionMinutes', label: 'Session Time' }} hint="See session time per person" />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="Daily active users" blockKind="live-ua-daily" onAddToCanvas={onAddToCanvas} hint={onDrill ? 'Distinct users / day · click a day' : 'Distinct users / day'} height={250}>
          <AreaChart
            data={dailyData}
            margin={{ top: 8, right: 12, bottom: 0, left: -8 }}
            onClick={chartClick(dailyData, (d) => d.date && onDrill('active-users', { start: d.date, end: d.date, label: 'Active on' }))}
            style={onDrill ? { cursor: 'pointer' } : undefined}
          >
            <defs>
              <linearGradient id="uaActive" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.primary} stopOpacity={0.42} />
                <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
            <Area type="monotone" name="Active users" dataKey="activeUsers" stroke={theme.primary} strokeWidth={2} fill="url(#uaActive)" isAnimationActive={false} />
          </AreaChart>
        </ChartFrame>

        <ChartFrame title="Avg session duration" blockKind="live-ua-session" onAddToCanvas={onAddToCanvas} hint={onDrill ? 'Minutes / day · click a day' : 'Minutes / day'} height={250}>
          <LineChart
            data={dailyData}
            margin={{ top: 8, right: 12, bottom: 0, left: -8 }}
            onClick={chartClick(dailyData, (d) => d.date && onDrill('active-users', { start: d.date, end: d.date, sort: 'sessionMinutes', label: 'Session time on' }))}
            style={onDrill ? { cursor: 'pointer' } : undefined}
          >
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={(v) => `${formatFull(v)} min`} />} />
            <Line type="monotone" name="Avg session (min)" dataKey="avgSessionMin" stroke={theme.info} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartFrame>

        <ChartFrame title="Active users by department" blockKind="live-ua-dept" onAddToCanvas={onAddToCanvas} hint={onDrill ? 'Distinct users · click a bar' : 'Distinct users'} height={240}>
          <BarChart
            data={deptData}
            layout="vertical"
            margin={{ top: 4, right: 16, bottom: 0, left: 8 }}
            onClick={chartClick(deptData, (d) => d.department && onDrill('active-users', { department: d.department, label: d.department }))}
            style={onDrill ? { cursor: 'pointer' } : undefined}
          >
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
            <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={96} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
            <Bar dataKey="activeUsers" name="Active users" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Current status mix" hint="Latest day" height={240}>
          <PieChart>
            <Pie data={trends.statusMix || []} dataKey="count" nameKey="status" innerRadius={52} outerRadius={82} paddingAngle={2} isAnimationActive={false}>
              {(trends.statusMix || []).map((entry, i) => <Cell key={i} fill={statusColors[entry.status] || theme.series[i % theme.series.length]} />)}
            </Pie>
            <Legend wrapperStyle={{ fontSize: 12, color: theme.text, textTransform: 'capitalize' }} />
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ChartFrame>
      </div>
    </div>
  );
};

export default UserActivity;
