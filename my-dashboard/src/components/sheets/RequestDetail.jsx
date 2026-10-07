import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sheetsAPI } from '../../services/sheets';
import { lineDiff } from '../../utils/lineDiff';
import { sheetUserColor, sheetUserInitials } from '../../utils/sheetUserColor';
import { formatWhen } from '../../utils/sheetFormat';

/** One content request: what people entered vs what Claude sent back. */

const EVENT_LABELS = {
  NEW_REQUEST: 'Created the request',
  INPUT_EDIT: 'Input',
  STRUCTURE_GENERATED: 'Optimized Structure generated',
  STRUCTURE_EDITED_BY_USER: 'Edited the Optimized Structure',
  APPROVED: 'Approved',
  DRAFT_STARTED: 'Drafting started',
  DELIVERED: 'Delivered',
  ERROR: 'Error',
  OTHER_STATUS_CHANGE: 'Status changed',
  OUTPUT_UPDATED: 'Output updated',
  IMPORTED: 'Imported',
  REMOVED: 'Row removed from the sheet',
};

const isUrl = (v) => /^https?:\/\//i.test(String(v || '').trim());

function Links({ value }) {
  const parts = String(value || '').split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return <span className="shs-muted">—</span>;
  return (
    <span className="shs-links">
      {parts.map((p) => (isUrl(p)
        ? <a key={p} href={p} target="_blank" rel="noopener noreferrer">{p.replace(/^https?:\/\//, '').slice(0, 60)}</a>
        : <span key={p}>{p}</span>))}
    </span>
  );
}

export function Actor({ event }) {
  if (event.actorType === 'claude') return <span className="shs-actor shs-actor--claude">Claude</span>;
  if (event.actorType === 'system') return <span className="shs-actor">Dashboard</span>;
  const email = event.actor?.email;
  const label = event.actor?.name || email || (event.actorType === 'user' ? 'Unknown user' : 'Unknown');
  return (
    <span className="shs-actor" title={email || 'Editor email not available'}>
      <span className="shs-avatar" style={{ background: sheetUserColor(email) }}>{sheetUserInitials(email)}</span>
      {label}
    </span>
  );
}

function Diff({ before, after }) {
  const rows = useMemo(() => lineDiff(before, after), [before, after]);
  return (
    <pre className="shs-diff">
      {rows.map((r, i) => (
        <div key={i} className={`shs-diff-${r.type}`}>{r.type === 'add' ? '+ ' : r.type === 'del' ? '− ' : '  '}{r.text}</div>
      ))}
    </pre>
  );
}

function Markdown({ text }) {
  return <div className="shs-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{text || ''}</ReactMarkdown></div>;
}

export default function RequestDetail({ sheetId, requestId, onBack }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    sheetsAPI.request(sheetId, requestId)
      .then((d) => { setData(d); setError(''); })
      .catch((err) => setError(err?.response?.data?.detail || 'Could not load this request.'));
  }, [sheetId, requestId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <div className="trp-error" role="alert">{error}</div>;
  if (!data) return <div className="trp-empty">Loading…</div>;

  const req = data.request;
  const inputs = data.values.filter((v) => v.side === 'input');
  const claudeVersion = data.claudeStructure;
  const current = data.currentStructure;

  return (
    <div className="shs-detail">
      <div className="shs-detail-head">
        <button type="button" className="shs-secondary-btn" onClick={onBack}>← Back to requests</button>
        <div>
          <h3>{req.topic || <em>(no topic)</em>}</h3>
          <p className="shs-muted">{req.tab} · row {req.rowNumber} · <StatusBadge status={req.status} error={req.error} /></p>
        </div>
      </div>
      {(req.stuck || req.error) && <div className="trp-error" role="alert">{req.error || req.stuck}</div>}
      {req.isImported && (
        <p className="shs-muted">This request was already in the sheet when it was registered, so its earlier history is unknown.</p>
      )}

      <ol className="shs-stages">
        {data.stages.map((s) => (
          <li key={s.stage} className={s.at ? 'shs-stage--done' : ''}>
            <strong>{s.stage}</strong>
            <span>{s.at ? formatWhen(s.at, true) : '—'}</span>
            {s.hoursSincePrevious != null && <small>+{s.hoursSincePrevious} h</small>}
          </li>
        ))}
      </ol>

      <div className="shs-sides">
        <section className="shs-side">
          <h4>User input</h4>
          <dl className="shs-values">
            {inputs.map((v) => (
              <div key={v.header}>
                <dt>{v.header}</dt>
                <dd>{v.isLink ? <Links value={v.value} /> : (v.value || <span className="shs-muted">—</span>)}</dd>
              </div>
            ))}
          </dl>
          <ul className="shs-timeline">
            {data.inputEvents.map((e) => (
              <li key={e.id}>
                <div className="shs-tl-head"><Actor event={e} /><span>{formatWhen(e.occurredAt, e.metadata?.approximateTime)}</span></div>
                <div>
                  {e.eventType === 'NEW_REQUEST' ? 'Entered the Topic' : (e.oldValue ? `Changed ${e.column}` : `Entered ${e.column}`)}
                </div>
                {e.oldValue
                  ? <div className="sha-diff"><span className="sha-old">{e.oldValue}</span><span className="sha-arrow">→</span><span className="sha-new">{e.newValue || '(cleared)'}</span></div>
                  : <div className="shs-value">{isUrl(e.newValue) || String(e.newValue || '').includes(',') ? <Links value={e.newValue} /> : e.newValue}</div>}
              </li>
            ))}
            {!data.inputEvents.length && <li className="shs-muted">No input changes recorded yet.</li>}
          </ul>
        </section>

        <section className="shs-side">
          <h4>Claude response</h4>
          <ul className="shs-timeline">
            {data.responseEvents.map((e) => (
              <li key={e.id} className={`shs-tl--${e.eventType.toLowerCase()}`}>
                <div className="shs-tl-head"><Actor event={e} /><span>{formatWhen(e.occurredAt, e.metadata?.approximateTime)}</span></div>
                <div><strong>{EVENT_LABELS[e.eventType] || e.eventType}</strong>
                  {e.metadata?.durationSeconds != null && <span className="shs-muted"> · {Math.round(e.metadata.durationSeconds / 360) / 10} h after the previous stage</span>}
                </div>
                {e.eventType === 'STRUCTURE_GENERATED' && e.newValue && <Markdown text={e.newValue} />}
                {e.eventType === 'STRUCTURE_EDITED_BY_USER' && <Diff before={e.oldValue} after={e.newValue} />}
                {e.eventType === 'DELIVERED' && (e.newValue ? <Links value={e.newValue} /> : null)}
                {e.eventType === 'ERROR' && <div className="trp-error">{e.metadata?.message || e.newValue}</div>}
                {['OTHER_STATUS_CHANGE', 'OUTPUT_UPDATED', 'APPROVED', 'DRAFT_STARTED'].includes(e.eventType) && (e.oldValue || e.newValue) && (
                  <div className="sha-diff"><span className="sha-old">{e.oldValue || '(empty)'}</span><span className="sha-arrow">→</span><span className="sha-new">{e.newValue || '(cleared)'}</span></div>
                )}
                {e.eventType === 'IMPORTED' && <div className="shs-muted">{e.metadata?.note}</div>}
              </li>
            ))}
            {!data.responseEvents.length && <li className="shs-muted">Claude hasn't responded yet.</li>}
          </ul>

          {claudeVersion && current && claudeVersion !== current && (
            <div className="shs-block">
              <h4>Current structure vs Claude's version</h4>
              <Diff before={claudeVersion} after={current} />
            </div>
          )}
          {!data.responseEvents.some((e) => e.eventType === 'STRUCTURE_GENERATED') && current && (
            <div className="shs-block"><h4>Optimized Structure</h4><Markdown text={current} /></div>
          )}
          {req.finalDocLink && <p><strong>Final doc:</strong> <Links value={req.finalDocLink} /></p>}
          <p className="shs-muted shs-small">
            Times marked ≈ are when the dashboard noticed the change (it reads the sheet every 90 seconds). Model and
            token usage aren't available because the scheduled Claude agent writes to the sheet directly.
          </p>
        </section>
      </div>
    </div>
  );
}

export function StatusBadge({ status, error }) {
  const key = error ? 'error' : String(status || 'New').toLowerCase().replace(/\s+/g, '-');
  return <span className={`shs-badge shs-badge--${key}`}>{error && status === 'Delivered' ? 'Delivered · no link' : status || 'New'}</span>;
}
