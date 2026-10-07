import { useCallback, useEffect, useState } from 'react';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { sheetsAPI } from '../../services/sheets';
import SheetSetup from './SheetSetup';
import SheetDashboard from './SheetDashboard';
import RankingDashboard from './RankingDashboard';
import KeywordDetail from './KeywordDetail';
import RequestDetail from './RequestDetail';
import { formatWhen } from '../../utils/sheetFormat';
import '../reports/TaskReportPanel.css';
import '../reports/SheetActivityPanel.css';
import './SheetsPanel.css';

/**
 * Sheets -> Sheets: registered Google Sheets and the content requests in
 * them (user input vs Claude's response). Backend: routers/sheets_router.py.
 * The section needs the "Sheets" Section Access grant; which sheets show is
 * the per-sheet assignment an admin sets in each sheet's settings.
 */
export default function SheetsPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('sheets-panel', isOpen && isMinimized);

  const [sheets, setSheets] = useState([]);
  const [isAdmin, setIsAdmin] = useState(false);
  const [view, setView] = useState({ mode: 'list' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const loadSheets = useCallback(async () => {
    setLoading(true);
    try {
      const d = await sheetsAPI.list();
      setSheets(d.sheets || []);
      setIsAdmin(Boolean(d.isAdmin));
      setError('');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Could not load sheets.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isOpen) loadSheets(); }, [isOpen, loadSheets]);

  useEffect(() => { onMinimizedChange?.(isOpen && isMinimized); }, [isMinimized, isOpen, onMinimizedChange]);
  useEffect(() => {
    if (!isOpen) { setIsMinimized(false); setIsMaximized(false); setView({ mode: 'list' }); }
    else setIsMaximized(isMobileViewport());
  }, [isOpen]);

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((p) => !p);
  };

  if (!isOpen) return null;

  const current = sheets.find((s) => s.id === view.sheetId);

  let body;
  if (view.mode === 'add') {
    body = <SheetSetup onCancel={() => setView({ mode: 'list' })}
      onSaved={async (s) => { await loadSheets(); setView({ mode: 'sheet', sheetId: s.id }); }} />;
  } else if (view.mode === 'settings' && current) {
    body = <SheetSetup sheet={current} onCancel={() => setView({ mode: 'sheet', sheetId: current.id })}
      onSaved={async () => { await loadSheets(); setView({ mode: 'sheet', sheetId: current.id }); }}
      onDeleted={async () => { await loadSheets(); setView({ mode: 'list' }); }} />;
  } else if (view.mode === 'keyword' && current) {
    body = <KeywordDetail sheetId={current.id} keywordId={view.keywordId} onBack={() => setView({ mode: 'sheet', sheetId: current.id })} />;
  } else if (view.mode === 'sheet' && current && current.sheetType === 'keyword_ranking') {
    body = <RankingDashboard sheet={current} isAdmin={isAdmin} active={!isMinimized}
      onSettings={() => setView({ mode: 'settings', sheetId: current.id })}
      onOpenKeyword={(keywordId) => setView({ mode: 'keyword', sheetId: current.id, keywordId })} />;
  } else if (view.mode === 'request' && current) {
    body = <RequestDetail sheetId={current.id} requestId={view.requestId} onBack={() => setView({ mode: 'sheet', sheetId: current.id })} />;
  } else if (view.mode === 'sheet' && current) {
    body = <SheetDashboard sheet={current} isAdmin={isAdmin} active={!isMinimized}
      onSettings={() => setView({ mode: 'settings', sheetId: current.id })}
      onOpenRequest={(requestId) => setView({ mode: 'request', sheetId: current.id, requestId })} />;
  } else {
    body = (
      <>
        <div className="shs-list-head">
          <p className="trp-hint">
            Registered Google Sheets. Content sheets show each request: what a person entered and what Claude sent
            back. Keyword ranking sheets show each keyword's position and AI Overview history, and who added it.
          </p>
          {isAdmin && <button type="button" className="trp-generate-btn" onClick={() => setView({ mode: 'add' })}>Add a sheet</button>}
        </div>
        {error && <div className="trp-error" role="alert">{error}</div>}
        {!loading && sheets.length === 0 && (
          <div className="trp-empty">{isAdmin ? 'No sheets yet. Add one with its Google Sheets link.' : 'No sheets have been shared with you yet. Ask an admin.'}</div>
        )}
        <div className="shs-cards">
          {sheets.map((s) => (
            <article key={s.id} className="shs-card">
              <header>
                <h3>{s.name}</h3>
                <span className="shs-badge">{s.sheetType === 'keyword_ranking' ? 'Keyword ranking' : 'Content workflow'}</span>
                {!s.isActive && <span className="shs-badge">Paused</span>}
              </header>
              <p className="shs-muted">
                {s.tabs.filter((t) => t.tracked).map((t) => t.name).join(' · ') || 'No tabs tracked'}
              </p>
              <p className="shs-muted">
                {s.sheetType === 'keyword_ranking' ? 'Rankings' : `${s.requestCount ?? 0} request(s)`} · last read {s.lastPolledAt ? formatWhen(s.lastPolledAt) : 'never'}
              </p>
              {s.lastPollError && <p className="shs-warn">{s.lastPollError}</p>}
              <div className="shs-actions">
                <button type="button" className="trp-generate-btn" onClick={() => setView({ mode: 'sheet', sheetId: s.id })}>Open</button>
                <a className="shs-secondary-btn" href={s.openUrl} target="_blank" rel="noopener noreferrer">Open in Google Sheets</a>
                {isAdmin && <button type="button" className="shs-secondary-btn" onClick={() => setView({ mode: 'settings', sheetId: s.id })}>Settings</button>}
              </div>
            </article>
          ))}
        </div>
      </>
    );
  }

  return (
    <>
      <div className={`trp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`trp-panel shs-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Sheets"
      >
        <div className="trp-header">
          <div className="trp-brand">
            <span className="trp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="4" y="2" width="16" height="20" rx="2" /><line x1="8" y1="7" x2="16" y2="7" /><line x1="8" y1="12" x2="16" y2="12" /><line x1="8" y1="17" x2="12" y2="17" />
              </svg>
            </span>
            <h2 className="trp-title">
              {view.mode !== 'list'
                ? <button type="button" className="shs-crumb" onClick={() => setView({ mode: 'list' })}>Sheets</button>
                : 'Sheets'}
              {current && view.mode !== 'list' && <span className="shs-muted"> / {current.name}</span>}
            </h2>
          </div>
          <div className="trp-header-spacer" />
          <WindowControls isMinimized={isMinimized} isMaximized={isMaximized}
            onMinimize={handleToggleMinimize} onMaximize={handleToggleMaximize} onClose={onClose} />
        </div>
        {!isMinimized && <div className="trp-body">{body}</div>}
      </div>
    </>
  );
}
