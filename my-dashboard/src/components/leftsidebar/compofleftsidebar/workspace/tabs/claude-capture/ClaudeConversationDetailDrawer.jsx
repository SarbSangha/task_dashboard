import { useEffect, useRef, useState } from 'react';
import { claudeCaptureAPI } from '../../../../../../services/api';
import ClaudeConversationChatView from './ClaudeConversationChatView';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatRelativeTime,
  getConversationHealthMeta,
  normalizeApiError,
} from './claudeCaptureUtils';

// Mirrors chatgpt-capture/EventDetailPanel.jsx's CopyableField pattern
// (also reused as-is by grammarly-docs-capture/GrammarlyDocsSessionDetailDrawer.jsx).
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

/**
 * One conversation's full message thread - opened by clicking a row in
 * ClaudeConversationsByPerson.jsx. The list endpoint returns summaries only
 * (no messages), so this fetches GET .../conversations/{id}/messages itself
 * on open, mirroring GrammarlyDocsSessionDetailDrawer.jsx's own
 * summary-first-then-detail-fetch shape.
 */
export default function ClaudeConversationDetailDrawer({ conversation, onClose }) {
  const [detail, setDetail] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const open = Boolean(conversation);
  const conversationId = conversation?.providerConversationId;

  useEffect(() => {
    if (!conversationId) {
      setDetail(null);
      setAttachments([]);
      return undefined;
    }
    const token = ++requestTokenRef.current;
    setLoading(true);
    setError('');
    Promise.all([
      claudeCaptureAPI.getConversationMessages(conversationId, { limit: 200 }),
      // Real stored file bytes (see backend providers/claude/attachments.py) -
      // fetched alongside messages, not blocking on it: a failure here still
      // leaves the text thread fully usable, just without inline previews.
      claudeCaptureAPI.getConversationAttachments(conversationId).catch(() => ({ data: [] })),
    ])
      .then(([messagesResponse, attachmentsResponse]) => {
        if (token !== requestTokenRef.current) return;
        setDetail(messagesResponse.data);
        setAttachments(attachmentsResponse.data || []);
      })
      .catch((fetchError) => {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load this conversation.'));
      })
      .finally(() => {
        if (token === requestTokenRef.current) setLoading(false);
      });
    return undefined;
  }, [conversationId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Header fields prefer the freshly-fetched detail (always current) but
  // fall back to the summary row that was clicked, so the drawer's title
  // bar isn't blank while the fetch is still in flight.
  const header = detail?.conversation || conversation;
  const healthMeta = header ? getConversationHealthMeta(header.captureHealth) : null;

  return (
    <>
      <div
        className={`chatgpt-capture-drawer-backdrop${open ? ' visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`chatgpt-capture-drawer claude-capture-drawer${open ? ' open' : ''}`}
        aria-hidden={!open}
        aria-label="Conversation detail"
      >
        <div className="chatgpt-capture-drawer-head">
          <h3>{header?.title || 'Untitled conversation'}</h3>
          <button type="button" className="chatgpt-capture-drawer-close" onClick={onClose} aria-label="Close conversation detail">
            ✕
          </button>
        </div>
        <div className="chatgpt-capture-drawer-body">
          {header && (
            <div className="claude-capture-detail-layout">
              <div className="claude-capture-detail-content-col">
                <ClaudeConversationChatView
                  messages={detail?.messages}
                  storedAttachments={attachments}
                  conversationModel={header.modelLabel}
                  loading={loading && !detail}
                  error={error}
                />
              </div>

              <div className="chatgpt-capture-event-detail claude-capture-detail-fields-col">
                <div className="chatgpt-capture-event-detail-fields">
                  <CopyableField
                    label="Status"
                    value={healthMeta ? `${healthMeta.icon} ${healthMeta.label}` : '—'}
                  />
                  <CopyableField label="Owner" value={header.ownerName || 'Unattributed'} />
                  <CopyableField label="Model" value={header.modelLabel || '—'} />
                  <CopyableField label="Prompts" value={header.promptCount ?? 0} />
                  <CopyableField label="Responses" value={header.responseCount ?? 0} />
                  <CopyableField
                    label="Created"
                    value={header.providerCreatedTime ? `${formatAbsoluteTime(header.providerCreatedTime)} (${formatRelativeTime(header.providerCreatedTime)})` : '—'}
                  />
                  <CopyableField
                    label="Last activity"
                    value={header.lastActivityAt ? `${formatAbsoluteTime(header.lastActivityAt)} (${formatRelativeTime(header.lastActivityAt)})` : '—'}
                  />
                  <CopyableField label="Conversation URL" value={header.conversationUrl || '—'} href={header.conversationUrl || undefined} copyable />
                  <CopyableField label="Conversation ID" value={header.providerConversationId || '—'} copyable />
                </div>

                <JsonViewer data={header} label="Raw conversation record" collapsedByDefault />
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
