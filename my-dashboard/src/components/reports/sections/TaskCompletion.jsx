import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, Cell } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatDayLabel } from '../utils/format';

const STATUS_TONE = (theme) => ({
  completed: theme.success, approved: theme.success, rejected: theme.danger, cancelled: theme.danger,
  need_improvement: theme.warning, under_review: theme.warning, in_progress: theme.primary, submitted: theme.info,
});
const prettyStatus = (s) => `${s}`.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());

const TaskCompletion = ({ filters }) => {
  const theme = useChartTheme();
  const summaryQ = useQuery({ queryKey: ['reports', 'tasks', 'summary', filters], queryFn: () => reportsAPI.tasksSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'tasks', 'trends', filters], queryFn: () => reportsAPI.tasksTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const bottQ = useQuery({ queryKey: ['reports', 'tasks', 'bottlenecks', filters], queryFn: () => reportsAPI.tasksBottlenecks(filters), placeholderData: keepPreviousData, staleTime: 60_000 });

  const k = summaryQ.data?.kpis || {};
  const trends = trendsQ.data || {};
  const statusTone = STATUS_TONE(theme);

  if (summaryQ.isError) {
    return (
      <div>
        <SectionHeader title="Completion Analysis" />
        <div className="rpt-error">Failed to load: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      </div>
    );
  }

  const statusData = (trends.statusDistribution || []).map((s) => ({ ...s, label: prettyStatus(s.status) }));

  return (
    <div>
      <SectionHeader
        title="Completion Analysis"
        subtitle="Are tasks getting finished — and where does work stall, slip or get rejected? Created-versus-completed flow, status mix and delivery reliability."
      />

      <InsightBanner
        recommendation={
          (bottQ.data?.reworkRate ?? 0) > 15
            ? `Rework/rejection is high (${bottQ.data.reworkRate}%). Tighten first-pass quality and review the most-rejected task types.`
            : 'Flow is balanced — keep created and completed volumes aligned to avoid backlog growth.'
        }
      >
        Completion rate is <b>{k.completionRate?.value ?? 0}%</b> with <b>{k.onTimeRate?.value ?? 0}%</b> delivered on time.{' '}
        <b>{formatNumber(summaryQ.data?.tasksCreated)}</b> tasks were created this period, and rework/rejection sits at{' '}
        <b>{bottQ.data?.reworkRate ?? 0}%</b>.
      </InsightBanner>

      <div className="rpt-kpi-grid">
        <KpiCard label="Completion Rate" metric={k.completionRate} format="pct" />
        <KpiCard label="Tasks Created" metric={{ value: summaryQ.data?.tasksCreated, deltaPct: null, direction: 'flat' }} />
        <KpiCard label="On-time Rate" metric={k.onTimeRate} format="pct" />
        <KpiCard label="Rework / Rejection" metric={{ value: bottQ.data?.reworkRate, unit: '%', deltaPct: null, direction: 'flat' }} format="pct" />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="Created vs completed" hint="Daily flow" height={250}>
          <LineChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
            <Legend wrapperStyle={{ fontSize: 11, color: theme.text }} />
            <Line type="monotone" name="Created" dataKey="created" stroke={theme.info} strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" name="Completed" dataKey="completed" stroke={theme.success} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartFrame>

        <ChartFrame title="Status distribution" hint="Tasks created in range" height={250}>
          <BarChart data={statusData} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
            <YAxis type="category" dataKey="label" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={116} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
            <Bar dataKey="count" name="Tasks" radius={[0, 5, 5, 0]} isAnimationActive={false}>
              {statusData.map((entry, i) => <Cell key={i} fill={statusTone[entry.status] || theme.axis} />)}
            </Bar>
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Completion rate by priority" hint="High priority should not lag" height={240}>
          <BarChart data={trends.byPriority || []} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="priority" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} tickFormatter={prettyStatus} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={(v) => `${v}%`} />} />
            <Bar dataKey="completionRate" name="Completion rate" fill={theme.primary} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Volume by priority" hint="Created vs completed" height={240}>
          <BarChart data={trends.byPriority || []} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="priority" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} tickFormatter={prettyStatus} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
            <Legend wrapperStyle={{ fontSize: 11, color: theme.text }} />
            <Bar dataKey="created" name="Created" fill={theme.info} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            <Bar dataKey="completed" name="Completed" fill={theme.success} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>
      </div>
    </div>
  );
};

export default TaskCompletion;
