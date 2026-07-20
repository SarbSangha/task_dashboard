import React, { useMemo, useState } from 'react';
import PromptDetailModal from './PromptDetailModal';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import { formatNumber, formatFull, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';

const plain = (v, unit) => ({ value: v, unit, deltaPct: null, direction: 'flat' });

// A card for any prompt (not just golden ones): the text, how often it was
// reused, how well it performed and how many people leaned on it.
const PromptCard = ({ p, onOpen }) => {
  const tone = p.successPct >= 95 ? 'good' : p.successPct >= 70 ? 'warn' : 'bad';
  return (
    <div
      className="rpt-golden rpt-prompt-card"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      title="See who used this prompt and what it produced"
    >
      <div className="rpt-golden-top">
        <span className="rpt-golden-id">Prompt #{p.rank}</span>
        <span className={`rpt-pill ${tone}`}>{p.successPct}% success</span>
      </div>
      <p className="rpt-golden-text" title={p.prompt}>{p.prompt || '(no prompt text)'}</p>
      <div className="rpt-golden-stats">
        <div><span className="rpt-golden-stat">{formatNumber(p.uses)}</span><span className="rpt-golden-lab">uses</span></div>
        <div><span className="rpt-golden-stat">{formatNumber(p.people)}</span><span className="rpt-golden-lab">users</span></div>
        <div><span className="rpt-golden-stat">{formatFull(p.credits)}</span><span className="rpt-golden-lab">credits</span></div>
      </div>
    </div>
  );
};

const GoldenCard = ({ g, onOpen }) => {
  const tone = g.successRate >= 95 ? 'good' : 'warn';
  return (
    <div
      className="rpt-golden rpt-prompt-card"
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen}
      onKeyDown={onOpen ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } } : undefined}
      title={onOpen ? 'See who used this prompt and what it produced' : undefined}
    >
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

const GoldenPrompts = ({ filters, onAddToCanvas }) => {
  const [openPrompt, setOpenPrompt] = useState(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState('rank');
  // 'golden' = the proven shortlist; 'all' = every prompt written; 'reused' =
  // only those used more than once. All three drill into the same detail view.
  const [scope, setScope] = useState('golden');
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'prompts', 'golden', filters],
    queryFn: () => reportsAPI.promptsGolden({ ...filters, limit: 90 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  // Every prompt written (or just the reused ones) — the library behind the
  // golden shortlist. Only fetched when that scope is actually open.
  const allQ = useQuery({
    queryKey: ['reports', 'prompts', 'list', scope, filters],
    queryFn: () => reportsAPI.promptsList({ ...filters, repeatedOnly: scope === 'reused', limit: 300 }),
    enabled: scope !== 'golden',
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

  const allPrompts = useMemo(() => {
    let list = allQ.data?.prompts || [];
    const q = query.trim().toLowerCase();
    if (q) list = list.filter((p) => (p.prompt || '').toLowerCase().includes(q));
    if (sort === 'success') list = [...list].sort((a, b) => b.successPct - a.successPct);
    else list = [...list].sort((a, b) => b.uses - a.uses); // 'rank' and 'uses' both mean most-used here
    return list;
  }, [allQ.data, query, sort]);

  const SCOPES = [
    { key: 'golden', label: `Golden (${formatNumber(stats.goldenCount ?? 0)})` },
    { key: 'all', label: `All prompts (${formatNumber(stats.uniquePrompts ?? 0)})` },
    { key: 'reused', label: 'Reused only' },
  ];

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
          {/* Level 1: the shortlist vs the whole library. Clicking Unique Prompts
              opens every prompt, not just the ones that cleared the golden bar. */}
          <div className="rpt-kpi-grid">
            <div
              role="button"
              tabIndex={0}
              className="rpt-kpi-drill"
              title="Show the proven shortlist"
              onClick={() => setScope('golden')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScope('golden'); } }}
            >
              <KpiCard label="Golden Prompts" metric={plain(stats.goldenCount)} />
            </div>
            <div
              role="button"
              tabIndex={0}
              className="rpt-kpi-drill"
              title="Show every prompt written in this period"
              onClick={() => setScope('all')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScope('all'); } }}
            >
              <KpiCard label="Unique Prompts" metric={plain(stats.uniquePrompts)} />
            </div>
            <div
              role="button"
              tabIndex={0}
              className="rpt-kpi-drill"
              title="Show only prompts that were reused"
              onClick={() => setScope('reused')}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setScope('reused'); } }}
            >
              <KpiCard label="Reuse Rate" metric={plain(stats.reuseRate, '%')} format="pct" />
            </div>
          </div>

          <div className="rpt-golden-controls">
            <label className="rpt-golden-search">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search prompts, creators, categories…" />
            </label>
            <div className="rpt-date-presets">
              {SCOPES.map((sc) => (
                <button key={sc.key} type="button" className={`rpt-date-preset ${scope === sc.key ? 'active' : ''}`} onClick={() => setScope(sc.key)}>
                  {sc.label}
                </button>
              ))}
            </div>
            <div className="rpt-date-presets">
              {['rank', 'uses', 'success'].map((s) => (
                <button key={s} type="button" className={`rpt-date-preset ${sort === s ? 'active' : ''}`} onClick={() => setSort(s)}>
                  {s === 'rank' ? 'Top' : s === 'uses' ? 'Most used' : 'Highest success'}
                </button>
              ))}
            </div>
            {onAddToCanvas && (
              <ToCanvasButton
                label="Move to canvas"
                title="Add this prompt list to the Report Builder"
                onClick={() => (scope === 'golden'
                  ? onAddToCanvas({ kind: 'live-golden-table' }, 'Golden prompt library')
                  : onAddToCanvas({ kind: 'live-prompt-list', repeatedOnly: scope === 'reused' }, scope === 'reused' ? 'Reused prompts' : 'All prompts'))}
              />
            )}
          </div>

          {scope === 'golden' ? (
            golden.length ? (
              <div className="rpt-golden-grid">
                {golden.map((g) => <GoldenCard key={g.id} g={g} onOpen={() => setOpenPrompt(g)} />)}
              </div>
            ) : (
              <div className="rpt-empty"><div className="rpt-empty-card">
                <span className="rpt-empty-eyebrow">No golden prompts yet</span>
                <h3>No prompts meet the golden bar (3+ uses, ≥80% success) in this window</h3>
                <p>Widen the date range, or as reuse grows the best prompts will surface here automatically.</p>
              </div></div>
            )
          ) : allQ.isLoading ? (
            <div className="rpt-loading">Loading prompts…</div>
          ) : allQ.isError ? (
            <div className="rpt-error">Failed to load prompts: {allQ.error?.response?.data?.detail || allQ.error?.message}</div>
          ) : allPrompts.length ? (
            <>
              <div className="rpt-card-head">
                <h3 className="rpt-card-title" style={{ fontSize: 14 }}>
                  {formatNumber(allPrompts.length)} {scope === 'reused' ? 'reused prompts' : 'prompts'}
                </h3>
                <span className="rpt-card-hint">
                  {formatNumber(allQ.data?.totals?.uses)} total uses · click any prompt to see who used it
                </span>
              </div>
              <div className="rpt-golden-grid">
                {allPrompts.map((p) => (
                  <PromptCard key={p.promptHash || p.rank} p={p} onOpen={() => setOpenPrompt(p)} />
                ))}
              </div>
            </>
          ) : (
            <div className="rpt-empty"><div className="rpt-empty-card">
              <span className="rpt-empty-eyebrow">Nothing to show</span>
              <h3>{scope === 'reused' ? 'No prompt was used more than once in this window' : 'No prompts in this window'}</h3>
              <p>Try widening the date range.</p>
            </div></div>
          )}
        </>
      )}

      {openPrompt && (
        <PromptDetailModal
          promptHash={openPrompt.promptHash}
          promptText={openPrompt.prompt}
          filters={filters}
          onClose={() => setOpenPrompt(null)}
          onAddToCanvas={onAddToCanvas}
        />
      )}
    </div>
  );
};

export default GoldenPrompts;
