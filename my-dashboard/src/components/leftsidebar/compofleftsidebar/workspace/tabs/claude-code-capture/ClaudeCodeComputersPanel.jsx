import { useCallback, useEffect, useState } from 'react';
import { claudeCodeCaptureAPI } from '../../../../../../services/api';
import CursorDevicesPanel from '../cursor-capture/CursorDevicesPanel';
import { fmtTime, normalizeApiError } from './claudeCodeCaptureUtils';

/**
 * Computers: which computers report Claude Code, and how to connect one.
 * There is no separate Claude Code setup code - the computer is connected for
 * a person the Cursor way (setup code -> Connect to dashboard), then the same
 * extension switches Claude Code on for that person. So Cursor's People &
 * devices panel is right here, and its Disconnect stops Claude Code too.
 */

const terminalLabel = (t) => {
  const v = (t || '').toLowerCase();
  if (!v) return '—';
  if (v === 'non-interactive') return 'Non-interactive (claude -p)';
  if (v === 'cli') return 'Terminal (CMD / PowerShell)';
  if (v === 'windows-terminal') return 'Terminal (Windows Terminal)';
  if (v.startsWith('sdk')) return 'SDK';
  if (v.includes('slack')) return 'Slack';
  if (v.includes('cursor')) return 'Cursor';
  if (v.includes('vscode') || v.includes('code')) return 'VS Code';
  return `Terminal (${t})`;
};

export default function ClaudeCodeComputersPanel() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showConnect, setShowConnect] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await claudeCodeCaptureAPI.listConnections();
      setRows(response.data || []);
      setError('');
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Unable to load Claude Code computers.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const active = rows.filter((r) => r.active);
  const old = rows.filter((r) => !r.active);
  const shown = showOld ? rows : active;

  return (
    <>
      <div className="cut-card spaced">
        <div className="cut-tablebar">
          <div>
            <h2>Track Claude Code on a computer</h2>
            <div className="cut-sub" style={{ margin: 0 }}>
              Claude Code reports by itself once it's switched on, in the terminal and in VS Code alike. Two steps on the person's computer:
            </div>
          </div>
          <button type="button" className={`cut-btn ${showConnect ? 'on' : ''}`} onClick={() => setShowConnect((v) => !v)}>
            {showConnect ? 'Hide setup codes' : 'Create a setup code'}
          </button>
        </div>
        <ol className="cut-sub" style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          <li>
            Install the Cursor Usage Tracker extension <b>1.5.0 or newer</b> in Cursor or VS Code (<b>Ctrl+Shift+P → Extensions: Install from VSIX…</b>),
            create a setup code for the person below, and enter it with <b>Cursor Tracker: Connect to dashboard</b>.
          </li>
          <li>
            Accept <b>Also track Claude Code?</b>, or later run <b>Cursor Tracker: Connect Claude Code on this computer</b>.
            Then restart open Claude Code sessions (terminal: exit and run <span className="mono">claude</span> again; VS Code: <b>Developer: Reload Window</b>).
          </li>
        </ol>
      </div>

      {showConnect && <CursorDevicesPanel />}

      <div className="cut-card spaced">
        <div className="cut-tablebar">
          <div>
            <h2>Computers reporting Claude Code</h2>
            <div className="cut-sub" style={{ margin: 0 }}>
              Each computer reports as the person it's connected for. Disconnecting it under People &amp; devices stops its Claude Code too.
            </div>
          </div>
          <div className="cut-controls">
            {old.length > 0 && (
              <button type="button" className="cut-btn" onClick={() => setShowOld((v) => !v)}>
                {showOld ? 'Hide stopped' : `Show stopped (${old.length})`}
              </button>
            )}
            <button type="button" className="cut-btn" onClick={load}>Refresh</button>
          </div>
        </div>
        {error && <div className="cut-note error">{error}</div>}
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr>
                <th>Person</th><th>Computer</th><th>Claude login</th><th>Used in</th><th>Last report</th>
                <th>Connected</th><th>Claude Code</th><th>Extension</th><th />
              </tr>
            </thead>
            <tbody>
              {shown.length ? shown.map((r) => (
                <tr key={r.id} className={r.active ? '' : 'dim'}>
                  <td><b>{r.userName}</b></td>
                  <td>{r.deviceName || '—'}<div className="cut-conv">{r.deviceOs || ''}</div></td>
                  <td>{r.claudeAccountEmail || '—'}</td>
                  <td>{terminalLabel(r.terminalType)}</td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                    {r.lastSeenAt ? fmtTime(r.lastSeenAt) : <span className="cut-est" title="Claude Code hasn't sent anything yet - restart its open sessions">waiting for first prompt</span>}
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.connectedAt)}</td>
                  <td className="mono">{r.claudeVersion || '—'}</td>
                  <td className="mono">{r.extensionVersion || '—'}</td>
                  <td className="num">{r.active ? <span className="cut-chip">Active</span> : <span className="cut-conv">Stopped {fmtTime(r.disconnectedAt)}</span>}</td>
                </tr>
              )) : <tr><td colSpan={9} className="cut-empty">No computer reports Claude Code yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
