import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatDayLabel, formatFull } from '../utils/format';

const ExecutiveDashboard = ({ filters }) => {
  const theme = useChartTheme();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'executive', filters],
    queryFn: () => reportsAPI.executive(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  if (isLoading && !data) return <div className="rpt-loading">Loading executive intelligence…</div>;
  if (isError) return <div className="rpt-error">Failed to load: {error?.response?.data?.detail || error?.message || 'Unknown error'}</div>;

  const k = data?.kpis || {};
  const tasks = data?.tasks || {};
  const ctx = data?.context || {};
  const days = data?.period?.days || 30;

  const gens = k.aiGenerations || {};
  const adoption = k.aiAdoptionRate || {};
  const cost = k.aiCost || {};
  const active = k.activeUsers || {};

  const genDir = gens.direction === 'up' ? 'increased' : gens.direction === 'down' ? 'declined' : 'held steady';

  return (
    <div>
      <SectionHeader
        title="AI Intelligence Command Center"
        subtitle={`Executive overview of AI adoption, output, productivity and spend across the organization — last ${days} days vs the prior ${days}.`}
      />

      <InsightBanner
        recommendation={
          (adoption.value ?? 0) < 50
            ? 'Adoption is below half the workforce — prioritise enablement drives in low-adoption departments before expanding tool spend.'
            : 'Adoption is healthy — sustain momentum and ensure credit capacity keeps pace with the highest-output teams.'
        }
      >
        AI generations <b>{genDir} {gens.deltaPct != null ? `${gens.deltaPct > 0 ? '+' : ''}${gens.deltaPct}%` : ''}</b> to{' '}
        <b>{formatFull(gens.value)}</b> this period. Adoption sits at <b>{adoption.value ?? '—'}%</b> of the workforce
        ({formatNumber(active.value)} of {formatNumber(ctx.totalUsers)} people active), and AI spend was{' '}
        <b>{formatFull(cost.value)} credits</b>.
      </InsightBanner>

      <div className="rpt-kpi-grid">
        <KpiCard label="Active Users" metric={k.activeUsers} />
        <KpiCard label="AI Generations" metric={k.aiGenerations} />
        <KpiCard label="Videos Generated" metric={k.videosGenerated} />
        <KpiCard label="Images Generated" metric={k.imagesGenerated} />
        <KpiCard label="AI Cost" metric={k.aiCost} />
        <KpiCard label="Productivity Improvement" metric={k.productivityImprovement} />
        <KpiCard label="AI Adoption Rate" metric={k.aiAdoptionRate} format="pct" />
        <KpiCard label="ROI" metric={k.roi} />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="AI generation volume" hint={`Daily · last ${days}d`} height={260}>
          <AreaChart data={gens.series || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="execGen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.primary} stopOpacity={0.45} />
                <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={40} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
            <Area type="monotone" name="Generations" dataKey="value" stroke={theme.primary} strokeWidth={2} fill="url(#execGen)" isAnimationActive={false} />
          </AreaChart>
        </ChartFrame>

        <ChartFrame title="AI spend (credits)" hint={`Daily · last ${days}d`} height={260}>
          <AreaChart data={cost.series || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="execCost" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.warning} stopOpacity={0.4} />
                <stop offset="100%" stopColor={theme.warning} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={44} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={formatFull} />} />
            <Area type="monotone" name="Credits" dataKey="value" stroke={theme.warning} strokeWidth={2} fill="url(#execCost)" isAnimationActive={false} />
          </AreaChart>
        </ChartFrame>
      </div>

      <div className="rpt-grid cols-3" style={{ marginTop: 14 }}>
        <div className="rpt-card">
          <div className="rpt-card-head"><h3 className="rpt-card-title">Tasks created</h3></div>
          <div className="rpt-kpi-value">{formatNumber(tasks.created)}</div>
          <div className="rpt-kpi-prev" style={{ marginTop: 6 }}>In the selected range</div>
        </div>
        <div className="rpt-card">
          <div className="rpt-card-head"><h3 className="rpt-card-title">Tasks completed</h3></div>
          <div className="rpt-kpi-value">{formatNumber(tasks.completed)}</div>
          <div className="rpt-kpi-prev" style={{ marginTop: 6 }}>Marked completed in range</div>
        </div>
        <div className="rpt-card">
          <div className="rpt-card-head"><h3 className="rpt-card-title">Completion rate</h3></div>
          <div className="rpt-kpi-value">{tasks.completionRate ?? 0}<span className="unit">%</span></div>
          <div className="rpt-kpi-prev" style={{ marginTop: 6 }}>Completed ÷ created</div>
        </div>
      </div>
    </div>
  );
};

export default ExecutiveDashboard;
