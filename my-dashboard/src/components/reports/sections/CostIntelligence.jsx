import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell, ComposedChart, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { usePermissions } from '../../../hooks/usePermissions';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import DataTable from '../primitives/DataTable';
import CreditRatesAdmin from './CreditRatesAdmin';
import { formatNumber, formatFull, formatDayLabel, initialsOf } from '../utils/format';

const VIEW_META = {
  'credit-usage': { title: 'Credit Usage', subtitle: 'Where AI credits are spent — by department, tool and user — and how much is lost to failed work.' },
  'token-analysis': { title: 'Token & Message Analysis', subtitle: 'ChatGPT message throughput and generation cost-efficiency. Billed tokens are not captured by the extension, so message volume is the real throughput signal.' },
  'roi-analysis': { title: 'ROI Analysis', subtitle: 'Spend-to-value: whether AI cost is growing slower than output, and where returns concentrate. Dollar ROI needs a configured cost baseline.' },
};

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const CostIntelligence = ({ view = 'credit-usage', filters, onOpenUser }) => {
  const theme = useChartTheme();
  const { isAdmin } = usePermissions();

  const summaryQ = useQuery({ queryKey: ['reports', 'cost', 'summary', filters], queryFn: () => reportsAPI.costSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const breakdownQ = useQuery({ queryKey: ['reports', 'cost', 'breakdown', filters], queryFn: () => reportsAPI.costBreakdown({ ...filters, limit: 100 }), placeholderData: keepPreviousData, staleTime: 60_000 });
  const cgSummaryQ = useQuery({
    queryKey: ['reports', 'chatgpt', 'summary', filters], queryFn: () => reportsAPI.chatgptSummary(filters),
    enabled: view === 'token-analysis', placeholderData: keepPreviousData, staleTime: 60_000,
  });
  const cgTrendsQ = useQuery({
    queryKey: ['reports', 'chatgpt', 'trends', filters], queryFn: () => reportsAPI.chatgptTrends(filters),
    enabled: view === 'token-analysis', placeholderData: keepPreviousData, staleTime: 60_000,
  });

  const k = summaryQ.data?.kpis || {};
  const bd = breakdownQ.data || {};
  const currency = summaryQ.data?.currency || breakdownQ.data?.currency || 'INR';
  const money = (v) => (v == null ? '—' : `${currency} ${formatFull(v)}`);
  const meta = VIEW_META[view] || VIEW_META['credit-usage'];

  const spenderColumns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'credits', label: 'Credits', num: true, render: (r) => formatFull(r.credits) },
    { key: 'cost', label: `Cost (${currency})`, num: true, render: (r) => money(r.cost) },
    { key: 'generations', label: 'Outputs', num: true, render: (r) => formatNumber(r.generations) },
    { key: 'creditsPerOutput', label: 'Cr / output', num: true, render: (r) => formatFull(r.creditsPerOutput) },
  ];

  const deptColumns = [
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'credits', label: 'Credits', num: true, render: (r) => formatFull(r.credits) },
    { key: 'cost', label: `Cost (${currency})`, num: true, render: (r) => money(r.cost) },
    { key: 'generations', label: 'Outputs', num: true, render: (r) => formatNumber(r.generations) },
    { key: 'creditsPerOutput', label: 'Cr / output', num: true, render: (r) => formatFull(r.creditsPerOutput) },
  ];

  if (summaryQ.isError) {
    return (
      <div>
        <SectionHeader title={meta.title} subtitle={meta.subtitle} />
        <div className="rpt-error">Failed to load cost data: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader title={meta.title} subtitle={meta.subtitle} />

      {/* ---------- CREDIT USAGE ---------- */}
      {view === 'credit-usage' && (
        <>
          {isAdmin && <CreditRatesAdmin />}

          <InsightBanner
            recommendation={
              (summaryQ.data?.wastedPct ?? 0) > 10
                ? `${summaryQ.data.wastedPct}% of credits went to failed generations — prioritise reliability fixes on the highest-failure workflows to recover spend.`
                : 'Credit waste is under control — focus optimisation on the highest-consuming departments and models.'
            }
          >
            Total AI spend was <b>{money(k.totalCost?.value)}</b> (<b>{formatFull(k.totalCredits?.value)}</b> credits){' '}
            {k.totalCredits?.deltaPct != null && (<>(<b>{k.totalCredits.deltaPct > 0 ? '+' : ''}{k.totalCredits.deltaPct}%</b> vs prior period) </>)}
            at <b>{formatFull(k.costPerOutput?.value)}</b> credits per successful output.{' '}
            <b>{summaryQ.data?.wastedPct ?? 0}%</b> was lost to failed generations.
          </InsightBanner>

          <div className="rpt-kpi-grid">
            <KpiCard label={`Total Cost (${currency})`} metric={k.totalCost} format="full" />
            <KpiCard label="Total Credits" metric={k.totalCredits} />
            <KpiCard label={`Cost / Output (${currency})`} metric={k.costPerOutputCurrency} format="full" />
            <KpiCard label="Wasted Credits" metric={k.wastedCredits} />
            <KpiCard label="ROI" metric={k.roi} />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Credit spend trend" hint="Daily" height={250}>
              <AreaChart data={bd.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -4 }}>
                <defs>
                  <linearGradient id="costTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.warning} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={theme.warning} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={46} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={formatFull} />} />
                <Area type="monotone" name="Credits" dataKey="credits" stroke={theme.warning} strokeWidth={2} fill="url(#costTrend)" isAnimationActive={false} />
              </AreaChart>
            </ChartFrame>

            <ChartFrame title="Credit share by tool" hint="Provider mix" height={250}>
              <PieChart>
                <Pie data={bd.byProvider || []} dataKey="credits" nameKey="provider" innerRadius={52} outerRadius={82} paddingAngle={2} isAnimationActive={false}>
                  {(bd.byProvider || []).map((entry, i) => <Cell key={i} fill={theme.series[i % theme.series.length]} />)}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 11, color: theme.text }} />
                <Tooltip content={<ChartTooltip valueFormatter={formatFull} />} />
              </PieChart>
            </ChartFrame>

            <ChartFrame title="Credit spend by department" hint="Top teams" height={250}>
              <BarChart data={(bd.byDepartment || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={theme.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
                <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={96} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={formatFull} />} />
                <Bar dataKey="credits" name="Credits" fill={theme.warning} radius={[0, 5, 5, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Productive vs wasted spend" hint="Credits" height={250}>
              <PieChart>
                <Pie data={summaryQ.data?.spend || []} dataKey="credits" nameKey="label" innerRadius={52} outerRadius={82} paddingAngle={2} isAnimationActive={false}>
                  {(summaryQ.data?.spend || []).map((entry, i) => <Cell key={i} fill={entry.label === 'Wasted' ? theme.danger : theme.success} />)}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 12, color: theme.text }} />
                <Tooltip content={<ChartTooltip valueFormatter={formatFull} />} />
              </PieChart>
            </ChartFrame>
          </div>

          <div style={{ marginTop: 20 }}>
            <div className="rpt-card-head">
              <h3 className="rpt-card-title" style={{ fontSize: 14 }}>Top credit spenders</h3>
              <span className="rpt-card-hint">Click a row for the full profile</span>
            </div>
            <DataTable columns={spenderColumns} rows={bd.topUsers || []} initialSort="credits" onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined} />
          </div>
        </>
      )}

      {/* ---------- TOKEN / MESSAGE ANALYSIS ---------- */}
      {view === 'token-analysis' && (
        <>
          <div className="rpt-kpi-grid">
            <KpiCard label="ChatGPT Messages" metric={{ value: cgSummaryQ.data?.messages?.total ?? 0, deltaPct: null, direction: 'flat' }} />
            <KpiCard label="Avg Messages / Chat" metric={{ value: cgSummaryQ.data?.messages?.avgPerConversation ?? 0, deltaPct: null, direction: 'flat' }} format="full" />
            <KpiCard label="Prompts Sent" metric={cgSummaryQ.data?.kpis?.prompts} />
            <KpiCard label="Cost / Successful Output" metric={k.costPerOutput} format="full" />
          </div>

          <div className="rpt-insight" role="note" style={{ background: 'var(--color-surface)', borderStyle: 'dashed' }}>
            <span className="rpt-insight-mark" aria-hidden="true" style={{ background: 'var(--color-warning)' }}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" /></svg>
            </span>
            <div className="rpt-insight-body">
              <p className="rpt-insight-title" style={{ color: 'var(--color-warning)' }}>Tokens not billed</p>
              <p className="rpt-insight-text">
                The ChatGPT capture layer records conversations, prompts and responses — <b>not billed tokens or dollar cost</b>.
                Message volume above is the real throughput signal. A precise token-cost view requires an OpenAI billing/usage integration.
              </p>
            </div>
          </div>

          <ChartFrame title="ChatGPT prompt volume" hint="Daily prompts" height={260}>
            <AreaChart data={cgTrendsQ.data?.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="tokTrend" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={theme.success} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={theme.success} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke={theme.grid} vertical={false} />
              <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
              <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={40} tickFormatter={formatNumber} />
              <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
              <Area type="monotone" name="Prompts" dataKey="prompts" stroke={theme.success} strokeWidth={2} fill="url(#tokTrend)" isAnimationActive={false} />
            </AreaChart>
          </ChartFrame>
        </>
      )}

      {/* ---------- ROI ANALYSIS ---------- */}
      {view === 'roi-analysis' && (
        <>
          <div className="rpt-kpi-grid">
            <KpiCard label="ROI" metric={k.roi} />
            <KpiCard label="Total AI Cost" metric={k.totalCredits} />
            <KpiCard label="Cost / Successful Output" metric={k.costPerOutput} format="full" />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Cost vs output" hint="Credits vs generations · daily" height={270}>
              <ComposedChart data={bd.daily || []} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis yAxisId="left" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={44} tickFormatter={formatNumber} />
                <YAxis yAxisId="right" orientation="right" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} valueFormatter={formatFull} />} />
                <Legend wrapperStyle={{ fontSize: 11, color: theme.text }} />
                <Bar yAxisId="left" dataKey="credits" name="Credits" fill={theme.warning} radius={[4, 4, 0, 0]} isAnimationActive={false} barSize={10} />
                <Line yAxisId="right" type="monotone" dataKey="generations" name="Outputs" stroke={theme.primary} strokeWidth={2} dot={false} isAnimationActive={false} />
              </ComposedChart>
            </ChartFrame>

            <ChartFrame title="Cost efficiency by department" hint="Credits per output" height={270}>
              <BarChart data={(bd.byDepartment || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={theme.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
                <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={96} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip valueFormatter={formatFull} />} />
                <Bar dataKey="creditsPerOutput" name="Credits / output" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>
          </div>

          <div style={{ marginTop: 18 }}>
            <div className="rpt-card-head"><h3 className="rpt-card-title" style={{ fontSize: 14 }}>ROI-adjusted cost by department</h3></div>
            <DataTable columns={deptColumns} rows={bd.byDepartment || []} initialSort="credits" />
          </div>

          <p className="rpt-kpi-prev" style={{ marginTop: 14 }}>
            Net dollar ROI renders as “Baseline required” until a cost-per-credit and a pre-AI productivity baseline are configured. Cost-to-output and per-department efficiency above are computed from real credit and generation data.
          </p>
        </>
      )}
    </div>
  );
};

export default CostIntelligence;
