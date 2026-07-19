import React, { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import { formatNumber, initialsOf } from '../utils/format';

const plain = (v, unit) => ({ value: v, unit, deltaPct: null, direction: 'flat' });

const GoldenCard = ({ g }) => {
  const tone = g.successRate >= 95 ? 'good' : 'warn';
  return (
    <div className="rpt-golden">
      <div className="rpt-golden-top">
        <span className="rpt-golden-id">Golden Prompt #{g.id}</span>
        <span className={`rpt-pill ${tone}`}>{g.successRate}% success</span>
      </div>
      <p className="rpt-golden-text" title={g.prompt}>{g.prompt || '(no prompt text)'}</p>
      <div className="rpt-golden-meta">
        <span className="rpt-user-cell">
          {g.creator?.avatar
            ? <img className="rpt-user-av" src={g.creator.avatar} alt="" style={{ width: 22, height: 22 }} />
            : <span className="rpt-user-av" style={{ width: 22, height: 22, fontSize: 10 }}>{initialsOf(g.creator?.name)}</span>}
          <span>{g.creator?.name || 'Unknown'}</span>
        </span>
        <span className="rpt-pill muted">{g.category}</span>
      </div>
      <div className="rpt-golden-stats">
        <div><span className="rpt-golden-stat">{formatNumber(g.uses)}</span><span className="rpt-golden-lab">uses</span></div>
        <div><span className="rpt-golden-stat">{formatNumber(g.uniqueUsers)}</span><span className="rpt-golden-lab">users</span></div>
        <div><span className="rpt-golden-stat" title="Department that uses it most">{g.recommendedFor}</span><span className="rpt-golden-lab">recommended for</span></div>
      </div>
    </div>
  );
};

const GoldenPrompts = ({ filters }) => {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('rank');
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'prompts', 'golden', filters],
    queryFn: () => reportsAPI.promptsGolden({ ...filters, limit: 90 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const stats = data?.stats || {};
  const golden = useMemo(() => {
    let list = data?.golden || [];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((g) => `${g.prompt} ${g.creator?.name} ${g.category} ${g.recommendedFor}`.toLowerCase().includes(q));
    if (sort === 'uses') list = [...list].sort((a, b) => b.uses - a.uses);
    else if (sort === 'success') list = [...list].sort((a, b) => b.successRate - a.successRate);
    return list;
  }, [data, query, sort]);

  return (
    <div>
      <SectionHeader
        title="Golden Prompt Library"
        subtitle="Proven, reusable prompts — used at least 3 times with ≥80% output success. Each is sourced to its creator and the team that relies on it most, ready to publish as a shared template."
      />

      {isError ? (
        <div className="rpt-error">Failed to load golden prompts: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Mining winning prompts…</div>
      ) : (
        <>
          <div className="rpt-kpi-grid">
            <KpiCard label="Golden Prompts" metric={plain(stats.goldenCount)} />
            <KpiCard label="Unique Prompts" metric={plain(stats.uniquePrompts)} />
            <KpiCard label="Reuse Rate" metric={plain(stats.reuseRate, '%')} format="pct" />
          </div>

          <div className="rpt-golden-controls">
            <label className="rpt-golden-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts, creators, categories…" />
            </label>
            <div className="rpt-date-presets">
              {['rank', 'uses', 'success'].map((s) => (
                <button key={s} type="button" className={`rpt-date-preset ${sort === s ? 'active' : ''}`} onClick={() => setSort(s)}>
                  {s === 'rank' ? 'Top' : s === 'uses' ? 'Most used' : 'Highest success'}
                </button>
              ))}
            </div>
          </div>

          {golden.length ? (
            <div className="rpt-golden-grid">
              {golden.map((g) => <GoldenCard key={g.id} g={g} />)}
            </div>
          ) : (
            <div className="rpt-empty"><div className="rpt-empty-card">
              <span className="rpt-empty-eyebrow">No golden prompts yet</span>
              <h3>No prompts meet the golden bar (3+ uses, ≥80% success) in this window</h3>
              <p>Widen the date range, or as reuse grows the best prompts will surface here automatically.</p>
            </div></div>
          )}
        </>
      )}
    </div>
  );
};

export default GoldenPrompts;
