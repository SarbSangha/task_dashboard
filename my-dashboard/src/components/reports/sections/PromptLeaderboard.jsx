import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import DataTable from '../primitives/DataTable';
import { formatNumber, initialsOf } from '../utils/format';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
    {row.topEngineer && <span className="rpt-level champion" style={{ marginLeft: 4 }}>Top</span>}
  </span>
);

const plain = (v) => ({ value: v, deltaPct: null, direction: 'flat' });

const PromptLeaderboard = ({ filters, onOpenUser }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'prompts', 'engineers', filters],
    queryFn: () => reportsAPI.promptsEngineers({ ...filters, limit: 100 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const engineers = data?.engineers || [];
  const top = engineers[0];
  const topCount = engineers.filter((e) => e.topEngineer).length;

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'Prompt engineer', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'performanceScore', label: 'Perf. score', num: true, render: (r) => <span className="rpt-score">{r.performanceScore}<span className="out">/100</span></span> },
    { key: 'successRate', label: 'Success', num: true, render: (r) => <span className={`rpt-pill ${r.successRate >= 90 ? 'good' : r.successRate >= 70 ? 'warn' : 'bad'}`}>{r.successRate}%</span> },
    { key: 'prompts', label: 'Prompts', num: true, render: (r) => formatNumber(r.prompts) },
    { key: 'uniquenessPct', label: 'Uniqueness', num: true, render: (r) => `${r.uniquenessPct}%` },
  ];

  return (
    <div>
      <SectionHeader
        title="Prompt Leaderboard"
        subtitle="Your best prompt engineers, ranked by a transparent Prompt Performance Score (50% output success · 30% volume · 20% uniqueness). Click a row to open the full user profile."
      />

      {isError ? (
        <div className="rpt-error">Failed to load leaderboard: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Ranking prompt engineers…</div>
      ) : (
        <>
          {top && (
            <InsightBanner
              recommendation={`Pair your ${topCount} top prompt engineer${topCount === 1 ? '' : 's'} with lower-scoring teams — their proven prompts are the seed of the golden library and the future recommendation engine.`}
            >
              <b>{top.name}</b> leads with a Prompt Performance Score of <b>{top.performanceScore}/100</b>{' '}
              (<b>{top.successRate}%</b> success across <b>{formatNumber(top.prompts)}</b> prompts).{' '}
              <b>{topCount}</b> engineer{topCount === 1 ? '' : 's'} score in the top tier (75+).
            </InsightBanner>
          )}

          <div className="rpt-kpi-grid">
            <KpiCard label="Prompt Engineers" metric={plain(engineers.length)} />
            <KpiCard label="Top-Tier Engineers" metric={plain(topCount)} />
            <KpiCard label="Best Score" metric={plain(top?.performanceScore ?? 0)} />
          </div>

          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>Top prompt engineers</h3>
            <span className="rpt-card-hint">{engineers.length} ranked</span>
          </div>
          <DataTable
            columns={columns}
            rows={engineers}
            initialSort="performanceScore"
            onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined}
          />
        </>
      )}
    </div>
  );
};

export default PromptLeaderboard;
