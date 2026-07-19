import React, { useMemo } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, formatDayLabel, formatHour, initialsOf } from '../utils/format';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const ChatGPTAnalytics = ({ filters }) => {
  const theme = useChartTheme();

  const summaryQ = useQuery({ queryKey: ['reports', 'chatgpt', 'summary', filters], queryFn: () => reportsAPI.chatgptSummary(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const trendsQ = useQuery({ queryKey: ['reports', 'chatgpt', 'trends', filters], queryFn: () => reportsAPI.chatgptTrends(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const usersQ = useQuery({ queryKey: ['reports', 'chatgpt', 'users', filters], queryFn: () => reportsAPI.chatgptUsers({ ...filters, limit: 100 }), placeholderData: keepPreviousData, staleTime: 60_000 });

  const k = summaryQ.data?.kpis || {};
  const trends = trendsQ.data || {};
  const users = usersQ.data?.users || [];

  const topUser = users[0];
  const topModel = useMemo(() => {
    const list = trends.byModel || [];
    const total = list.reduce((s, m) => s + m.conversations, 0);
    if (!list.length || !total) return null;
    return { ...list[0], share: Math.round((list[0].conversations / total) * 100) };
  }, [trends.byModel]);

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'conversations', label: 'Conversations', num: true, render: (r) => formatNumber(r.conversations) },
    { key: 'prompts', label: 'Prompts', num: true, render: (r) => formatNumber(r.prompts) },
    { key: 'avgDepth', label: 'Avg depth', num: true, render: (r) => formatFull(r.avgDepth) },
  ];

  return (
    <div>
      <SectionHeader
        title="ChatGPT Intelligence"
        subtitle="Conversational-AI adoption, model mix and prompt activity from captured ChatGPT usage. Billed tokens are not metered by the capture layer — volume metrics reflect conversations, prompts and responses."
      />

      {summaryQ.isError ? (
        <div className="rpt-error">Failed to load ChatGPT summary: {summaryQ.error?.response?.data?.detail || summaryQ.error?.message}</div>
      ) : (
        <>
          {topUser && (
            <InsightBanner
              recommendation={
                topModel
                  ? `${topModel.model} accounts for ${topModel.share}% of conversations — confirm it matches your cost/capability policy and route routine work to lower-cost models where suitable.`
                  : 'Broaden ChatGPT adoption beyond current heavy users and standardise prompting practices.'
              }
            >
              ChatGPT ran <b>{formatFull(k.conversations?.value)}</b> conversations{' '}
              {k.conversations?.deltaPct != null && (<>(<b>{k.conversations.deltaPct > 0 ? '+' : ''}{k.conversations.deltaPct}%</b> vs prior period) </>)}
              from <b>{formatNumber(k.uniqueUsers?.value)}</b> users, averaging{' '}
              <b>{formatFull(k.avgPromptsPerConversation?.value)}</b> prompts each.{' '}
              {topModel && <><b>{topModel.model}</b> is the dominant model (<b>{topModel.share}%</b>). </>}
              {topUser && <><b>{topUser.name}</b> leads with <b>{formatNumber(topUser.conversations)}</b> conversations.</>}
            </InsightBanner>
          )}

          <div className="rpt-kpi-grid">
            <KpiCard label="ChatGPT Users" metric={k.uniqueUsers} />
            <KpiCard label="Conversations" metric={k.conversations} />
            <KpiCard label="Prompts Sent" metric={k.prompts} />
            <KpiCard label="Responses" metric={k.responses} />
            <KpiCard label="Avg Prompts / Chat" metric={k.avgPromptsPerConversation} format="full" />
          </div>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Conversation volume trend" hint="Daily" height={250}>
              <AreaChart data={trends.daily || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <defs>
                  <linearGradient id="cgTrend" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={theme.success} stopOpacity={0.4} />
                    <stop offset="100%" stopColor={theme.success} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} minTickGap={24} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={38} tickFormatter={formatNumber} />
                <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
                <Area type="monotone" name="Conversations" dataKey="conversations" stroke={theme.success} strokeWidth={2} fill="url(#cgTrend)" isAnimationActive={false} />
              </AreaChart>
            </ChartFrame>

            <ChartFrame title="Model mix" hint="Share of conversations" height={250}>
              <PieChart>
                <Pie data={trends.byModel || []} dataKey="conversations" nameKey="model" innerRadius={52} outerRadius={82} paddingAngle={2} isAnimationActive={false}>
                  {(trends.byModel || []).map((entry, i) => <Cell key={i} fill={theme.series[i % theme.series.length]} />)}
                </Pie>
                <Legend wrapperStyle={{ fontSize: 11, color: theme.text }} />
                <Tooltip content={<ChartTooltip />} />
              </PieChart>
            </ChartFrame>

            <ChartFrame title="Conversations by department" hint="Top teams" height={240}>
              <BarChart data={(trends.byDepartment || []).slice(0, 8)} layout="vertical" margin={{ top: 4, right: 16, bottom: 0, left: 8 }}>
                <CartesianGrid stroke={theme.grid} horizontal={false} />
                <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} tickFormatter={formatNumber} />
                <YAxis type="category" dataKey="department" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={96} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
                <Bar dataKey="conversations" name="Conversations" fill={theme.indigo} radius={[0, 5, 5, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>

            <ChartFrame title="Peak usage hours" hint="Conversations by hour" height={240}>
              <BarChart data={trends.byHour || []} margin={{ top: 4, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="hour" tickFormatter={formatHour} tick={{ fill: theme.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: theme.grid }} interval={1} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={34} tickFormatter={formatNumber} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip labelFormatter={(h) => `${formatHour(h)} hour`} />} />
                <Bar dataKey="conversations" name="Conversations" fill={theme.info} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ChartFrame>
          </div>

          <div style={{ marginTop: 20 }}>
            <div className="rpt-card-head">
              <h3 className="rpt-card-title" style={{ fontSize: 14 }}>ChatGPT user leaderboard</h3>
              <span className="rpt-card-hint">{users.length} users</span>
            </div>
            <DataTable columns={columns} rows={users} initialSort="conversations" />
          </div>
        </>
      )}
    </div>
  );
};

export default ChatGPTAnalytics;
