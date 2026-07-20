import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AreaChart, Area, LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import { ToCanvasButton, DrillableKpi } from './ExecutiveDashboard';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatFull, formatDayLabel } from '../utils/format';

const PromptPerformance = ({ filters, onDrill, onAddToCanvas }) => {
  const theme = useChartTheme();
  const summaryQ = useQuery({ queryKey: ['reports', 'prompts', 'summary', filters], queryFn: () => reportsAPI.promptsSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'prompts', 'trends', filters], queryFn: () => reportsAPI.promptsTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });

  const k = summaryQ.data?.kpis || {};
  const trends = trendsQ.data || {};

  if (summaryQ.isError) {
    return (
      <div>
        <SectionHeader title="Prompt Performance" />
        <div className="rpt-error">Failed to load prompts: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      </div>
    );
  }

  const topTheme = (trends.topThemes || [])[0];

  return (
    <div>
      <SectionHeader
        title="Prompt Performance"
        subtitle="How prompts translate into successful outputs. Success is measured from real generation outcomes; ChatGPT prompts add volume where no success signal exists."
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move KPIs to canvas"
            title="Add the prompt KPIs to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-prompts' }, 'Prompt KPIs')}
          />
        )}
      </SectionHeader>

      <InsightBanner
        recommendation={
          (k.reuseRate?.value ?? 0) < 20
            ? 'Prompt reuse is low — most prompts are written from scratch. A golden-prompt library would lift success and cut effort.'
            : 'Healthy reuse — promote the highest-success prompts into the golden library and route teams to them.'
        }
      >
        <b>{formatFull(k.totalPrompts?.value)}</b> generation prompts ran this period{' '}
        {k.totalPrompts?.deltaPct != null && (<>(<b>{k.totalPrompts.deltaPct > 0 ? '+' : ''}{k.totalPrompts.deltaPct}%</b>) </>)}
        with a <b>{k.successfulPct?.value ?? 0}%</b> success rate and <b>{k.reuseRate?.value ?? 0}%</b> reuse.{' '}
        Plus <b>{formatNumber(summaryQ.data?.chatgptPrompts)}</b> ChatGPT prompts.{' '}
        {topTheme && <>Top theme: <b>{topTheme.theme}</b>.</>}
      </InsightBanner>

      <div className="rpt-kpi-grid">
        <DrillableKpi label="Total Prompts" metric={k.totalPrompts} onDrill={onDrill} view="prompt-drill" hint="See who wrote them" />
        <KpiCard label="Successful Prompt %" metric={k.successfulPct} format="pct" />
        <DrillableKpi label="Prompt Reuse Rate" metric={k.reuseRate} format="pct" onDrill={onDrill} view="prompt-drill" ctx={{ mode: 'reuse' }} hint="See who reuses, and which prompts" />
        <DrillableKpi label="Unique Prompts" metric={k.uniquePrompts} onDrill={onDrill} view="prompt-drill" hint="See who wrote them" />
        <KpiCard label="Avg Prompt Length" metric={k.avgLength} />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="Prompt success rate over time" blockKind="live-prompt-success" onAddToCanvas={onAddToCanvas} hint="Daily" height={250}>
          <LineChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={(v) => `${v}%`} />} />
            <Line type="monotone" name="Success rate" dataKey="successRate" stroke={theme.success} strokeWidth={2} dot={false} isAnimationActive={false} />
          </LineChart>
        </ChartFrame>

        <ChartFrame title="Prompt volume" blockKind="live-prompt-volume" onAddToCanvas={onAddToCanvas} hint="Daily" height={250}>
          <AreaChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <defs>
              <linearGradient id="ppVol" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={theme.primary} stopOpacity={0.42} />
                <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
            <Area type="monotone" name="Prompts" dataKey="prompts" stroke={theme.primary} strokeWidth={2} fill="url(#ppVol)" isAnimationActive={false} />
          </AreaChart>
        </ChartFrame>

        <ChartFrame title="Top prompt themes" blockKind="live-prompt-themes" onAddToCanvas={onAddToCanvas} hint="From tags" height={240}>
          <BarChart data={(trends.topThemes || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
            <YAxis type="category" dataKey="theme" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={110} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
            <Bar dataKey="count" name="Uses" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>

        <ChartFrame title="Success rate by model" blockKind="live-prompt-models" onAddToCanvas={onAddToCanvas} hint="Prompt → output" height={240}>
          <BarChart data={(trends.successByModel || []).slice(0, 8)} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="model" tick={{ fill: theme.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: theme.grid }} interval={0} angle={-12} textAnchor="end" height={44} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={(v) => `${v}%`} />} />
            <Bar dataKey="successRate" name="Success rate" fill={theme.success} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>
      </div>
    </div>
  );
};

export default PromptPerformance;
