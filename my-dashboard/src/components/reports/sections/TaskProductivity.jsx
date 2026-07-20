import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatFull, formatDayLabel } from '../utils/format';

const TaskProductivity = ({ filters, onAddToCanvas }) => {
  const theme = useChartTheme();
  const summaryQ = useQuery({ queryKey: ['reports', 'tasks', 'summary', filters], queryFn: () => reportsAPI.tasksSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'tasks', 'trends', filters], queryFn: () => reportsAPI.tasksTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });

  const k = summaryQ.data?.kpis || {};
  const trends = trendsQ.data || {};

  if (summaryQ.isError) {
    return (
      <div>
        <SectionHeader title="Productivity Analysis" />
        <div className="rpt-error">Failed to load tasks: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      </div>
    );
  }

  const topDept = (trends.byDepartment || [])[0];

  return (
    <div>
      <SectionHeader
        title="Productivity Analysis"
        subtitle="Task throughput, cycle time and delivery efficiency across the organisation — the business-outcome layer of AI adoption."
      />

      <InsightBanner
        recommendation={
          (k.onTimeRate?.value ?? 100) < 70
            ? 'On-time delivery is under pressure — review the slowest stages in Bottlenecks and rebalance capacity.'
            : 'Delivery is healthy — sustain throughput and share the leading department’s practices.'
        }
      >
        <b>{formatFull(k.tasksCompleted?.value)}</b> tasks completed this period{' '}
        {k.tasksCompleted?.deltaPct != null && (<>(<b>{k.tasksCompleted.deltaPct > 0 ? '+' : ''}{k.tasksCompleted.deltaPct}%</b>) </>)}
        at a <b>{k.completionRate?.value ?? 0}%</b> completion rate and <b>{formatFull(k.avgCycleHours?.value)}h</b> average cycle time.{' '}
        {topDept && <>Most productive team: <b>{topDept.department}</b> ({formatNumber(topDept.completed)} done).</>}
      </InsightBanner>

      <div className="rpt-kpi-grid">
        <KpiCard label="Tasks Completed" metric={k.tasksCompleted} />
        <KpiCard label="Completion Rate" metric={k.completionRate} format="pct" />
        <KpiCard label="Avg Cycle Time" metric={k.avgCycleHours} format="full" />
        <KpiCard label="On-time Rate" metric={k.onTimeRate} format="pct" />
        <KpiCard label="Estimation Accuracy" metric={k.estimationAccuracy} format="pct" />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="Tasks completed" blockKind="live-task-trend" onAddToCanvas={onAddToCanvas} hint="Daily" height={250}>
          <AreaChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="tpDone" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.success} stopOpacity={0.42} />
                <stop offset="100%" stopColor={theme.success} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
            <Area type="monotone" name="Completed" dataKey="completed" stroke={theme.success} strokeWidth={2} fill="url(#tpDone)" isAnimationActive={false} />
          </AreaChart>
        </ChartFrame>

        <ChartFrame title="Completed by department" blockKind="live-task-dept" onAddToCanvas={onAddToCanvas} hint="Top teams" height={250}>
          <BarChart data={(trends.byDepartment || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
            <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={100} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
            <Bar dataKey="completed" name="Completed" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>
      </div>
    </div>
  );
};

export default TaskProductivity;
