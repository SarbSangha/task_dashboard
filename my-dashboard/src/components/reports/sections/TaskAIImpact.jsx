import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { BarChart, Bar, ScatterChart, Scatter, ZAxis, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatFull } from '../utils/format';

const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);

const TaskAIImpact = ({ filters }) => {
  const theme = useChartTheme();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'tasks', 'aiImpact', filters],
    queryFn: () => reportsAPI.tasksAiImpact(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const ai = data?.cohorts?.aiActive || {};
  const non = data?.cohorts?.nonAI || {};
  const deltas = data?.deltas || {};

  const cohortData = [
    { cohort: 'AI-active', completedPerUser: ai.completedPerUser || 0, avgCycleHours: ai.avgCycleHours || 0, users: ai.users || 0 },
    { cohort: 'Non-AI', completedPerUser: non.completedPerUser || 0, avgCycleHours: non.avgCycleHours || 0, users: non.users || 0 },
  ];

  return (
    <div>
      <SectionHeader
        title="AI Impact"
        subtitle="Do people who use AI get more done? A user-level comparison of AI-active vs non-AI staff on task throughput and speed."
      />

      {isError ? (
        <div className="rpt-error">Failed to load AI impact: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Comparing cohorts…</div>
      ) : (
        <>
          {/* Honesty caveat — front and centre */}
          <div className="rpt-insight" role="note" style={{ background: 'var(--color-surface)', borderStyle: 'dashed' }}>
            <span className="rpt-insight-mark" aria-hidden="true" style={{ background: 'var(--color-warning)' }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
            </span>
            <div className="rpt-insight-body">
              <p className="rpt-insight-title" style={{ color: 'var(--color-warning)' }}>Correlation, not causation</p>
              <p className="rpt-insight-text">
                There is no task-to-AI link in the data, so we do <b>not</b> attribute individual tasks to AI. This compares people
                who used AI in the period against those who didn’t, attributed by task creator. Treat it as a directional signal — a
                true per-task measure needs a task↔generation bridge (on the roadmap).
              </p>
            </div>
          </div>

          <InsightBanner
            recommendation={
              (deltas.throughputPct ?? 0) > 0
                ? 'AI-active staff show higher throughput — expand enablement to non-AI users and measure the shift over the next period.'
                : 'No throughput advantage is visible yet — pair adoption with the Golden Prompt Library and re-measure as usage deepens.'
            }
          >
            AI-active users complete <b>{signed(deltas.throughputPct)}</b> tasks per person vs non-AI users
            {deltas.cycleFasterPct != null && (<>, and are <b>{signed(deltas.cycleFasterPct)}</b> faster per task</>)}.{' '}
            Based on <b>{formatFull(ai.users)}</b> AI-active and <b>{formatFull(non.users)}</b> non-AI task creators.
          </InsightBanner>

          <div className="rpt-kpi-grid">
            <KpiCard label="Throughput Lift (corr.)" metric={{ value: deltas.throughputPct, unit: '%', deltaPct: null, direction: (deltas.throughputPct ?? 0) >= 0 ? 'up' : 'down' }} format="pct" />
            <KpiCard label="Speed Gain (corr.)" metric={{ value: deltas.cycleFasterPct, unit: '%', deltaPct: null, direction: (deltas.cycleFasterPct ?? 0) >= 0 ? 'up' : 'down' }} format="pct" />
            <KpiCard label="AI-active Creators" metric={{ value: ai.users, deltaPct: null, direction: 'flat' }} />
            <KpiCard label="Non-AI Creators" metric={{ value: non.users, deltaPct: null, direction: 'flat' }} />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Tasks completed per user" hint="Cohort comparison" height={250}>
              <BarChart data={cohortData} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="cohort" tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
                <Bar dataKey="completedPerUser" name="Completed / user" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                  <Cell fill={theme.primary} />
                  <Cell fill={theme.axis} />
                </Bar>
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Avg cycle time" hint="Lower is faster" height={250}>
              <BarChart data={cohortData} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="cohort" tick={{ fill: theme.axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={40} tickFormatter={(v) => `${v}h`} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={(v) => `${formatFull(v)}h`} />} />
                <Bar dataKey="avgCycleHours" name="Avg cycle (h)" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                  <Cell fill={theme.success} />
                  <Cell fill={theme.axis} />
                </Bar>
              </BarChart>
            </ChartFrame>
          </div>

          <ChartFrame title="Department: AI adoption vs productivity" hint="Each point is a department · size = task creators" height={300}>
            <ScatterChart margin={{ top: 12, right: 20, bottom: 10, left: 0 }}>
              <CartesianGrid stroke={theme.grid} />
              <XAxis type="number" dataKey="aiAdoptionPct" name="AI adoption" unit="%" domain={[0, 100]} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} label={{ value: 'AI adoption %', position: 'insideBottom', offset: -4, fill: theme.axis, fontSize: 11 }} />
              <YAxis type="number" dataKey="completedPerUser" name="Completed/user" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
              <ZAxis type="number" dataKey="users" range={[40, 320]} />
              <Tooltip cursor={{ strokeDasharray: '3 3', stroke: theme.grid }} content={<ChartTooltip />} />
              <Scatter data={data?.departmentScatter || []} fill={theme.primary} fillOpacity={0.7} isAnimationActive={false} />
            </ScatterChart>
          </ChartFrame>
        </>
      )}
    </div>
  );
};

export default TaskAIImpact;
