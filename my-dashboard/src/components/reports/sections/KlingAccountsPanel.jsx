import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  BarChart, Bar, PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import KpiCard from '../primitives/KpiCard';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, formatHour } from '../utils/format';

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// CSS-grid day×hour heatmap (recharts has no native heatmap).
const Heatmap = ({ cells }) => {
  const theme = useChartTheme();
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0) || 1;
  const grid = {};
  cells.forEach((c) => { grid[`${c.dow}-${c.hour}`] = c.count; });
  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `36px repeat(24, 1fr)`, gap: 2, minWidth: 560 }}>
        <div />
        {Array.from({ length: 24 }, (_, h) => (
          <div key={h} style={{ fontSize: 9, color: theme.axis, textAlign: 'center' }}>{h % 3 === 0 ? h : ''}</div>
        ))}
        {DOW.map((day, d) => (
          <React.Fragment key={d}>
            <div style={{ fontSize: 10, color: theme.axis, display: 'flex', alignItems: 'center' }}>{day}</div>
            {Array.from({ length: 24 }, (_, h) => {
              const v = grid[`${d}-${h}`] || 0;
              const alpha = v ? 0.15 + 0.85 * (v / max) : 0;
              return (
                <div key={h} title={`${day} ${formatHour(h)} · ${v} generations`}
                  style={{
                    height: 16, borderRadius: 3,
                    background: v ? `rgba(99,102,241,${alpha})` : 'var(--color-surface, #1b1b1b)',
                    border: '1px solid var(--color-border, #2a2a2a)',
                  }} />
              );
            })}
          </React.Fragment>
        ))}
      </div>
    </div>
  );
};

const KlingAccountsPanel = ({ filters }) => {
  const theme = useChartTheme();
  const accountsQ = useQuery({ queryKey: ['reports', 'kling', 'accounts', filters], queryFn: () => reportsAPI.klingAccounts(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const timingQ = useQuery({ queryKey: ['reports', 'kling', 'timing', filters], queryFn: () => reportsAPI.klingTiming(filters), placeholderData: keepPreviousData, staleTime: 60_000 });
  const funnelQ = useQuery({ queryKey: ['reports', 'kling', 'funnel', filters], queryFn: () => reportsAPI.klingFunnel(filters), placeholderData: keepPreviousData, staleTime: 60_000 });

  const acc = accountsQ.data || {};
  const currency = acc.currency || 'INR';
  const accounts = acc.accounts || [];
  const totals = acc.totals || {};
  const timing = timingQ.data || {};
  const funnel = funnelQ.data?.funnel || {};
  const modelMix = funnelQ.data?.modelMix || [];
  const money = (v) => (v == null ? '—' : `${currency} ${formatFull(v)}`);

  const accountColumns = [
    { key: 'label', label: 'Account / user', render: (r) => <b>{r.label}</b> },
    { key: 'generations', label: 'Generations', num: true, render: (r) => formatNumber(r.generations) },
    { key: 'credits', label: 'Credits', num: true, render: (r) => formatFull(r.credits) },
    { key: 'cost', label: `Cost (${currency})`, num: true, render: (r) => money(r.cost) },
    { key: 'avgCreditsPerGeneration', label: 'Cr / gen', num: true, render: (r) => formatFull(r.avgCreditsPerGeneration) },
    { key: 'creditSharePct', label: 'Share', num: true, render: (r) => `${r.creditSharePct}%` },
  ];

  return (
    <div style={{ marginTop: 24 }}>
      <div className="rpt-card-head" style={{ marginBottom: 6 }}>
        <h3 className="rpt-card-title" style={{ fontSize: 15 }}>Usage by Account &amp; User</h3>
        <span className="rpt-card-hint">Each Kling account is a login (usually a person's email), so this is the closest per-user cut the capture supports — with real ₹ cost and timing.</span>
      </div>

      <div className="rpt-kpi-grid">
        <KpiCard label="Kling Accounts Used" metric={{ value: totals.accounts ?? 0, deltaPct: null, direction: 'flat' }} />
        <KpiCard label={`Total Cost (${currency})`} metric={{ value: totals.cost ?? 0, deltaPct: null, direction: 'flat', unit: currency }} format="full" />
        <KpiCard label="Peak Hour (IST)" metric={{ value: timing.peakHour ? Number(timing.peakHour.hour) : 0, deltaPct: null, direction: 'flat' }} />
        <KpiCard label="Busiest Day" metric={{ value: timing.peakDay?.count ?? 0, deltaPct: null, direction: 'flat', unit: timing.peakDay?.day || '' }} />
      </div>

      <div className="rpt-grid cols-2">
        <ChartFrame title="Credit spend share by account" hint="Which account burns most" height={250}>
          <PieChart>
            <Pie data={accounts} dataKey="credits" nameKey="label" innerRadius={52} outerRadius={82} paddingAngle={2} isAnimationActive={false}>
              {accounts.map((entry, i) => <Cell key={i} fill={theme.series[i % theme.series.length]} />)}
            </Pie>
            <Legend wrapperStyle={{ fontSize: 11, color: theme.text }} />
            <Tooltip content={<ChartTooltip valueFormatter={formatFull} />} />
          </PieChart>
        </ChartFrame>

        <ChartFrame title="Generations by hour of day" hint="IST · peak-load window" height={250}>
          <BarChart data={timing.byHour || []} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="hour" tickFormatter={formatHour} tick={{ fill: theme.axis, fontSize: 10 }} tickLine={false} axisLine={{ stroke: theme.grid }} interval={1} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={34} tickFormatter={formatNumber} />
            <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip labelFormatter={formatHour} />} />
            <Bar dataKey="count" name="Generations" fill={theme.primary} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          </BarChart>
        </ChartFrame>
      </div>

      <ChartFrame title="Activity heatmap — day × hour (IST)" hint="Darker = more generations" height={200}>
        <div style={{ padding: '8px 4px' }}><Heatmap cells={timing.heatmap || []} /></div>
      </ChartFrame>

      <div className="rpt-grid cols-2" style={{ marginTop: 16 }}>
        <div>
          <div className="rpt-card-head"><h3 className="rpt-card-title" style={{ fontSize: 14 }}>Cost by Kling account</h3></div>
          <DataTable columns={accountColumns} rows={accounts} initialSort="cost" />
        </div>

        <div>
          <div className="rpt-card-head"><h3 className="rpt-card-title" style={{ fontSize: 14 }}>Capture funnel &amp; model mix</h3></div>
          <div className="rpt-kpi-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <KpiCard label="Generations" metric={{ value: funnel.generations ?? 0, deltaPct: null, direction: 'flat' }} />
            <KpiCard label="Captured Clicks" metric={{ value: funnel.capturedClicks ?? 0, deltaPct: null, direction: 'flat' }} />
          </div>
          {funnel.clickCapturePct != null && (
            <p className="rpt-kpi-prev" style={{ marginTop: 6 }}>
              Click capture covers <b>{funnel.clickCapturePct}%</b> of observed generations — the rest are seen only on the network layer.
            </p>
          )}
          <div style={{ marginTop: 10 }}>
            {modelMix.map((m) => (
              <div key={m.model} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, padding: '3px 0' }}>
                <span className="rpt-pill muted">{m.model}</span>
                <b>{formatNumber(m.count)}</b>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default KlingAccountsPanel;
