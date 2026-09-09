import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import ConversationChatView from './ConversationChatView';
import GenerationWorkspace from './GenerationWorkspace';
import DeveloperConsole from './DeveloperConsole';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatRelativeTime,
  getConversationHealthMeta,
  normalizeApiError,
} from './chatgptCaptureUtils';

// Mirrors claude-capture/ClaudeConversationDetailDrawer.jsx's CopyableField
// (itself the EventDetailPanel.jsx pattern).
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

function CollapsibleSection({ title, count, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  // Only mount the (potentially heavy) body once it has been opened at least
  // once - keeps opening a conversation cheap when these stay collapsed.
  const [everOpened, setEverOpened] = useState(defaultOpen);
  const handleToggle = () => {
    setOpen((prev) => {
      if (!prev) setEverOpened(true);
      return !prev;
    });
  };
  return (
    <div>
      <button
        type="button"
        className="cgpt-person-section-toggle"
        onClick={handleToggle}
        aria-expanded={open}
      >
        <span>{title}{count != null ? ` (${count})` : ''}</span>
        <span aria-hidden="true">{open ? '▲' : '▼'}</span>
      </button>
      <div className="cgpt-person-section-body" hidden={!open}>{everOpened ? children : null}</div>
    </div>
  );
}

/**
 * One conversation's full transcript - opened by clicking a row in
 * ChatGptConversationsByPerson.jsx. Full-width slide-over with a two-column
 * body (transcript left, metadata + collapsible Generation Workspace /
 * Developer Console right), adopted from
 * claude-capture/ClaudeConversationDetailDrawer.jsx. Fetches its own detail,
 * messages, attachments, media and events on open - the same five reads
 * ConversationDetailPanel.jsx makes.
 */
export default function ChatGptConversationDetailDrawer({ conversationId, onClose }) {
  const [detail, setDetail] = useState(null);
  const [messages, setMessages] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [media, setMedia] = useState([]);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const open = Boolean(conversationId);

  useEffect(() => {
    if (!conversationId) {
      setDetail(null);
      setMessages(null);
      setAttachments([]);
      setMedia([]);
      setEvents([]);
      return undefined;
    }
    const token = ++requestTokenRef.current;
    setLoading(true);
    setError('');
    Promise.all([
      chatgptCaptureAPI.getConversation(conversationId),
      chatgptCaptureAPI.getConversationMessages(conversationId, { limit: 200 }),
      chatgptCaptureAPI.getConversationAttachments(conversationId).catch(() => ({ data: [] })),
      chatgptCaptureAPI.getConversationMedia(conversationId).catch(() => ({ data: [] })),
      chatgptCaptureAPI.listEvents({ conversation_id: conversationId, limit: 200 }).catch(() => ({ data: [] })),
    ])
      .then(([detailRes, messagesRes, attachmentsRes, mediaRes, eventsRes]) => {
        if (token !== requestTokenRef.current) return;
        setDetail(detailRes.data);
        setMessages(messagesRes.data);
        setAttachments(attachmentsRes.data || []);
        setMedia(mediaRes.data || []);
        // /events returns newest-first; the transcript / timeline read oldest-first.
        setEvents([...(eventsRes.data || [])].reverse());
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

  const eventsById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const galleryMedia = useMemo(() => (media || []).filter((item) => item.url), [media]);

  const handleExport = useCallback(() => {
    if (!conversationId) return;
    const payload = {
      exportedAt: new Date().toISOString(),
      conversation: detail,
      messages: messages?.messages || [],
      media,
    };
    try {
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `chatgpt-conversation-${conversationId}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch {
      // best-effort client-side export - nothing to surface if the browser blocks it
    }
  }, [conversationId, detail, messages, media]);

  const header = detail;
  const healthMeta = header ? getConversationHealthMeta(header.captureHealth) : null;
  const conversationUrl = conversationId ? `https://chatgpt.com/c/${conversationId}` : null;

  return (
    <>
      <div
        className={`chatgpt-capture-drawer-backdrop${open ? ' visible' : ''}`}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className={`chatgpt-capture-drawer chatgpt-capture-by-person-drawer${open ? ' open' : ''}`}
        aria-hidden={!open}
        aria-label="Conversation detail"
      >
        <div className="chatgpt-capture-drawer-head">
          <h3>{header?.title || 'Untitled conversation'}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {conversationId && (
              <button type="button" className="chatgpt-capture-secondary-btn" onClick={handleExport}>
                Export JSON
              </button>
            )}
            <button type="button" className="chatgpt-capture-drawer-close" onClick={onClose} aria-label="Close conversation detail">
              ✕
            </button>
          </div>
        </div>
        <div className="chatgpt-capture-drawer-body">
          {error && <div className="chatgpt-capture-alert">{error}</div>}

          {open && !error && (
            <div className="cgpt-person-detail-layout">
              <div className="cgpt-person-detail-content-col">
                {/* Generated images live in a separate capture path (media
                    assets) that the inline transcript bubble can't yet render -
                    it only shows "not yet uploaded". So the Generation
                    Workspace sits above the transcript whenever the
                    conversation produced media, exactly as the pre-redesign
                    ConversationDetailPanel did, so the real image is never
                    hidden behind a collapsed panel. */}
                {(loading || galleryMedia.length > 0) && (
                  <GenerationWorkspace
                    media={galleryMedia}
                    messages={messages?.messages || []}
                    loading={loading && !messages}
                  />
                )}
                {galleryMedia.length > 0 && (
                  <div className="cgpt-context-heading">💬 Full conversation</div>
                )}
                <ConversationChatView
                  messages={messages?.messages}
                  truncated={messages?.truncated}
                  totalEvents={messages?.totalEvents}
                  eventsById={eventsById}
                  storedAttachments={attachments}
                  media={galleryMedia}
                  ownerName={header?.ownerName}
                  conversationModel={header?.model}
                  loading={loading && !messages}
                  error=""
                />
              </div>

              <div className="chatgpt-capture-event-detail cgpt-person-detail-fields-col">
                <div className="chatgpt-capture-event-detail-fields">
                  <CopyableField
                    label="Status"
                    value={healthMeta ? `${healthMeta.icon} ${healthMeta.label}` : '—'}
                  />
                  <CopyableField label="Owner" value={header?.ownerName || 'Unattributed'} />
                  <CopyableField label="Model" value={header?.model || '—'} />
                  <CopyableField label="Prompts" value={header?.promptsCount ?? 0} />
                  <CopyableField label="Responses" value={header?.responsesCount ?? 0} />
                  <CopyableField label="Images" value={header?.imagesCount ?? 0} />
                  <CopyableField label="Files" value={header?.filesCount ?? 0} />
                  <CopyableField label="Events" value={header?.eventCount ?? 0} />
                  <CopyableField
                    label="First seen"
                    value={header?.createdAt ? `${formatAbsoluteTime(header.createdAt)} (${formatRelativeTime(header.createdAt)})` : '—'}
                  />
                  <CopyableField
                    label="Last activity"
                    value={header?.lastActivityAt ? `${formatAbsoluteTime(header.lastActivityAt)} (${formatRelativeTime(header.lastActivityAt)})` : '—'}
                  />
                  <CopyableField label="Conversation URL" value={conversationUrl || '—'} href={conversationUrl || undefined} copyable />
                  <CopyableField label="Conversation ID" value={conversationId || '—'} copyable />
                </div>

                <CollapsibleSection title="Developer Console">
                  <DeveloperConsole
                    events={events}
                    media={media}
                    detail={detail}
                    loading={loading && !events.length}
                    error=""
                  />
                </CollapsibleSection>

                {header && <JsonViewer data={header} label="Raw conversation record" collapsedByDefault />}
              </div>
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
