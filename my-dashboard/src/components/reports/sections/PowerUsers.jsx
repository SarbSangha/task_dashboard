import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, initialsOf } from '../utils/format';

const levelClass = (lvl) =>
  lvl === 'AI Champion' ? 'champion' : lvl === 'Practitioner' ? 'practitioner' : lvl === 'Explorer' ? 'explorer' : 'beginner';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const plain = (v) => ({ value: v, deltaPct: null, direction: 'flat' });

const PowerUsers = ({ filters, onOpenUser }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'users', 'power', filters],
    queryFn: () => reportsAPI.usersPowerUsers({ ...filters, limit: 100 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = data?.users || [];
  const distribution = data?.distribution || [];
  const champions = distribution.find((d) => d.level === 'AI Champion')?.count || 0;
  const avgScore = users.length
    ? Math.round(users.reduce((s, u) => s + u.maturityScore, 0) / users.length)
    : 0;
  const top = users[0];

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'level', label: 'Level', render: (r) => <span className={`rpt-level ${levelClass(r.level)}`}>{r.level}</span> },
    { key: 'maturityScore', label: 'AI Score', num: true, render: (r) => <span className="rpt-score">{r.maturityScore}<span className="out">/100</span></span> },
    { key: 'generations', label: 'Generations', num: true, render: (r) => formatNumber(r.generations) },
    { key: 'activeDays', label: 'Active days', num: true, render: (r) => formatNumber(r.activeDays) },
    { key: 'credits', label: 'Credits', num: true, render: (r) => formatFull(r.credits) },
  ];

  return (
    <div>
      <SectionHeader
        title="Power Users"
        subtitle="Your AI champions — ranked by a transparent AI Maturity Score built from real usage frequency, output volume, tool diversity, output success and consistency."
      />

      {isError ? (
        <div className="rpt-error">Failed to load power users: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Ranking users…</div>
      ) : (
        <>
          {top && (
            <InsightBanner
              recommendation={
                (data?.concentration?.top10SharePct ?? 0) > 60
                  ? `Output is concentrated — the top 10 users drive ${data.concentration.top10SharePct}% of all generations. Broaden adoption to reduce key-person risk.`
                  : `Recognise your ${champions} AI Champion${champions === 1 ? '' : 's'} and pair them as mentors to lift Explorers into Practitioners.`
              }
            >
              <b>{top.name}</b> leads with an AI Maturity Score of <b>{top.maturityScore}/100</b> ({top.level}).{' '}
              The organisation has <b>{champions}</b> AI Champion{champions === 1 ? '' : 's'}, and the top 10 users account for{' '}
              <b>{data?.concentration?.top10SharePct ?? 0}%</b> of all AI output.
            </InsightBanner>
          )}

          <div className="rpt-kpi-grid">
            <KpiCard label="AI Users Ranked" metric={plain(users.length)} />
            <KpiCard label="AI Champions" metric={plain(champions)} />
            <KpiCard label="Avg Maturity Score" metric={plain(avgScore)} />
            <KpiCard label="Top-10 Output Share" metric={{ value: data?.concentration?.top10SharePct, unit: '%', deltaPct: null, direction: 'flat' }} format="pct" />
          </div>

          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>AI power-user leaderboard</h3>
            <span className="rpt-card-hint">{users.length} users · click a row for the full profile</span>
          </div>
          <DataTable
            columns={columns}
            rows={users}
            initialSort="maturityScore"
            onRowClick={onOpenUser ? (row) => onOpenUser(row.userId, row.name) : undefined}
          />
        </>
      )}
    </div>
  );
};

export default PowerUsers;
