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
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatFull, formatDayLabel } from '../utils/format';

const STATUS_COLORS = (theme) => ({ active: theme.success, idle: theme.warning, away: theme.info, offline: theme.axis });

const UserActivity = ({ filters }) => {
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

  return (
    <div>
      <SectionHeader
        title="User Activity"
        subtitle="Real presence analytics from session tracking — active users, engagement cadence and session depth across the workforce."
      />

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

      <div className="rpt-kpi-grid">
        <KpiCard label="Active Users" metric={k.activeUsers} />
        <KpiCard label="Daily Active (DAU)" metric={{ value: s.dau, deltaPct: null, direction: 'flat' }} />
        <KpiCard label="Weekly Active (WAU)" metric={{ value: s.wau, deltaPct: null, direction: 'flat' }} />
        <KpiCard label="Monthly Active (MAU)" metric={{ value: s.mau, deltaPct: null, direction: 'flat' }} />
        <KpiCard label="Avg Session" metric={k.avgSessionMinutes} format="full" />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="Daily active users" hint="Distinct users / day" height={250}>
          <AreaChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
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

        <ChartFrame title="Avg session duration" hint="Minutes / day" height={250}>
          <LineChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={(v) => `${formatFull(v)} min`} />} />
            <Line type="monotone" name="Avg session (min)" dataKey="avgSessionMin" stroke={theme.info} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartFrame>

        <ChartFrame title="Active users by department" hint="Distinct users" height={240}>
          <BarChart data={(trends.byDepartment || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
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
