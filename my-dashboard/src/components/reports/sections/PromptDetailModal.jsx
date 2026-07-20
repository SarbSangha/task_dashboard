import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import { formatNumber, formatFull, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';

const when = (iso) => (iso
  ? new Date(iso).toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '—');

const isVideo = (url) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '');

// The generated output for one run of the prompt. Videos play inline; anything
// else falls back to a link, since the asset host can expire CDN URLs.
const OutputTile = ({ gen }) => {
  const [failed, setFailed] = useState(false);
  const url = gen.assetUrl;

  return (
    <div className="rpt-card" style={{ padding: 8 }}>
      <div style={{
        aspectRatio: '16 / 9', background: 'var(--color-secondary)', borderRadius: 6,
        overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {url && isVideo(url) && !failed ? (
          <video
            src={url}
            poster={gen.thumbnailUrl || undefined}
            controls
            preload="metadata"
            onError={() => setFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : url && !failed ? (
          <img
            src={gen.thumbnailUrl || url}
            alt=""
            onError={() => setFailed(true)}
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <span className="rpt-kpi-prev" style={{ fontSize: 11, textAlign: 'center', padding: 8 }}>
            {url ? 'Preview unavailable' : 'No asset captured'}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 6, fontSize: 11 }}>
        <span className="rpt-muted">{when(gen.time)}</span>
        <span className={`rpt-pill ${gen.success ? 'good' : 'bad'}`}>{gen.success ? 'ok' : gen.status || 'failed'}</span>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 3, fontSize: 11 }}>
        <span className="rpt-muted">{gen.userName}</span>
        <span className="rpt-muted">{gen.credits == null ? '—' : `${formatFull(gen.credits)} cr`}</span>
      </div>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="rpt-muted"
          style={{ fontSize: 11, display: 'inline-block', marginTop: 4 }}
        >
          Open original ↗
        </a>
      )}
    </div>
  );
};

// Everything behind one prompt: who used it, and the output it produced.
const PromptDetailModal = ({ promptHash, promptText, filters, onClose, onAddToCanvas }) => {
  const [tab, setTab] = useState('people');
  const q = useQuery({
    queryKey: ['reports', 'prompts', 'detail', promptHash, filters],
    queryFn: () => reportsAPI.promptDetail({ ...filters, hash: promptHash, limit: 120 }),
    enabled: !!promptHash,
    staleTime: 60_000,
  });

  const d = q.data || {};
  const t = d.totals || {};
  const users = d.users || [];
  const gens = d.generations || [];

  return (
    <>
      <div className="rpt-overlay" onClick={onClose} style={{ zIndex: 60 }} />
      <div
        className="rpt-prompt-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Prompt detail"
      >
        <div className="rpt-card-head" style={{ marginBottom: 10 }}>
          <h3 className="rpt-card-title">Prompt detail</h3>
          {onAddToCanvas && (
            <ToCanvasButton
              label="Move to canvas"
              title="Add this prompt breakdown to the Report Builder"
              onClick={() => onAddToCanvas(
                { kind: 'live-prompt-detail', promptHash, promptText: promptText || d.prompt },
                'Prompt detail',
              )}
            />
          )}
          <button className="rpt-mini-btn" onClick={onClose}>Close</button>
        </div>

        <p className="rpt-prompt-text">{promptText || d.prompt || ''}</p>

        {q.isLoading && <p className="rpt-kpi-prev">Loading prompt detail…</p>}
        {q.isError && (
          <p className="rpt-error">
            Failed to load: {q.error?.response?.data?.detail || q.error?.message}
          </p>
        )}

        {!q.isLoading && !q.isError && (
          <>
            <div className="rpt-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
              <div className="rpt-kpi"><div className="rpt-kpi-label">Uses</div><div className="rpt-kpi-value">{formatNumber(t.uses)}</div></div>
              <div className="rpt-kpi"><div className="rpt-kpi-label">People</div><div className="rpt-kpi-value">{formatNumber(t.people)}</div></div>
              <div className="rpt-kpi"><div className="rpt-kpi-label">Success</div><div className="rpt-kpi-value">{t.successPct}<span className="unit">%</span></div></div>
              <div className="rpt-kpi"><div className="rpt-kpi-label">Credits</div><div className="rpt-kpi-value">{formatFull(t.credits)}</div></div>
            </div>

            <div className="rpt-date-presets" style={{ marginBottom: 12 }}>
              <button
                type="button"
                className={`rpt-date-preset ${tab === 'people' ? 'active' : ''}`}
                onClick={() => setTab('people')}
              >
                Who used it ({formatNumber(t.people)})
              </button>
              <button
                type="button"
                className={`rpt-date-preset ${tab === 'output' ? 'active' : ''}`}
                onClick={() => setTab('output')}
              >
                Output ({formatNumber(t.withAsset)})
              </button>
            </div>

            {tab === 'people' && (
              users.length === 0 ? <p className="rpt-kpi-prev">No usage in this period.</p> : (
                <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                      <th style={{ padding: '6px 4px', width: 34 }}>#</th>
                      <th style={{ padding: '6px 4px' }}>User</th>
                      <th style={{ padding: '6px 4px' }}>Department</th>
                      <th style={{ padding: '6px 4px', textAlign: 'right' }}>Uses</th>
                      <th style={{ padding: '6px 4px', textAlign: 'right' }}>Success</th>
                      <th style={{ padding: '6px 4px', textAlign: 'right' }}>Credits</th>
                      <th style={{ padding: '6px 4px' }}>Last used</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((u) => (
                      <tr key={u.userId} style={{ borderTop: '1px solid var(--color-border)' }}>
                        <td style={{ padding: '6px 4px' }}><span className={`rpt-rank ${u.rank <= 3 ? 'top' : ''}`}>{u.rank}</span></td>
                        <td style={{ padding: '6px 4px' }}>
                          <span className="rpt-user-cell">
                            {u.avatar
                              ? <img className="rpt-user-av" src={u.avatar} alt="" />
                              : <span className="rpt-user-av">{initialsOf(u.name)}</span>}
                            <span>{u.name}</span>
                          </span>
                        </td>
                        <td style={{ padding: '6px 4px' }}><span className="rpt-pill muted">{u.department}</span></td>
                        <td style={{ padding: '6px 4px', textAlign: 'right' }}><b>{formatNumber(u.uses)}</b></td>
                        <td style={{ padding: '6px 4px', textAlign: 'right' }}>{u.successPct}%</td>
                        <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(u.credits)}</td>
                        <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{when(u.lastAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )
            )}

            {tab === 'output' && (
              gens.length === 0 ? <p className="rpt-kpi-prev">No captured output for this prompt.</p> : (
                <>
                  <div className="rpt-output-grid">
                    {gens.map((g) => <OutputTile key={g.generationId} gen={g} />)}
                  </div>
                  {d.generationsTruncated && (
                    <p className="rpt-kpi-prev" style={{ marginTop: 8 }}>
                      Showing the first {formatNumber(gens.length)} of {formatNumber(t.uses)} runs.
                    </p>
                  )}
                </>
              )
            )}
          </>
        )}
      </div>
    </>
  );
};

export default PromptDetailModal;
