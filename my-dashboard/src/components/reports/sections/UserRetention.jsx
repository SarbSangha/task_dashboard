import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import { formatNumber } from '../utils/format';

const cohortLabel = (iso) => {
  const dt = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const pctMetric = (v) => ({ value: v, unit: '%', deltaPct: null, direction: 'flat' });

const RetentionHeatmap = ({ cohorts, maxWeeks, primary }) => {
  const weeks = Array.from({ length: maxWeeks }, (_, i) => i);
  return (
    <div className="rpt-heatmap-wrap">
      <table className="rpt-heatmap">
        <thead>
          <tr>
            <th className="rpt-hm-corner">Signup week</th>
            <th className="rpt-hm-size">Users</th>
            {weeks.map((w) => <th key={w}>W{w}</th>)}
          </tr>
        </thead>
        <tbody>
          {cohorts.map((c) => (
            <tr key={c.cohort}>
              <td className="rpt-hm-label">{cohortLabel(c.cohort)}</td>
              <td className="rpt-hm-size">{formatNumber(c.size)}</td>
              {weeks.map((w) => {
                const cell = c.weeks.find((x) => x.w === w);
                const pct = cell ? cell.retentionPct : null;
                if (pct == null) return <td key={w} className="rpt-hm-cell empty" />;
                return (
                  <td
                    key={w}
                    className="rpt-hm-cell"
                    style={{
                      background: `color-mix(in srgb, ${primary} ${Math.max(6, Math.round(pct))}%, transparent)`,
                      color: pct >= 45 ? '#fff' : 'var(--color-text-secondary)',
                    }}
                    title={`${cohortLabel(c.cohort)} · W${w}: ${pct}% retained`}
                  >
                    {Math.round(pct)}
                  </td>
                );
              })}
            </tr>
          ))}
          {cohorts.length === 0 && (
            <tr><td colSpan={maxWeeks + 2} style={{ textAlign: 'center', padding: 26, color: 'var(--color-text-muted)' }}>No signup cohorts with activity in the lookback window.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
};

const UserRetention = ({ filters }) => {
  const theme = useChartTheme();
  const params = { department: filters?.department, weeks: 8 };
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'users', 'retention', params],
    queryFn: () => reportsAPI.usersRetention(params),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const windows = data?.windows || {};
  const cohorts = data?.cohorts || [];

  return (
    <div>
      <SectionHeader
        title="Retention"
        subtitle="Do users keep using AI after first adoption? Weekly signup cohorts measured against real activity history — retention is anchored to signup week, independent of the global date filter."
      />

      {isError ? (
        <div className="rpt-error">Failed to load retention: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Computing cohorts…</div>
      ) : (
        <>
          <InsightBanner
            recommendation={
              (windows.d7 ?? 0) < 30
                ? 'Week-1 retention is weak — the first days after signup are where users are lost. Strengthen onboarding and first-value speed.'
                : 'Early retention is holding — focus on extending it into the 30-day window with recurring value.'
            }
          >
            Of new users, <b>{windows.d1 ?? '—'}%</b> returned within a day, <b>{windows.d7 ?? '—'}%</b> within a week and{' '}
            <b>{windows.d30 ?? '—'}%</b> within 30 days. <b>{formatNumber(data?.churnRisk)}</b> previously-active users have gone quiet (no activity in 15–90 days).
          </InsightBanner>

          <div className="rpt-kpi-grid">
            <KpiCard label="D1 Retention" metric={pctMetric(windows.d1)} format="pct" />
            <KpiCard label="D7 Retention" metric={pctMetric(windows.d7)} format="pct" />
            <KpiCard label="D30 Retention" metric={pctMetric(windows.d30)} format="pct" />
            <KpiCard label="Churn Risk (users)" metric={{ value: data?.churnRisk, deltaPct: null, direction: 'flat' }} />
          </div>

          <div className="rpt-card">
            <div className="rpt-card-head">
              <h3 className="rpt-card-title">Cohort retention heatmap</h3>
              <span className="rpt-card-hint">% of each signup cohort active in each week since signup</span>
            </div>
            <RetentionHeatmap cohorts={cohorts} maxWeeks={data?.maxWeeks || 8} primary={theme.primary} />
          </div>
        </>
      )}
    </div>
  );
};

export default UserRetention;
