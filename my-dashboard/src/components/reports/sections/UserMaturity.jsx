import React from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';
import { reportsAPI } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import { initialsOf } from '../utils/format';

const LEVEL_COLOR = (theme) => ({
  'AI Champion': theme.primary,
  Practitioner: theme.success,
  Explorer: theme.info,
  Beginner: theme.axis,
});

const COMPONENTS = [
  { key: 'frequency', label: 'Frequency', weight: '25%' },
  { key: 'volume', label: 'Volume', weight: '20%' },
  { key: 'diversity', label: 'Diversity', weight: '15%' },
  { key: 'success', label: 'Success', weight: '20%' },
  { key: 'consistency', label: 'Consistency', weight: '20%' },
];

const ChampionCard = ({ user, primary }) => (
  <div className="rpt-champ">
    <div className="rpt-champ-head">
      {user.avatar ? <img className="rpt-user-av" src={user.avatar} alt="" /> : <span className="rpt-user-av">{initialsOf(user.name)}</span>}
      <div style={{ minWidth: 0 }}>
        <div className="rpt-champ-name">{user.name}</div>
        <div className="rpt-champ-dept">{user.department}</div>
      </div>
      <span className="rpt-score" style={{ marginLeft: 'auto' }}>{user.maturityScore}<span className="out">/100</span></span>
    </div>
    <div className="rpt-champ-bars">
      {COMPONENTS.map((c) => (
        <div className="rpt-cbar-row" key={c.key}>
          <span className="rpt-cbar-label">{c.label}</span>
          <span className="rpt-cbar-track"><span className="rpt-cbar-fill" style={{ width: `${Math.round(user.components?.[c.key] || 0)}%`, background: primary }} /></span>
          <span className="rpt-cbar-val">{Math.round(user.components?.[c.key] || 0)}</span>
        </div>
      ))}
    </div>
  </div>
);

const UserMaturity = ({ filters }) => {
  const theme = useChartTheme();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'users', 'power', filters],
    queryFn: () => reportsAPI.usersPowerUsers({ ...filters, limit: 100 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = data?.users || [];
  const distribution = data?.distribution || [];
  const levelColor = LEVEL_COLOR(theme);
  const champions = users.filter((u) => u.level === 'AI Champion').slice(0, 9);
  const ranked = users.length;
  const championCount = distribution.find((d) => d.level === 'AI Champion')?.count || 0;
  const practitioners = distribution.find((d) => d.level === 'Practitioner')?.count || 0;

  return (
    <div>
      <SectionHeader
        title="User AI Maturity"
        subtitle="A transparent 0–100 maturity index per user — 25% usage frequency, 20% output volume, 15% tool diversity, 20% output success, 20% consistency. All inputs are real; prompt-quality and productivity-lift are intentionally excluded until measurable."
      />

      {isError ? (
        <div className="rpt-error">Failed to load maturity: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Scoring users…</div>
      ) : (
        <>
          <InsightBanner
            recommendation={
              championCount + practitioners < ranked / 2
                ? 'Most users sit at Beginner/Explorer — a structured enablement program would move the majority up a level.'
                : 'A strong core of Practitioners and Champions exists — formalise them into a mentor network to lift the rest.'
            }
          >
            Across <b>{ranked}</b> ranked AI users: <b>{championCount}</b> Champions and <b>{practitioners}</b> Practitioners.
            Each level below is computed from stored usage, output and consistency signals — fully reproducible, no fabricated scores.
          </InsightBanner>

          <div className="rpt-grid cols-2">
            <ChartFrame title="Maturity level distribution" hint="Users per level" height={250}>
              <BarChart data={distribution} margin={{ top: 8, right: 12, bottom: 0, left: -8 }}>
                <CartesianGrid stroke={theme.grid} vertical={false} />
                <XAxis dataKey="level" tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={{ stroke: theme.grid }} />
                <YAxis tick={{ fill: theme.axis, fontSize: 11 }} tickLine={false} axisLine={false} width={34} />
                <Tooltip cursor={{ fill: theme.grid }} content={<ChartTooltip />} />
                <Bar dataKey="count" name="Users" radius={[5, 5, 0, 0]} isAnimationActive={false}>
                  {distribution.map((entry, i) => <Cell key={i} fill={levelColor[entry.level] || theme.primary} />)}
                </Bar>
              </BarChart>
            </ChartFrame>

            <div className="rpt-card">
              <div className="rpt-card-head"><h3 className="rpt-card-title">Scoring model</h3></div>
              <div className="rpt-champ-bars" style={{ gap: 10 }}>
                {COMPONENTS.map((c) => (
                  <div className="rpt-cbar-row" key={c.key} style={{ gridTemplateColumns: '92px 1fr 42px' }}>
                    <span className="rpt-cbar-label">{c.label}</span>
                    <span className="rpt-cbar-track"><span className="rpt-cbar-fill" style={{ width: c.weight, background: theme.indigo }} /></span>
                    <span className="rpt-cbar-val">{c.weight}</span>
                  </div>
                ))}
              </div>
              <p className="rpt-kpi-prev" style={{ marginTop: 12 }}>
                Levels: 0–25 Beginner · 25–50 Explorer · 50–75 Practitioner · 75–100 AI Champion.
              </p>
            </div>
          </div>

          <div style={{ marginTop: 20 }}>
            <div className="rpt-card-head">
              <h3 className="rpt-card-title" style={{ fontSize: 14 }}>AI Champion candidates</h3>
              <span className="rpt-card-hint">Score ≥ 75 · with component breakdown</span>
            </div>
            {champions.length ? (
              <div className="rpt-champ-grid">
                {champions.map((u) => <ChampionCard key={u.userId} user={u} primary={theme.primary} />)}
              </div>
            ) : (
              <div className="rpt-empty"><div className="rpt-empty-card">
                <span className="rpt-empty-eyebrow">No champions yet</span>
                <h3>No users have reached the AI Champion level (75+)</h3>
                <p>Grow Practitioners toward mastery through enablement, then revisit — the leaderboard shows who is closest.</p>
              </div></div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default UserMaturity;
