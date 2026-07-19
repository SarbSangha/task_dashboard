import React, { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { formatNumber, formatDayLabel } from '../utils/format';

// Simple first-half vs second-half comparison to answer "are we improving?"
const trendDelta = (daily, key) => {
  const pts = (daily || []).filter((d) => d[key] != null);
  if (pts.length < 4) return null;
  const mid = Math.floor(pts.length / 2);
  const avg = (arr) => arr.reduce((s, d) => s + d[key], 0) / (arr.length || 1);
  const first = avg(pts.slice(0, mid));
  const second = avg(pts.slice(mid));
  return { first: Math.round(first), second: Math.round(second), up: second >= first };
};

const PromptEvolution = ({ filters }) => {
  const theme = useChartTheme();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'prompts', 'trends', filters],
    queryFn: () => reportsAPI.promptsTrends(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const daily = useMemo(() => data?.daily || [], [data]);
  const successTrend = useMemo(() => trendDelta(daily, 'successRate'), [daily]);
  const lengthTrend = useMemo(() => trendDelta(daily, 'avgLength'), [daily]);

  return (
    <div>
      <SectionHeader
        title="Prompt Evolution"
        subtitle="Are people getting better at prompting over time? Measured from real output success and prompt complexity — not a synthetic quality curve."
      />

      {isError ? (
        <div className="rpt-error">Failed to load evolution: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Loading trend…</div>
      ) : (
        <>
          <InsightBanner
            recommendation={
              successTrend && successTrend.up
                ? 'Success is trending up — enablement is working. Capture the improving cohort’s prompts into the golden library.'
                : 'Success is flat or declining — target prompt coaching and surface golden prompts in-product to reverse it.'
            }
          >
            {successTrend
              ? <>Prompt success moved from <b>{successTrend.first}%</b> to <b>{successTrend.second}%</b> across the period{' '}
                  ({successTrend.up ? 'improving' : 'declining'}).{' '}
                  {lengthTrend && <>Average prompt length went from <b>{formatNumber(lengthTrend.first)}</b> to <b>{formatNumber(lengthTrend.second)}</b> chars.</>}</>
              : <>Not enough history in this window to establish a reliable trend — widen the date range.</>}
          </InsightBanner>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Prompt success rate over time" hint="Daily · measured outcome" height={260}>
              <LineChart data={daily} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} domain={[0, 100]} tickFormatter={(v) => `${v}%`} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={(v) => `${v}%`} />} />
                <Line type="monotone" name="Success rate" dataKey="successRate" stroke={theme.success} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartFrame>

            <ChartFrame title="Prompt volume" hint="Daily" height={260}>
              <AreaChart data={daily} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="peVol" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.primary} stopOpacity={0.42} />
                    <stop offset="100%" stopColor={theme.primary} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={36} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
                <Area type="monotone" name="Prompts" dataKey="prompts" stroke={theme.primary} strokeWidth={2} fill="url(#peVol)" isAnimationActive={false} />
              </AreaChart>
            </ChartFrame>

            <ChartFrame title="Prompt complexity" hint="Avg length (chars) / day" height={240}>
              <LineChart data={daily} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={40} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
                <Line type="monotone" name="Avg length" dataKey="avgLength" stroke={theme.info} strokeWidth={2} dot={false} isAnimationActive={false} />
              </LineChart>
            </ChartFrame>
          </div>
        </>
      )}
    </div>
  );
};

export default PromptEvolution;
