import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { creditReportAPI } from '../../../services/reports';
import ToolLogo, { toolColor } from '../../common/ToolLogo';
import MarkdownRenderer from '../../leftsidebar/compofleftsidebar/workspace/tabs/claude-capture/MarkdownRenderer';
import { Avatar, Icon, ICONS, Skel } from './shared';

const timeLabel = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

/**
 * Reads a Claude / ChatGPT conversation inside the dashboard, scrolled to the
 * prompt that was clicked. The chat page itself sits behind the shared
 * company account's login, so it is offered as a secondary link.
 */
export default function ChatTranscriptModal({ row, onClose, notify }) {
  const [state, setState] = useState({ status: 'loading' });
  const [q, setQ] = useState('');
  const targetRef = useRef(null);

  useEffect(() => {
    if (!row) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    setQ('');
    const [toolName, recId] = row.outputRef.split(':');
    creditReportAPI
      .chatTranscript(toolName, recId)
      .then((data) => !cancelled && setState({ status: 'ready', data }))
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [row]);

  useEffect(() => {
    if (state.status === 'ready') {
      setTimeout(() => targetRef.current?.scrollIntoView({ block: 'center' }), 30);
    }
  }, [state.status]);

  useEffect(() => {
    if (!row) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = before;
    };
  }, [row, onClose]);

  const data = state.data;
  const messages = useMemo(() => {
    const all = data?.messages || [];
    const needle = q.trim().toLowerCase();
    return needle ? all.filter((m) => m.text.toLowerCase().includes(needle)) : all;
  }, [data, q]);

  if (!row) return null;

  const copyTranscript = async () => {
    const text = (data?.messages || [])
      .map((m) => `${m.role === 'user' ? row.userName || 'User' : row.tool}:\n${m.text || '(response not captured)'}`)
      .join('\n\n');
    try {
      await navigator.clipboard.writeText(`${data?.title || 'Chat'}\n\n${text}`);
      notify?.('Chat copied.');
    } catch {
      notify?.('Could not copy the chat.');
    }
  };

  const userCount = (data?.messages || []).filter((m) => m.role === 'user').length;

  return createPortal(
    <div className="zpm-overlay zop-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="zcv" role="dialog" aria-modal="true" aria-label={`${row.tool} conversation`}>
        <header className="zop-head">
          <span className="zop-tool" style={{ '--tool': toolColor(row.tool) }}>
            <ToolLogo name={row.tool} size={20} />
          </span>
          <div className="zop-title">
            <b>{state.status === 'ready' ? data.title : `${row.tool} chat`}</b>
            <span className="zop-meta">
              <Avatar name={data?.owner || row.userName} size={18} />
              {data?.owner || row.userName}
              {data?.model && (
                <>
                  <i>•</i>
                  {data.model}
                </>
              )}
              {state.status === 'ready' && (
                <>
                  <i>•</i>
                  {userCount} prompt{userCount === 1 ? '' : 's'}
                </>
              )}
            </span>
          </div>
          <label className="zcv-search">
            <Icon d={ICONS.search} size={14} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search this chat…" />
          </label>
          <button type="button" className="zrs-icon-btn" onClick={onClose} aria-label="Close">
            <Icon d={ICONS.close} />
          </button>
        </header>

        <div className="zcv-body">
          {state.status === 'loading' &&
            [70, 45, 80, 55, 65].map((w, i) => (
              <div key={i} className={`zcv-msg ${i % 2 ? 'assistant' : 'user'}`}>
                <div className="zcv-bubble skel">
                  <Skel w={`${w}%`} h={10} />
                  <Skel w={`${w - 20}%`} h={10} />
                </div>
              </div>
            ))}
          {state.status === 'error' && (
            <div className="zrs-empty">This conversation could not be loaded.</div>
          )}
          {state.status === 'ready' && data.truncated && (
            <div className="zcv-note">Long chat: showing the part around this prompt.</div>
          )}
          {state.status === 'ready' && messages.length === 0 && (
            <div className="zrs-empty">{q ? 'No messages match.' : 'No messages were captured for this chat.'}</div>
          )}
          {state.status === 'ready' &&
            messages.map((m) => (
              <div
                key={m.id}
                ref={m.target ? targetRef : null}
                className={`zcv-msg ${m.role}${m.target ? ' target' : ''}`}
              >
                <div className="zcv-who">
                  {m.role === 'user' ? (
                    <Avatar name={data.owner || row.userName} size={22} />
                  ) : (
                    <ToolLogo name={row.tool} size={20} />
                  )}
                  <span>{m.role === 'user' ? data.owner || row.userName : row.tool}</span>
                  <time>{timeLabel(m.at)}</time>
                  {m.target && <em>This prompt</em>}
                </div>
                <div className="zcv-bubble">
                  {!m.text ? (
                    <span className="zrs-muted">
                      {m.role === 'assistant' ? 'Response not captured.' : '(empty prompt)'}
                    </span>
                  ) : m.role === 'assistant' ? (
                    <MarkdownRenderer>{m.text}</MarkdownRenderer>
                  ) : (
                    <p>{m.text}</p>
                  )}
                  {m.files > 0 && (
                    <span className="zcv-files">
                      📎 {m.files} attachment{m.files === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
            ))}
        </div>

        <footer className="zop-foot">
          <button type="button" className="zrs-btn" onClick={copyTranscript} disabled={state.status !== 'ready'}>
            <Icon d={ICONS.doc} size={14} />
            Copy chat
          </button>
          {data?.webUrl && (
            <a className="zrs-btn" href={data.webUrl} target="_blank" rel="noopener noreferrer">
              <Icon d={ICONS.external} size={14} />
              Open in {row.tool}
            </a>
          )}
          <span className="zop-hint">Opening in {row.tool} needs the account’s login</span>
        </footer>
      </div>
    </div>,
    document.body
  );
}
