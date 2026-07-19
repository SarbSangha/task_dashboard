import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatFull } from '../utils/format';

const prettyStatus = (s) => `${s}`.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
const AGE_TONE = (theme) => ['0-1d', '1-3d', '3-7d', '7-14d', '14d+'].reduce((acc, k, i) => {
  acc[k] = [theme.success, theme.info, theme.warning, theme.warning, theme.danger][i];
  return acc;
}, {});

const TaskBottlenecks = ({ filters }) => {
  const theme = useChartTheme();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'tasks', 'bottlenecks', filters],
    queryFn: () => reportsAPI.tasksBottlenecks(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const ageTone = AGE_TONE(theme);
  const slowestStage = (data?.dwellByStatus || [])[0];
  const oldest = (data?.agingBacklog || []).find((b) => b.bucket === '14d+');

  return (
    <div>
      <SectionHeader
        title="Bottlenecks"
        subtitle="Where work piles up and slows down — aging backlog, stage dwell time, overdue tasks and the slowest task types."
      />

      {isError ? (
        <div className="rpt-error">Failed to load bottlenecks: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Analysing flow…</div>
      ) : (
        <>
          <InsightBanner
            recommendation={
              slowestStage
                ? `Tasks dwell longest in "${prettyStatus(slowestStage.status)}" (${formatFull(slowestStage.avgHours)}h avg) — re-resource or automate that stage first.`
                : 'No dominant bottleneck stage detected in this window — monitor the aging backlog for early build-up.'
            }
          >
            <b>{formatNumber(data?.openTotal)}</b> tasks are open, of which <b>{formatNumber(data?.overdue)}</b> are overdue
            {oldest && oldest.count > 0 && (<> and <b>{formatNumber(oldest.count)}</b> have been open 14+ days</>)}.{' '}
            Rework/rejection sits at <b>{data?.reworkRate ?? 0}%</b>.
          </InsightBanner>

          <div className="rpt-kpi-grid">
            <KpiCard label="Open Tasks" metric={{ value: data?.openTotal, deltaPct: null, direction: 'flat' }} />
            <KpiCard label="Overdue" metric={{ value: data?.overdue, deltaPct: null, direction: (data?.overdue ?? 0) > 0 ? 'down' : 'flat' }} />
            <KpiCard label="Rework / Rejection" metric={{ value: data?.reworkRate, unit: '%', deltaPct: null, direction: 'flat' }} format="pct" />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Aging backlog" hint="Open tasks by age" height={250}>
              <BarChart data={data?.agingBacklog || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="bucket" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
                <Bar dataKey="count" name="Open tasks" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {(data?.agingBacklog || []).map((entry, i) => <Cell key={i} fill={ageTone[entry.bucket] || theme.primary} />)}
                </Bar>
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Avg dwell time by status" hint="Where tasks wait" height={250}>
              <BarChart data={(data?.dwellByStatus || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={theme.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={(v) => `${v}h`} />
                <YAxis type="category" dataKey="status" tickFormatter={prettyStatus} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={116} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={(v) => `${formatFull(v)}h`} />} />
                <Bar dataKey="avgHours" name="Avg dwell (h)" fill={theme.warning} radius={[0, 5, 5, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>
          </div>

          <ChartFrame title="Slowest task types" hint="Avg cycle time (hours)" height={250}>
            <BarChart data={data?.slowestTypes || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
              <CartesianGrid stroke={theme.grid} vertical={false} />
              <XAxis dataKey="type" tickFormatter={prettyStatus} tick={{ fill: theme.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: theme.grid }} interval={0} angle={-12} textAnchor="end" height={44} />
              <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}h`} />
              <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={(v) => `${formatFull(v)}h`} />} />
              <Bar dataKey="avgCycleHours" name="Avg cycle (h)" fill={theme.danger} radius={[4, 4, 0, 0]} isAnimationActive={false} />
            </BarChart>
          </ChartFrame>
        </>
      )}
    </div>
  );
};

export default TaskBottlenecks;
