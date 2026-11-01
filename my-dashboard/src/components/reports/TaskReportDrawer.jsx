import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { reportsAPI } from '../../services/reports';
import { formatDateTimeIndia } from '../../utils/dateTime';
import { getAvatarHue, getInitials } from '../../utils/taskPresentation';
import { DEADLINE_BADGES } from './taskReportShared';

/**
 * Everything recorded about one task, opened from the Task Report: who is
 * involved, the brief and result, workflow stages, the full status timeline
 * and the latest comments (GET /api/reports/task-report/tasks/{id}).
 */

function PersonRow({ label, people }) {
  if (!people || people.length === 0) return null;
  return (
    <div className="tr2d-people-row">
      <span className="tr2d-label">{label}</span>
      <div className="tr2d-people">
        {people.map((p) => (
          <span key={p.id} className="tr2d-person" title={p.department || undefined}>
            <span className="tr2-avatar" style={{ width: 24, height: 24, '--hue': getAvatarHue(p.name) }} aria-hidden="true">{getInitials(p.name)}</span>
            <span>
              <strong>{p.name}</strong>
              {p.department && <em>{p.department}</em>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Fact({ label, children }) {
  return (
    <div className="tr2d-fact">
      <span className="tr2d-label">{label}</span>
      <span className="tr2d-value">{children || '—'}</span>
    </div>
  );
}

export default function TaskReportDrawer({ taskId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    reportsAPI.taskReportDetail(taskId)
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => { if (!cancelled) setError(err?.response?.data?.detail || 'Could not load this task.'); });
    return () => { cancelled = true; };
  }, [taskId]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const task = data?.task;
  const badge = task ? (DEADLINE_BADGES[task.deadlineState] || DEADLINE_BADGES.no_deadline) : null;

  return createPortal(
    <div className="tr2d-overlay" onClick={onClose}>
      <aside className="tr2d" role="dialog" aria-modal="true" aria-label="Task details" onClick={(e) => e.stopPropagation()}>
        <header className="tr2d-head">
          <div className="tr2d-head-copy">
            <span className="tr2d-number">{task?.taskNumber || 'Task'}</span>
            <h3>{task?.title || (error ? 'Task' : 'Loading…')}</h3>
            {task && (
              <div className="tr2d-head-badges">
                <span className={`tr2-status tr2-status--${task.status}`}>{task.statusLabel}</span>
                {task.priority && <span className={`tr2d-priority tr2d-priority--${task.priority}`}>{task.priority} priority</span>}
                <span className={`tr2-badge tr2-badge--${badge.tone}`}>{badge.label}</span>
                {task.category && <span className="tr2-tag">{task.category}</span>}
              </div>
            )}
          </div>
          <button type="button" className="tr2d-close" onClick={onClose} aria-label="Close task details">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </header>

        <div className="tr2d-body">
          {error && <div className="tr2-error" role="alert">{error}</div>}
          {!task && !error && <div className="tr2-empty">Loading task…</div>}

          {task && (
            <>
              <section className="tr2d-section">
                <h4>People</h4>
                <PersonRow label="Assigned by" people={task.assignedBy ? [task.assignedBy] : []} />
                <PersonRow label="Assignees" people={task.assignees} />
                <PersonRow label="HOD" people={task.hods} />
                <PersonRow label="Approvers" people={task.approvers} />
                {task.assignees.length === 0 && <p className="tr2-muted">Nobody is assigned yet.</p>}
              </section>

              <section className="tr2d-section">
                <h4>Details</h4>
                <div className="tr2d-facts">
                  <Fact label="Project">{task.projectName}</Fact>
                  <Fact label="Department">{task.toDepartment}</Fact>
                  <Fact label="From department">{task.fromDepartment}</Fact>
                  <Fact label="Created">{task.createdAt && formatDateTimeIndia(task.createdAt)}</Fact>
                  <Fact label="Deadline">{task.deadline && formatDateTimeIndia(task.deadline)}</Fact>
                  <Fact label="Started">{task.startedAt && formatDateTimeIndia(task.startedAt)}</Fact>
                  <Fact label="Submitted">{task.submittedAt && formatDateTimeIndia(task.submittedAt)}</Fact>
                  <Fact label="Completed">{task.completedAt && formatDateTimeIndia(task.completedAt)}</Fact>
                  <Fact label={['completed', 'approved'].includes(task.status) ? 'Days to finish' : 'Days open'}>{task.ageDays != null ? `${task.ageDays}` : null}</Fact>
                  <Fact label="Comments">{String(task.commentCount)}</Fact>
                </div>
              </section>

              {task.description && (
                <section className="tr2d-section">
                  <h4>Brief</h4>
                  <p className="tr2d-text">{task.description}</p>
                </section>
              )}
              {task.resultText && (
                <section className="tr2d-section">
                  <h4>Result</h4>
                  <p className="tr2d-text">{task.resultText}</p>
                </section>
              )}

              {data.stages.length > 0 && (
                <section className="tr2d-section">
                  <h4>Workflow stages</h4>
                  <ol className="tr2d-stages">
                    {data.stages.map((s) => (
                      <li key={s.order} className={`tr2d-stage tr2d-stage--${s.status}`}>
                        <span className="tr2d-stage-no">{s.order}</span>
                        <span className="tr2d-stage-title">{s.title}{s.final && <em> · final</em>}</span>
                        <span className="tr2d-stage-status">{(s.status || '').replace(/_/g, ' ')}</span>
                      </li>
                    ))}
                  </ol>
                </section>
              )}

              <section className="tr2d-section">
                <h4>Timeline <span className="tr2-muted">({data.history.length})</span></h4>
                {data.history.length === 0 ? <p className="tr2-muted">No status changes recorded.</p> : (
                  <ol className="tr2d-timeline">
                    {data.history.map((h, index) => (
                      <li key={`${h.at}-${index}`}>
                        <span className={`tr2d-tl-dot tr2-seg--${(h.to || '').toLowerCase()}`} aria-hidden="true" />
                        <div>
                          <div className="tr2d-tl-line">
                            <strong>{h.toLabel || h.action || 'Update'}</strong>
                            {h.from && h.from !== h.to && <span className="tr2-muted">from {h.fromLabel}</span>}
                          </div>
                          <div className="tr2d-tl-meta">{h.by || 'System'} · {h.at ? formatDateTimeIndia(h.at) : '—'}</div>
                          {h.comments && <p className="tr2d-tl-note">{h.comments}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                )}
              </section>

              {data.comments.length > 0 && (
                <section className="tr2d-section">
                  <h4>Comments <span className="tr2-muted">({data.comments.length})</span></h4>
                  <ul className="tr2d-comments">
                    {data.comments.map((c) => (
                      <li key={c.id}>
                        <div className="tr2d-tl-meta"><strong>{c.by || 'Someone'}</strong> · {c.at ? formatDateTimeIndia(c.at) : ''}{c.internal && ' · internal'}</div>
                        <p className="tr2d-text">{c.text}</p>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          )}
        </div>
      </aside>
    </div>,
    document.body,
  );
}
