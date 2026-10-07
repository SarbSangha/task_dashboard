import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, ComposedChart, Legend, Line, ReferenceArea, ResponsiveContainer, Scatter, Tooltip, XAxis, YAxis } from 'recharts';
import { sheetsAPI } from '../../services/sheets';
import { AI_LABELS, formatWhen } from '../../utils/sheetFormat';
import { Actor } from './RequestDetail';

/** One keyword: position over time, AI Overview history, found URLs, every edit. */

const EVENT_LABELS = {
  IMPORTED: 'Already in the sheet when tracking began',
  KEYWORD_ADDED: 'Added the keyword',
  KEYWORD_EDITED: 'Edited the keyword',
  KEYWORD_REMOVED: 'Removed the keyword',
  URL_CHANGED: 'Live URL changed',
  MANUAL_RESULT_OVERRIDE: 'Result changed by hand',
  RESULT_UPDATED: 'Result updated by the job',
};

export function Movement({ change }) {
  if (!change) return null;
  const { direction, delta } = change;
  if (direction === 'improved') return <span className="shr-up" title={`Up ${delta}`}>▲ {delta}</span>;
  if (direction === 'dropped') return <span className="shr-down" title={`Down ${Math.abs(delta)}`}>▼ {Math.abs(delta)}</span>;
  if (direction === 'same') return <span className="shs-muted">=</span>;
  if (direction === 'new') return <span className="shs-muted">new</span>;
  if (direction === 'not_comparable') return <span className="shs-muted" title="The two runs searched to different depths (top 10 vs top 50)">n/c</span>;
  return <span className="shs-muted">—</span>;
}

export default function KeywordDetail({ sheetId, keywordId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    sheetsAPI.rankingKeyword(sheetId, keywordId)
      .then((d) => { setData(d); setError(''); })
      .catch((err) => setError(err?.response?.data?.detail || 'Could not load this keyword.'));
  }, [sheetId, keywordId]);

  const chart = useMemo(() => {
    if (!data) return { rows: [], maxDepth: 10 };
    const maxDepth = Math.max(10, ...data.history.map((h) => h.depth || 0));
    const rows = data.history.map((h) => ({
      date: h.checkDate.slice(5),
      label: h.label,
      ranked: h.bucket === 'ranked' ? h.position : null,
      out: h.bucket.startsWith('not_in_top_') ? h.depth + 1 : null,
      display: h.display,
    }));
    return { rows, maxDepth };
  }, [data]);

  if (error) return <div className="trp-error" role="alert">{error}</div>;
  if (!data) return <div className="trp-empty">Loading…</div>;
  const kw = data.keyword;

  return (
    <div className="shs-detail">
      <div className="shs-detail-head">
        <button type="button" className="shs-secondary-btn" onClick={onBack}>← Back to keywords</button>
        <div>
          <h3>{kw.keyword}</h3>
          <p className="shs-muted">
            {kw.tab} · row {kw.rowNumber}
            {kw.targetUrl && <> · ranking page <a href={kw.targetUrl} target="_blank" rel="noopener noreferrer">{kw.targetUrl.replace(/^https?:\/\//, '')}</a></>}
            {!kw.isActive && <span className="shs-warn"> · removed from the sheet</span>}
          </p>
          <p className="shs-muted">
            {kw.isImported ? 'Already in the sheet when tracking began' : `Added by ${kw.addedBy?.name || kw.addedBy?.email || 'Unknown user'} · ${formatWhen(kw.addedAt, !kw.addedBy?.email)}`}
          </p>
        </div>
      </div>
      {data.duplicates.length > 0 && (
        <div className="trp-error" role="alert">This keyword appears {data.duplicates.length + 1} times on {kw.tab} (rows {[kw.rowNumber, ...data.duplicates.map((d) => d.rowNumber)].join(', ')}).</div>
      )}

      <section className="sha-section">
        <h3>Position over time <span className="shs-muted">(1 is the top; the shaded band means not ranked within the depth that run checked)</span></h3>
        <div className="sha-chart">
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart data={chart.rows} margin={{ top: 8, right: 16, left: -8, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis reversed domain={[1, chart.maxDepth + 2]} allowDecimals={false} tick={{ fontSize: 11 }} />
              <ReferenceArea y1={10.5} y2={chart.maxDepth + 2} fill="#f87171" fillOpacity={0.08} />
              <Tooltip formatter={(v, name, p) => [p?.payload?.display, p?.payload?.label]} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Line type="monotone" dataKey="ranked" name="Position" stroke="#2563eb" strokeWidth={2} dot={{ r: 3 }} connectNulls={false} />
              <Scatter dataKey="out" name="Not in top N" fill="#dc2626" shape="cross" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="sha-section">
        <h3>Every run</h3>
        <div className="trp-table-wrap">
          <table className="trp-table">
            <thead><tr><th>Run</th><th>Trigger</th><th>Position</th><th>Change</th><th>AI Overview</th><th>Ranking page</th><th>Raw values</th></tr></thead>
            <tbody>
              {[...data.history].reverse().map((h) => (
                <tr key={h.runId} className={h.isOverride ? 'shs-row--stuck' : ''}>
                  <td>{h.label || h.checkDate}{h.isOverride && <div className="shs-warn">changed after the run</div>}</td>
                  <td>{h.trigger}</td>
                  <td><strong>{h.display}</strong></td>
                  <td><Movement change={h.change} /></td>
                  <td><span className={`shr-ai shr-ai--${h.aiState}`}>{AI_LABELS[h.aiState] || h.aiState}</span></td>
                  <td>
                    {h.foundUrl ? <a href={h.foundUrl} target="_blank" rel="noopener noreferrer">{h.foundUrl.replace(/^https?:\/\//, '').slice(0, 50)}</a> : <span className="shs-muted">—</span>}
                    {h.pageChanged && <div className="shs-warn">different page from the previous run</div>}
                  </td>
                  <td className="shs-muted">{[h.rawPosition, h.rawAi].filter(Boolean).join(' / ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="shs-muted shs-small">
          The ranking page is the Live URL the job wrote when that run was read (or the URL the job reported). Runs from
          before tracking began only have it for the latest run.
        </p>
      </section>

      <section className="sha-section">
        <h3>Who added and changed it</h3>
        <ul className="shs-timeline">
          {data.events.map((e) => (
            <li key={e.id} className={e.eventType === 'MANUAL_RESULT_OVERRIDE' ? 'shs-tl--error' : ''}>
              <div className="shs-tl-head"><Actor event={e} /><span>{formatWhen(e.occurredAt, e.metadata?.approximateTime)}</span></div>
              <div><strong>{EVENT_LABELS[e.eventType] || e.eventType}</strong>{e.column && <span className="shs-muted"> · {e.column}</span>}</div>
              {(e.oldValue || e.newValue) && e.eventType !== 'IMPORTED' && (
                <div className="sha-diff"><span className="sha-old">{e.oldValue || '(empty)'}</span><span className="sha-arrow">→</span><span className="sha-new">{e.newValue || '(removed)'}</span></div>
              )}
              {e.metadata?.reason && <div className="shs-muted">{e.metadata.reason}</div>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
