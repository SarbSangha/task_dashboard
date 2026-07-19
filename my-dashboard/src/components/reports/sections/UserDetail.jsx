import React, { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { generationRecordsAPI } from '../../../services/api';
import { formatNumber, formatFull, initialsOf } from '../utils/format';

const daysSince = (iso) => {
  if (!iso) return Infinity;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return Infinity;
  return Math.floor((Date.now() - dt.getTime()) / 86_400_000);
};

// Transparent, derived 0–100 indices (not stored metrics).
const engagementScore = (p) => {
  const vol = Math.min(60, Math.round(Math.pow(p.totalGenerations || 0, 0.6) * 6));
  const d = daysSince(p.lastActivityAt);
  const recency = d <= 2 ? 40 : d <= 7 ? 30 : d <= 30 ? 18 : 6;
  return Math.min(100, vol + recency);
};
const maturityScore = (p) => {
  const total = p.totalGenerations || 0;
  if (!total) return 0;
  const videoRatio = (p.videoCount || 0) / total; // richer/video output
  const projects = Math.min(1, (p.topProjects?.length || 0) / 5);
  const tags = Math.min(1, (p.topTags?.length || 0) / 8);
  return Math.round(videoRatio * 40 + projects * 30 + tags * 30);
};

const Meter = ({ value, tone = 'primary' }) => {
  const color = tone === 'success' ? 'var(--color-success)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-primary)';
  return (
    <div style={{ height: 8, borderRadius: 6, background: 'var(--color-secondary)', overflow: 'hidden', marginTop: 8 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', background: color, borderRadius: 6 }} />
    </div>
  );
};

const lastActiveLabel = (iso) => {
  const d = daysSince(iso);
  if (d === Infinity) return 'No recent activity';
  if (d === 0) return 'Active today';
  if (d === 1) return 'Active yesterday';
  return `Active ${d} days ago`;
};

const UserDetail = ({ userId, userName, onBack }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'userProfile', userId],
    queryFn: () => generationRecordsAPI.getUserProfile(userId),
    enabled: !!userId,
    staleTime: 60_000,
  });

  const p = data?.data;
  const eng = useMemo(() => (p ? engagementScore(p) : 0), [p]);
  const mat = useMemo(() => (p ? maturityScore(p) : 0), [p]);

  return (
    <div>
      <button className="rpt-back-btn" onClick={onBack}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        Back to Kling Intelligence
      </button>

      {isLoading && !p ? (
        <div className="rpt-loading">Loading user profile…</div>
      ) : isError ? (
        <div className="rpt-error">Failed to load profile: {error?.response?.data?.detail || error?.message}</div>
      ) : !p ? (
        <div className="rpt-loading">No profile found for {userName || `user #${userId}`}.</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
            {p.avatar
              ? <img className="rpt-user-av" style={{ width: 52, height: 52 }} src={p.avatar} alt="" />
              : <span className="rpt-user-av" style={{ width: 52, height: 52, fontSize: 18 }}>{initialsOf(p.name)}</span>}
            <div>
              <h2 className="rpt-sec-title" style={{ fontSize: 22 }}>{p.name}</h2>
              <p className="rpt-sec-sub" style={{ marginTop: 2 }}>
                <span className="rpt-pill muted">{p.department || 'Unassigned'}</span>{' '}
                {p.topModel && <span className="rpt-pill muted">Top model · {p.topModel}</span>}{' '}
                <span style={{ marginLeft: 6, fontSize: 12 }}>{lastActiveLabel(p.lastActivityAt)}</span>
              </p>
            </div>
          </div>

          <div className="rpt-kpi-grid">
            <div className="rpt-kpi"><div className="rpt-kpi-label">Total Generations</div><div className="rpt-kpi-value">{formatNumber(p.totalGenerations)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Videos</div><div className="rpt-kpi-value">{formatNumber(p.videoCount)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Images</div><div className="rpt-kpi-value">{formatNumber(p.imageCount)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Credits Consumed</div><div className="rpt-kpi-value">{formatFull(p.creditsBurned)}</div></div>
            <div className="rpt-kpi">
              <div className="rpt-kpi-label">Engagement Score</div>
              <div className="rpt-kpi-value">{eng}<span className="unit">/100</span></div>
              <Meter value={eng} tone="success" />
            </div>
            <div className="rpt-kpi">
              <div className="rpt-kpi-label">AI Maturity Score</div>
              <div className="rpt-kpi-value">{mat}<span className="unit">/100</span></div>
              <Meter value={mat} tone="primary" />
            </div>
          </div>

          <div className="rpt-grid cols-2">
            <div className="rpt-card">
              <div className="rpt-card-head"><h3 className="rpt-card-title">Top projects</h3></div>
              {(p.topProjects || []).length ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {p.topProjects.map((proj) => (
                    <li key={proj.projectId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{proj.name || 'Untitled project'}</span>
                      <b style={{ fontVariantNumeric: 'tabular-nums' }}>{formatNumber(proj.count)}</b>
                    </li>
                  ))}
                </ul>
              ) : <p className="rpt-kpi-prev">No project activity yet.</p>}
            </div>

            <div className="rpt-card">
              <div className="rpt-card-head"><h3 className="rpt-card-title">Signature styles (tags)</h3></div>
              {(p.topTags || []).length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {p.topTags.map((t) => (
                    <span key={t.tag} className="rpt-pill muted">{t.tag} · {t.count}</span>
                  ))}
                </div>
              ) : <p className="rpt-kpi-prev">No tags recorded.</p>}
            </div>
          </div>

          <p className="rpt-kpi-prev" style={{ marginTop: 14 }}>
            Engagement &amp; AI-maturity are derived indices (volume, recency, output richness and project/style diversity) — directional signals, not stored scores.
          </p>
        </>
      )}
    </div>
  );
};

export default UserDetail;
