import React, { useState } from 'react';
import './InboxCard.css';
import { formatDateTimeIndia } from '../../../../utils/dateTime';

const InboxCard = ({ task, onTrackClick, onTaskAction, onOpenChat }) => {
  const apiBase = import.meta.env.VITE_API_URL || 'http://localhost:8000';
  const [menuOpen, setMenuOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copiedKey, setCopiedKey] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  const isRevoked = task.status === 'cancelled' && !!(task.revocation || `${task.workflowStage || ''}`.includes('revoked'));
  const revokedBy = task.revocation?.revokedBy || task.creator?.name || 'Creator';
  const revokedAt = task.revocation?.revokedAt ? formatDateTimeIndia(task.revocation.revokedAt) : '';
  const revokedReason = task.revocation?.reason || '';

  const baseActions = (task.availableActions || []).filter((action) => {
    if (action !== 'edit_task') return true;
    return task.status === 'need_improvement';
  });
  const canShowStartTask =
    task.myRole === 'assignee' &&
    !['completed', 'cancelled', 'rejected'].includes(task.status);
  const canShowSubmitTask =
    task.myRole === 'assignee' &&
    !['completed', 'cancelled', 'rejected', 'submitted'].includes(task.status);
  const withStart = canShowStartTask && !baseActions.includes('start')
    ? ['start', ...baseActions]
    : baseActions;
  const computedActions = canShowSubmitTask && !withStart.includes('submit')
    ? [...withStart, 'submit']
    : withStart;
  const actions = isRevoked ? [] : computedActions;
  const assignedNames = (task.assignedTo || []).map((x) => x.name).join(', ') || 'Unassigned';
  const description = task.description || '';
  const shortDescription = description.length > 120 ? `${description.slice(0, 120)}...` : description;
  const requestTypeLabel = (() => {
    const type = (task.taskType || 'task').toLowerCase();
    if (type === 'task_approval') return 'Task Approval';
    if (type === 'submission_result') return 'Submission Result';
    return 'Task';
  })();
  const actionLabel = (action) => {
    if (action === 'start') return 'Start Task';
    if (action === 'submit') return 'Submit Task';
    if (action === 'forward') return 'Forward To';
    return action.replace(/_/g, ' ');
  };
  const buildFileActionUrl = (file, action, fallbackName) => {
    const params = new URLSearchParams();
    if (file?.url) params.set('url', file.url);
    if (file?.path) params.set('path', file.path);
    if (action === 'download') {
      params.set('filename', fallbackName || file?.originalName || file?.filename || 'download');
    }
    return `${apiBase}/api/files/${action}?${params.toString()}`;
  };
  const forceDownload = (file, filename) => {
    const downloadUrl = buildFileActionUrl(file, 'download', filename);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };
  const copyToClipboard = async (text, key) => {
    const value = `${text || ''}`.trim();
    if (!value) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
      } else {
        const temp = document.createElement('textarea');
        temp.value = value;
        document.body.appendChild(temp);
        temp.select();
        document.execCommand('copy');
        document.body.removeChild(temp);
      }
      setCopiedKey(key);
      setToastMessage('Copied to clipboard');
      window.setTimeout(() => setCopiedKey(''), 1200);
      window.setTimeout(() => setToastMessage(''), 1400);
    } catch (error) {
      console.warn('Copy failed:', error);
    }
  };

  return (
    <div className={`inbox-card ${isRevoked ? 'revoked-card' : ''}`}>
      <div className="card-header">
        <div>
          <h3 className="card-title">{task.title}</h3>
          <p className="card-subtitle">{shortDescription}</p>
        </div>
        <div className="card-menu-wrap">
          <button className="card-menu-btn" onClick={() => setMenuOpen((s) => !s)}>⋮</button>
          {menuOpen && (
            <div className="card-menu">
              {actions.map((action) => (
                <button
                  key={action}
                  onClick={() => {
                    setMenuOpen(false);
                    if (action === 'chat') onOpenChat(task);
                    else onTaskAction(task, action);
                  }}
                >
                  {actionLabel(action)}
                </button>
              ))}
              {actions.length === 0 && <span className="card-menu-empty">No actions</span>}
            </div>
          )}
        </div>
      </div>
      {isRevoked && (
        <div className="revoked-banner">
          <strong>This task has been revoked (regularised).</strong>
          <span>
            {` By ${revokedBy}${revokedAt ? ` on ${revokedAt}` : ''}${revokedReason ? `. Reason: ${revokedReason}` : ''}`}
          </span>
        </div>
      )}

      <div className="card-grid">
        <span><strong>Task ID:</strong> {task.taskNumber || '-'}</span>
        <span><strong>Project ID:</strong> {task.projectId || '-'}</span>
        <span><strong>Creator:</strong> {task.creator?.name || 'Unknown'} ({task.creator?.department || 'N/A'})</span>
        <span><strong>Status:</strong> {(task.status || '').replace(/_/g, ' ')}</span>
        <span><strong>Assigned To:</strong> {assignedNames}</span>
        <span><strong>Request Type:</strong> {requestTypeLabel}</span>
        <span><strong>Chat:</strong> {task.chatCount || 0}</span>
        <span><strong>Created:</strong> {task.createdAt ? formatDateTimeIndia(task.createdAt) : '-'}</span>
        <span><strong>Updated:</strong> {task.updatedAt ? formatDateTimeIndia(task.updatedAt) : '-'}</span>
      </div>

      {expanded && (
        <div className="card-details">
          <div><strong>Project Name:</strong> {task.projectName || '-'}</div>
          <div><strong>Customer Name:</strong> {task.customerName || '-'}</div>
          <div className="full-span"><strong>Reference:</strong> {task.reference || '-'}</div>
          <div className="full-span">
            <div className="detail-head">
              <strong>Task Details:</strong>
              <button
                type="button"
                className="mini-action-btn"
                onClick={() => copyToClipboard(task.description, 'task-details')}
                disabled={!task.description}
              >
                {copiedKey === 'task-details' ? 'Copied' : 'Copy'}
              </button>
            </div>
            <div className="forward-item">{task.description || '-'}</div>
          </div>
          <div><strong>Deadline:</strong> {task.deadline ? formatDateTimeIndia(task.deadline) : 'Not set'}</div>
          <div><strong>Priority:</strong> {task.priority || '-'}</div>
          <div><strong>Request Type:</strong> {requestTypeLabel}</div>
          <div><strong>Tag:</strong> {task.taskTag || '-'}</div>
          <div><strong>From Department:</strong> {task.fromDepartment || '-'}</div>
          <div><strong>To Department:</strong> {task.toDepartment || '-'}</div>
          <div><strong>Workflow Stage:</strong> {task.workflowStage || '-'}</div>
          <div><strong>Created By:</strong> {task.creator?.name || '-'}</div>
          <div><strong>Last Forwarded By:</strong> {task.lastForwardedBy || '-'}</div>
          <div className="forward-history">
            <strong>Task Links:</strong>
            {(task.links || []).length === 0 && <div className="forward-item">-</div>}
            {(task.links || []).map((link, idx) => (
              <div key={`${link}-${idx}`} className="forward-item">
                <span>{link}</span>
                <span className="attachment-actions">
                  <a href={link} target="_blank" rel="noreferrer">Open</a>
                  <button
                    type="button"
                    className="mini-action-btn"
                    onClick={() => copyToClipboard(link, `task-link-${idx}`)}
                  >
                    {copiedKey === `task-link-${idx}` ? 'Copied' : 'Copy Link'}
                  </button>
                </span>
              </div>
            ))}
          </div>
          <div className="forward-history">
            <strong>Task Attachments:</strong>
            {(task.attachments || []).length === 0 && <div className="forward-item">No attachments</div>}
            {(task.attachments || []).map((file, idx) => (
              <div key={`${file?.url || file?.filename || idx}-${idx}`} className="forward-item">
                <span>{file?.originalName || file?.filename || `Attachment ${idx + 1}`}</span>
                <span className="attachment-actions">
                  <a href={buildFileActionUrl(file, 'open')} target="_blank" rel="noreferrer">Open</a>
                  <button
                    type="button"
                    className="mini-action-btn"
                    onClick={() => forceDownload(file, file?.originalName || file?.filename || `attachment-${idx + 1}`)}
                  >
                    Download
                  </button>
                </span>
              </div>
            ))}
          </div>
          {(task.forwardHistory || []).length > 0 && (
            <div className="forward-history">
              <strong>Forward History:</strong>
              {(task.forwardHistory || []).map((f) => (
                <div key={f.id} className="forward-item">
                  {f.fromUser} ({f.fromDepartment || '-'}) → {f.toUser || f.toDepartment || '-'} {f.createdAt ? `| ${formatDateTimeIndia(f.createdAt)}` : ''}
                </div>
              ))}
            </div>
          )}
          {(task.resultText || (task.resultLinks || []).length > 0 || (task.resultAttachments || []).length > 0) && (
            <div className="forward-history">
              <div className="detail-head">
                <strong>Submitted Result:</strong>
                <button
                  type="button"
                  className="mini-action-btn"
                  onClick={() => copyToClipboard(task.resultText, 'result-text')}
                  disabled={!task.resultText}
                >
                  {copiedKey === 'result-text' ? 'Copied' : 'Copy'}
                </button>
              </div>
              {task.resultText && <div className="forward-item">{task.resultText}</div>}
              {(task.resultLinks || []).map((link, idx) => (
                <div key={`${link}-${idx}`} className="forward-item">
                  <span>{link}</span>
                  <span className="attachment-actions">
                    <a href={link} target="_blank" rel="noreferrer">Open</a>
                    <button
                      type="button"
                      className="mini-action-btn"
                      onClick={() => copyToClipboard(link, `result-link-${idx}`)}
                    >
                      {copiedKey === `result-link-${idx}` ? 'Copied' : 'Copy Link'}
                    </button>
                  </span>
                </div>
              ))}
              {(task.resultAttachments || []).map((file, idx) => (
                <div key={`${file?.url || file?.filename || idx}-${idx}`} className="forward-item">
                  <span>{file?.originalName || file?.filename || `Attachment ${idx + 1}`}</span>
                  <span className="attachment-actions">
                    <a href={buildFileActionUrl(file, 'open')} target="_blank" rel="noreferrer">Open</a>
                    <button
                      type="button"
                      className="mini-action-btn"
                      onClick={() => forceDownload(file, file?.originalName || file?.filename || `result-attachment-${idx + 1}`)}
                    >
                      Download
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card-footer">
        <span className="seenby">Seen by: {(task.seenBy || []).map((s) => s.name).join(', ') || 'None'}</span>
        <div className="card-footer-actions">
          <button className="track-btn" onClick={() => setExpanded((s) => !s)}>
            {expanded ? 'Hide Details' : 'Show Details'}
          </button>
          <button className="track-btn" onClick={() => onTrackClick(task)}>Track</button>
        </div>
      </div>
      {toastMessage && <div className="copy-toast">{toastMessage}</div>}
    </div>
  );
};

export default InboxCard;
