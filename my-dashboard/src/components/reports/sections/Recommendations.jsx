import React, { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import { formatNumber } from '../utils/format';

const TYPES = ['All', 'Tool', 'Prompt', 'Department', 'User', 'Training', 'Cost'];

const TYPE_CLASS = {
  Tool: 'tool', Prompt: 'prompt', Department: 'dept', User: 'user', Training: 'training', Cost: 'cost',
};
const IMPACT_CLASS = { High: 'good', Medium: 'warn', Low: 'muted' };
const bandClass = (b) => (b === 'High' ? 'good' : b === 'Medium' ? 'warn' : 'muted');

const RecCard = ({ r, state, onAct }) => (
  <div className={`rpt-rec ${state ? `is-${state}` : ''}`}>
    <div className="rpt-rec-top">
      <span className={`rpt-rec-type ${TYPE_CLASS[r.type] || 'user'}`}>{r.type}</span>
      <span className={`rpt-pill ${bandClass(r.confidenceBand)}`} title="Heuristic confidence: data volume × effect size">
        {r.confidenceBand} confidence · {r.confidence}
      </span>
      <span className={`rpt-pill ${IMPACT_CLASS[r.expectedImpact] || 'muted'}`} style={{ marginLeft: 'auto' }}>
        {r.expectedImpact} impact
      </span>
    </div>

    <h3 className="rpt-rec-title">{r.title}</h3>
    <p className="rpt-rec-action">{r.action}</p>

    <ul className="rpt-rec-reasons">
      {(r.reason || []).map((x, i) => <li key={i}>{x}</li>)}
    </ul>

    <div className="rpt-rec-foot">
      <span className="rpt-pill muted">Target: {r.targets}</span>
      {state ? (
        <span className={`rpt-rec-state ${state}`}>{state === 'accepted' ? '✓ Accepted' : '✕ Dismissed'} <button className="rpt-rec-undo" onClick={() => onAct(r.id, null)}>undo</button></span>
      ) : (
        <span className="rpt-rec-actions">
          <button className="rpt-rec-btn accept" onClick={() => onAct(r.id, 'accepted')}>Accept</button>
          <button className="rpt-rec-btn dismiss" onClick={() => onAct(r.id, 'dismissed')}>Dismiss</button>
        </span>
      )}
    </div>
  </div>
);

const Recommendations = ({ filters }) => {
  const [type, setType] = useState('All');
  const [actions, setActions] = useState({}); // session-local only (not persisted)

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'recommendations', filters],
    queryFn: () => reportsAPI.recommendations(filters),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const all = data?.recommendations || [];
  const summary = data?.summary || {};
  const list = type === 'All' ? all : all.filter((r) => r.type === type);
  const onAct = (id, state) => setActions((a) => ({ ...a, [id]: state }));

  return (
    <div>
      <SectionHeader
        title="AI Recommendations"
        subtitle="Evidence-based, confidence-scored actions derived from the real signals across this platform — tools, prompts, adoption, maturity, cost and tasks. Suggestions, not predictions of causation."
      />

      {isError ? (
        <div className="rpt-error">Failed to load recommendations: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading && !data ? (
        <div className="rpt-loading">Generating recommendations…</div>
      ) : (
        <>
          <div className="rpt-kpi-grid">
            <div className="rpt-kpi"><div className="rpt-kpi-label">Recommendations</div><div className="rpt-kpi-value">{formatNumber(summary.total)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">High Confidence</div><div className="rpt-kpi-value">{formatNumber(summary.highConfidence)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Accepted (session)</div><div className="rpt-kpi-value">{Object.values(actions).filter((s) => s === 'accepted').length}</div></div>
          </div>

          <div className="rpt-filters" style={{ padding: '0 0 14px', border: 0, background: 'transparent' }}>
            <div className="rpt-date-presets">
              {TYPES.map((t) => {
                const count = t === 'All' ? all.length : all.filter((r) => r.type === t).length;
                return (
                  <button key={t} type="button" className={`rpt-date-preset ${type === t ? 'active' : ''}`} onClick={() => setType(t)}>
                    {t}{t !== 'All' && count ? ` · ${count}` : ''}
                  </button>
                );
              })}
            </div>
          </div>

          {list.length ? (
            <div className="rpt-rec-grid">
              {list.map((r) => <RecCard key={r.id} r={r} state={actions[r.id]} onAct={onAct} />)}
            </div>
          ) : (
            <div className="rpt-empty"><div className="rpt-empty-card">
              <span className="rpt-empty-eyebrow">Nothing to recommend</span>
              <h3>No {type === 'All' ? '' : `${type.toLowerCase()} `}recommendations meet the evidence bar in this window</h3>
              <p>Widen the date range or department scope — recommendations appear when the underlying signals are strong enough to be actionable.</p>
            </div></div>
          )}

          <p className="rpt-kpi-prev" style={{ marginTop: 16 }}>
            {data?.note || 'Evidence-based suggestions. Confidence is heuristic, not statistical.'} Accept/Dismiss is session-local and not yet persisted — acceptance &amp; outcome tracking is the next architectural dependency.
          </p>
        </>
      )}
    </div>
  );
};

export default Recommendations;
