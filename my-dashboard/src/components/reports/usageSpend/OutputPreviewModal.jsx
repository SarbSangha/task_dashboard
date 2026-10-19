import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { creditReportAPI, downloadBlobResponse } from '../../../services/reports';
import ToolLogo, { toolColor } from '../../common/ToolLogo';
import { Avatar, Icon, ICONS, Skel, fmtINR, fmtNum, rowKind } from './shared';

// If the first guess can't play (e.g. a Higgsfield image saved without an
// extension), try the next player before giving up.
const FALLBACK = { video: 'image', image: 'video', audio: null, pdf: null, page: null };

/**
 * Plays / shows a generation's output inside the dashboard, with download,
 * open-in-new-tab and ←/→ to step through the other outputs in the list.
 */
export default function OutputPreviewModal({ row, rows, onNavigate, onClose, notify }) {
  const [state, setState] = useState({ status: 'loading' });
  const [kind, setKind] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [copied, setCopied] = useState(false);

  const idx = rows.findIndex((r) => r.outputRef === row?.outputRef);
  const prev = idx > 0 ? rows[idx - 1] : null;
  const next = idx >= 0 && idx < rows.length - 1 ? rows[idx + 1] : null;

  useEffect(() => {
    if (!row) return undefined;
    let cancelled = false;
    setState({ status: 'loading' });
    setKind(null);
    const [toolName, recId] = row.outputRef.split(':');
    creditReportAPI
      .outputUrl(toolName, recId)
      .then((res) => {
        if (cancelled) return;
        if (!res?.url) throw new Error('no url');
        const k = res.kind && res.kind !== 'page' ? res.kind : rowKind(row) || res.kind || 'page';
        setKind(k);
        // e.g. a Suno song captured before it finished: only its cover art was saved.
        const partial = res.expected && res.expected !== k && (res.expected === 'audio' || res.expected === 'video');
        setState({ status: 'ready', url: res.url, filename: res.filename, partial: partial ? res.expected : null });
      })
      .catch(() => !cancelled && setState({ status: 'error' }));
    return () => {
      cancelled = true;
    };
  }, [row]);

  // Captured on window so Escape closes only the player, not a People report
  // modal open underneath it.
  const onKey = useCallback(
    (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        // Arrows inside a focused player seek it instead of changing output.
      } else if (['INPUT', 'TEXTAREA', 'VIDEO', 'AUDIO'].includes(e.target.tagName)) return;
      else if (e.key === 'ArrowLeft' && prev) onNavigate(prev);
      else if (e.key === 'ArrowRight' && next) onNavigate(next);
    },
    [onClose, onNavigate, prev, next]
  );

  useEffect(() => {
    if (!row) return undefined;
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [row, onKey]);

  useEffect(() => {
    if (!row) return undefined;
    const before = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = before;
    };
  }, [row]);

  if (!row) return null;

  const download = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const [toolName, recId] = row.outputRef.split(':');
      const res = await creditReportAPI.downloadOutput(toolName, recId);
      downloadBlobResponse(res, state.filename || `${toolName}-${recId}`);
      notify?.('Download started.');
    } catch {
      notify?.('Could not download this output. Try “Open in new tab”.');
    } finally {
      setDownloading(false);
    }
  };

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(state.url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      notify?.('Could not copy the link.');
    }
  };

  const failPlayer = () => {
    const alt = FALLBACK[kind];
    if (alt) setKind(alt);
    else setState((s) => ({ ...s, status: 'unplayable' }));
  };

  let player;
  if (state.status === 'loading') {
    player = (
      <div className="zop-loading">
        <Skel w="100%" h="100%" r={12} />
        <span className="zrs-spinner" />
      </div>
    );
  } else if (state.status === 'error') {
    player = (
      <div className="zop-empty">
        <b>Output link unavailable</b>
        <span>The file may have expired at the provider or was never stored.</span>
      </div>
    );
  } else if (state.status === 'unplayable' || kind === 'page' || kind === 'chat') {
    player = (
      <div className="zop-empty">
        <ToolLogo name={row.tool} size={36} />
        <b>Can’t play this here</b>
        <span>Open it in a new tab or download it instead.</span>
      </div>
    );
  } else if (kind === 'video') {
    player = (
      <video key={state.url} src={state.url} controls autoPlay playsInline className="zop-video" onError={failPlayer} />
    );
  } else if (kind === 'audio') {
    player = (
      <div className="zop-audio" style={{ '--tool': toolColor(row.tool) }}>
        <div className="zop-audio-art">
          <ToolLogo name={row.tool} size={44} />
          <span className="zop-eq" aria-hidden="true">
            {Array.from({ length: 24 }).map((_, i) => (
              <i key={i} style={{ animationDelay: `${(i * 97) % 900}ms` }} />
            ))}
          </span>
        </div>
        <b className="zop-audio-title">{row.whatGenerated || row.outputType}</b>
        <audio key={state.url} src={state.url} controls autoPlay onError={failPlayer} />
      </div>
    );
  } else if (kind === 'image') {
    player = (
      <>
        <img key={state.url} src={state.url} alt={row.prompt} className="zop-image" onError={failPlayer} />
        {state.partial && (
          <span className="zop-note">
            Only the cover art was saved - the {state.partial === 'audio' ? 'song' : 'video'} itself wasn’t captured.
          </span>
        )}
      </>
    );
  } else {
    player = <iframe key={state.url} src={state.url} title="Output preview" className="zop-frame" />;
  }

  const canDownload = state.status !== 'error' && state.status !== 'loading' && kind !== 'chat';

  return createPortal(
    <div className="zpm-overlay zop-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="zop" role="dialog" aria-modal="true" aria-label={`${row.tool} output`}>
        <header className="zop-head">
          <span className="zop-tool" style={{ '--tool': toolColor(row.tool) }}>
            <ToolLogo name={row.tool} size={20} />
          </span>
          <div className="zop-title">
            <b>
              {row.outputType}
              <span> · {row.tool}</span>
            </b>
            <span className="zop-meta">
              <Avatar name={row.userName} size={18} />
              {row.userName}
              <i>•</i>
              {row.date} {row.time}
              {row.client && row.client !== 'No client' && (
                <>
                  <i>•</i>
                  {row.client}
                </>
              )}
            </span>
          </div>
          {rows.length > 1 && idx >= 0 && (
            <span className="zop-count">
              {idx + 1} / {rows.length}
            </span>
          )}
          <button type="button" className="zrs-icon-btn" onClick={onClose} aria-label="Close">
            <Icon d={ICONS.close} />
          </button>
        </header>

        <div className="zop-stage">
          {prev && (
            <button type="button" className="zop-nav left" onClick={() => onNavigate(prev)} aria-label="Previous output">
              ‹
            </button>
          )}
          {player}
          {next && (
            <button type="button" className="zop-nav right" onClick={() => onNavigate(next)} aria-label="Next output">
              ›
            </button>
          )}
        </div>

        <div className="zop-info">
          <div className="zop-prompt">
            <span>Prompt</span>
            <p>{row.prompt}</p>
          </div>
          <dl className="zop-facts">
            <div>
              <dt>Model</dt>
              <dd>{row.model || '—'}</dd>
            </div>
            <div>
              <dt>Credits</dt>
              <dd>{fmtNum(row.credits)}</dd>
            </div>
            <div>
              <dt>Cost</dt>
              <dd>{fmtINR(row.spendRupees)}</dd>
            </div>
            <div>
              <dt>Department</dt>
              <dd>{row.department}</dd>
            </div>
          </dl>
        </div>

        <footer className="zop-foot">
          <button type="button" className="zrs-btn primary" onClick={download} disabled={!canDownload || downloading}>
            {downloading ? <span className="zrs-spinner" /> : <Icon d={ICONS.download} size={15} />}
            {downloading ? 'Downloading…' : state.partial ? 'Download cover' : 'Download'}
          </button>
          <a
            className={`zrs-btn${state.url ? '' : ' disabled'}`}
            href={state.url || undefined}
            target="_blank"
            rel="noopener noreferrer"
            aria-disabled={!state.url}
          >
            <Icon d={ICONS.external} size={14} />
            Open in new tab
          </a>
          <button type="button" className="zrs-btn" onClick={copyLink} disabled={!state.url}>
            <Icon d={copied ? ICONS.check : ICONS.doc} size={14} />
            {copied ? 'Copied' : 'Copy link'}
          </button>
          {rows.length > 1 && <span className="zop-hint">← → to browse outputs</span>}
        </footer>
      </div>
    </div>,
    document.body
  );
}
