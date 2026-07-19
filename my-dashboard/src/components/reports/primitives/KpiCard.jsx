import React from 'react';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { useChartTheme } from '../hooks/useChartTheme';
import { formatNumber, formatFull, formatPct } from '../utils/format';

const TrendArrow = ({ direction }) => {
  if (direction === 'up') {
    return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="18 15 12 9 6 15" /></svg>;
  }
  if (direction === 'down') {
    return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="6 9 12 15 18 9" /></svg>;
  }
  return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="6" y1="12" x2="18" y2="12" /></svg>;
};

const KpiCard = ({ label, metric, format = 'number' }) => {
  const theme = useChartTheme();
  const m = metric || {};
  const fmt = format === 'pct'
    ? (v) => (v == null ? '—' : `${Number(v).toFixed(1)}`)
    : format === 'full'
      ? formatFull
      : formatNumber;

  if (m.baselineRequired) {
    return (
      <div className="rpt-kpi baseline">
        <div className="rpt-kpi-top">
          <span className="rpt-kpi-label">{label}</span>
        </div>
        <div className="rpt-kpi-value">—</div>
        <div className="rpt-kpi-baseline-tag" title="Set a pre-AI or first-cohort baseline to compute this metric.">
          Baseline required
        </div>
      </div>
    );
  }

  const dir = m.direction || 'flat';
  const unit = m.unit && m.unit !== '%' ? m.unit : '';
  const pctUnit = m.unit === '%' ? '%' : '';
  const series = Array.isArray(m.series) ? m.series : null;
  const sparkColor = dir === 'down' ? theme.danger : theme.success;

  return (
    <div className="rpt-kpi">
      <div className="rpt-kpi-top">
        <span className="rpt-kpi-label">{label}</span>
        {m.deltaPct != null && (
          <span className={`rpt-kpi-delta ${dir}`}>
            <TrendArrow direction={dir} />
            {formatPct(m.deltaPct)}
          </span>
        )}
      </div>

      <div className="rpt-kpi-value">
        {fmt(m.value)}{pctUnit}
        {unit && <span className="unit">{unit}</span>}
      </div>

      {series && series.length > 1 ? (
        <div className="rpt-kpi-spark">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={series} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`spark-${label}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={sparkColor} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={sparkColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="value" stroke={sparkColor} strokeWidth={1.75} fill={`url(#spark-${label})`} isAnimationActive={false} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="rpt-kpi-foot">
          <span className="rpt-kpi-prev">
            {m.previous != null ? `prev ${fmt(m.previous)}${pctUnit}` : ''}
          </span>
        </div>
      )}
    </div>
  );
};

export default KpiCard;
