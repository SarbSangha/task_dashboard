import { useState } from 'react';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatDuration,
  formatRelativeTime,
  getSessionStatusMeta,
} from './grammarlyDocsCaptureUtils';

// Mirrors chatgpt-capture/EventDetailPanel.jsx's CopyableField pattern
// exactly - see that file's own comment for the shape.
function CopyableField({ label, value, copyable, href }) {
  const [copied, setCopied] = useState(false);
  const hasValue = value && value !== '—';

  const handleCopy = async () => {
    if (!hasValue) return;
    const ok = await copyTextToClipboard(String(value));
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className="chatgpt-capture-field">
      <span className="chatgpt-capture-field-label">{label}</span>
      <span className="chatgpt-capture-field-value-row">
        <span className="chatgpt-capture-field-value">
          {href && hasValue ? (
            <a href={href} target="_blank" rel="noreferrer noopener">{value}</a>
          ) : (
            value
          )}
        </span>
        {copyable && hasValue && (
          <button type="button" className="chatgpt-capture-copy-icon-btn" onClick={handleCopy} aria-label={`Copy ${label}`}>
            {copied ? '✓' : '⧉'}
          </button>
        )}
      </span>
    </div>
  );
}

// Plain doc text, not JSON - its own block rather than JsonViewer's
// JSON.stringify treatment. Best-effort DOM read (see backend
// providers/grammarly_docs/CAPTURE_CONTRACT.md's "Content capture" section
// for what this is and isn't - a flat text read of whatever was rendered at
// capture time, not Coda's own structured document model).
function DocContentSection({ session, loading }) {
  const [copied, setCopied] = useState(false);
  const hasContent = Boolean(session?.contentText);

  const handleCopy = async () => {
    if (!hasContent) return;
    const ok = await copyTextToClipboard(session.contentText);
    setCopied(ok);
    if (ok) window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="chatgpt-capture-json-viewer grammarly-docs-content-card">
      <div className="chatgpt-capture-json-viewer-head">
        <span className="chatgpt-capture-field-label">
          Document content
          {hasContent && ` (${(session.contentWordCount ?? session.contentText.split(/\s+/).filter(Boolean).length).toLocaleString()} words)`}
        </span>
        {hasContent && (
          <button type="button" className="chatgpt-capture-copy-btn" onClick={handleCopy}>
            {copied ? 'Copied ✓' : 'Copy text'}
          </button>
        )}
      </div>
      {loading && !hasContent && (
        <p className="chatgpt-capture-inline-note">Loading…</p>
      )}
      {!loading && !hasContent && (
        <p className="chatgpt-capture-inline-note">
          No content captured for this session yet - it captures a moment after the doc opens, so a very short visit may not have any.
        </p>
      )}
      {hasContent && (
        <pre className="chatgpt-capture-json-pre grammarly-docs-content-pre">
          <code>{session.contentText}</code>
        </pre>
      )}
      {hasContent && session.contentCapturedAt && (
        <p className="chatgpt-capture-inline-note">Captured {formatRelativeTime(session.contentCapturedAt)}</p>
      )}
    </div>
  );
}

/**
 * One session's full detail - opened by clicking a row in
 * GrammarlyDocsSessionsByPerson.jsx. The session object passed in is
 * already the complete GrammarlyDocSession.to_dict() shape (the list
 * endpoint returns full rows, not a trimmed summary - see backend
 * providers/grammarly_docs/queries.py's list_sessions), so this needs no
 * extra fetch of its own.
 */
export default function GrammarlyDocsSessionDetailDrawer({ session, loading, onClose }) {
  const open = Boolean(session);
  const statusMeta = session ? getSessionStatusMeta(session.status) : null;

  return (
    <>
      <div
        className={`chatgpt-capture-drawer-backdrop${open ? ' visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`chatgpt-capture-drawer grammarly-docs-drawer${open ? ' open' : ''}`}
        aria-hidden={!open}
        aria-label="Doc session detail"
      >
        <div className="chatgpt-capture-drawer-head">
          <h3>{session?.docTitle || 'Untitled doc'}</h3>
          <button type="button" className="chatgpt-capture-drawer-close" onClick={onClose} aria-label="Close session detail">
            ✕
          </button>
        </div>
        <div className="chatgpt-capture-drawer-body">
          {session && (
            <div className="grammarly-docs-detail-layout">
              <div className="grammarly-docs-detail-content-col">
                <DocContentSection session={session} loading={loading} />
              </div>

              <div className="chatgpt-capture-event-detail grammarly-docs-detail-fields-col">
                <div className="chatgpt-capture-event-detail-fields">
                  <CopyableField
                    label="Status"
                    value={statusMeta ? `${statusMeta.icon} ${statusMeta.label}` : '—'}
                  />
                  <CopyableField label="Doc title" value={session.docTitle || '—'} copyable />
                  <CopyableField label="Doc author" value={session.docAuthor || '—'} />
                  <CopyableField label="Owner" value={session.ownerName || '—'} />
                  <CopyableField
                    label="Employee / Department"
                    value={[session.ownerEmployeeId, session.ownerDepartment].filter(Boolean).join(' · ') || '—'}
                  />
                  <CopyableField label="Linked client" value={session.linkedClientName || 'Not linked'} />
                  <CopyableField label="Linked task" value={session.linkedTaskName || 'Not linked'} />
                  <CopyableField
                    label="Started"
                    value={session.startedAt ? `${formatAbsoluteTime(session.startedAt)} (${formatRelativeTime(session.startedAt)})` : '—'}
                  />
                  <CopyableField
                    label="Ended"
                    value={session.endedAt ? `${formatAbsoluteTime(session.endedAt)} (${formatRelativeTime(session.endedAt)})` : 'Still open'}
                  />
                  <CopyableField
                    label="Duration"
                    value={session.durationSeconds != null ? formatDuration(session.durationSeconds) : '—'}
                  />
                  <CopyableField
                    label="Last seen"
                    value={session.lastSeenAt ? formatRelativeTime(session.lastSeenAt) : '—'}
                  />
                  <CopyableField label="Doc URL" value={session.docUrl || '—'} href={session.docUrl || undefined} copyable />
                  <CopyableField label="Page URL" value={session.pageUrl || '—'} href={session.pageUrl || undefined} copyable />
                  <CopyableField label="Doc ID" value={session.docId || '—'} copyable />
                  <CopyableField label="Page" value={session.pageName || 'Main page'} />
                  <CopyableField label="Page ID" value={session.pageId || '—'} copyable />
                  <CopyableField label="Session key" value={session.sessionKey || '—'} copyable />
                </div>

                <JsonViewer data={session.metadata} label="Raw doc_open payload" />
                <JsonViewer
                  data={{
                    id: session.id,
                    provider: session.provider,
                    sourceCaptureEventId: session.sourceCaptureEventId,
                    closeCaptureEventId: session.closeCaptureEventId,
                    toolId: session.toolId,
                    credentialId: session.credentialId,
                    ownerUserId: session.ownerUserId,
                    ownershipStatus: session.ownershipStatus,
                    linkedClientId: session.linkedClientId,
                    linkedTaskId: session.linkedTaskId,
                    createdAt: session.createdAt,
                    updatedAt: session.updatedAt,
                  }}
                  label="Raw metadata"
                  collapsedByDefault
                />
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
