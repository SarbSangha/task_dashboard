import { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL, cursorCaptureAPI } from '../../../../../../services/api';
import { copyTextToClipboard, normalizeApiError } from './cursorCaptureUtils';

/**
 * People & devices: only an admin connects a computer to the tracker. They
 * pick a person and create a one-time setup code (15 minutes, works once);
 * typed into Cursor Tracker: Connect to dashboard on that person's computer,
 * it becomes a tracker token that only works from that computer. Switching a
 * computer to someone else needs a new code, and Disconnect turns one off.
 */

// The address this dashboard's own API calls go to - not the backend's view of
// its own URL, which behind a TLS-terminating proxy can come back as http://
// (and a redirected POST from the extension would silently turn into a GET).
function dashboardApiAddress() {
  try {
    return new URL(API_URL, window.location.origin).toString().replace(/\/+$/, '');
  } catch {
    return API_URL;
  }
}

const STALE_MS = 24 * 60 * 60 * 1000;
const fmtTime = (value) => (value
  ? new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  : '—');
const fmtLeft = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;

export default function CursorDevicesPanel() {
  const [people, setPeople] = useState([]);
  const [personId, setPersonId] = useState('');
  const [devices, setDevices] = useState([]);
  const [code, setCode] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [showOld, setShowOld] = useState(false);
  const address = useMemo(dashboardApiAddress, []);

  const loadDevices = useCallback(async () => {
    try {
      const response = await cursorCaptureAPI.listDevices();
      setDevices(response.data || []);
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Unable to load connected computers.'));
    }
  }, []);

  useEffect(() => {
    cursorCaptureAPI.listPeople()
      .then((response) => setPeople(response.data || []))
      .catch((fetchError) => setError(normalizeApiError(fetchError, 'Unable to load people.')));
    loadDevices();
  }, [loadDevices]);

  const msLeft = code ? new Date(code.expiresAt).getTime() - now : 0;
  const codeLive = Boolean(code) && msLeft > 0;
  // A computer that connected with the current code: one for that person that
  // wasn't in the list when the code was made (comparing ids, not the
  // server's and this browser's clocks, which can disagree).
  const connectedWithCode = code && devices.find((d) => d.active && d.userId === code.user.id
    && !code.knownDeviceIds.includes(d.id));

  // While a code is waiting to be used: tick the countdown and watch for the
  // computer to show up.
  useEffect(() => {
    if (!codeLive || connectedWithCode) return undefined;
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    const poll = window.setInterval(loadDevices, 5000);
    return () => { window.clearInterval(tick); window.clearInterval(poll); };
  }, [codeLive, connectedWithCode, loadDevices]);

  const createCode = async () => {
    if (!personId) return;
    setBusy(true);
    setError('');
    try {
      const [created, current] = await Promise.all([
        cursorCaptureAPI.createSetupCode(Number(personId)),
        cursorCaptureAPI.listDevices(),
      ]);
      const currentDevices = current.data || [];
      setDevices(currentDevices);
      setCode({ ...created, knownDeviceIds: currentDevices.map((d) => d.id) });
      setNow(Date.now());
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Unable to create a setup code.'));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (device) => {
    if (!window.confirm(`Disconnect ${device.deviceName || 'this computer'} (${device.userName})? Its prompts stop arriving until an admin connects it again.`)) return;
    try {
      await cursorCaptureAPI.disconnectDevice(device.id);
      loadDevices();
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Unable to disconnect that computer.'));
    }
  };

  const copy = async (label, value) => {
    if (await copyTextToClipboard(value)) {
      setCopied(label);
      window.setTimeout(() => setCopied(''), 1800);
    }
  };

  const active = devices.filter((d) => d.active);
  const old = devices.filter((d) => !d.active);
  const rows = showOld ? [...active, ...old] : active;

  return (
    <>
      <div className="cut-card spaced">
        <h2>Connect a computer</h2>
        <div className="cut-sub">
          Only admins can connect Cursor. On the person's computer, install the Cursor Usage Tracker extension
          (Cursor: <b>Ctrl+Shift+P → Extensions: Install from VSIX…</b>), then create a code for them here and enter it
          with <b>Ctrl+Shift+P → Cursor Tracker: Connect to dashboard</b>.
        </div>
        <div className="cut-controls">
          <select className="cut-btn" value={personId} onChange={(e) => setPersonId(e.target.value)} aria-label="Person">
            <option value="">Choose a person…</option>
            {people.map((p) => <option key={p.id} value={p.id}>{p.name}{p.department ? ` · ${p.department}` : ''}</option>)}
          </select>
          <button type="button" className="cut-btn" onClick={createCode} disabled={!personId || busy}>
            {busy ? 'Creating…' : 'Create setup code'}
          </button>
        </div>
        {error && <div className="cut-note error" style={{ marginTop: 12 }}>{error}</div>}

        {code && (
          <div className="cut-kv" style={{ marginTop: 14, display: 'grid', gap: 10 }}>
            <div>
              Dashboard address{' '}
              <b className="mono">{address}</b>{' '}
              <button type="button" className="cut-btn" onClick={() => copy('address', address)}>{copied === 'address' ? 'Copied' : 'Copy'}</button>
            </div>
            <div>
              Setup code for <b>{code.user.name}</b>{' '}
              <b className="mono" style={{ fontSize: 18, letterSpacing: '0.06em' }}>{code.code}</b>{' '}
              <button type="button" className="cut-btn" onClick={() => copy('code', code.code)}>{copied === 'code' ? 'Copied' : 'Copy'}</button>
            </div>
            <div>
              {connectedWithCode
                ? <b>Connected: {connectedWithCode.deviceName || 'computer'} now reports as {code.user.name}.</b>
                : codeLive
                  ? `Waiting for the computer to connect… code expires in ${fmtLeft(msLeft)} and works once.`
                  : 'This code has expired. Create a new one.'}
            </div>
          </div>
        )}
      </div>

      <div className="cut-card spaced">
        <div className="cut-tablebar">
          <div>
            <h2>Connected computers</h2>
            <div className="cut-sub" style={{ margin: 0 }}>
              Each computer sends prompts as one person, and its token works only on that computer.
            </div>
          </div>
          <div className="cut-controls">
            {old.length > 0 && (
              <button type="button" className="cut-btn" onClick={() => setShowOld((v) => !v)}>
                {showOld ? 'Hide disconnected' : `Show disconnected (${old.length})`}
              </button>
            )}
            <button type="button" className="cut-btn" onClick={loadDevices}>Refresh</button>
          </div>
        </div>
        <div className="cut-tscroll">
          <table>
            <thead>
              <tr><th>Person</th><th>Computer</th><th>Cursor login</th><th>Last sync</th><th>Connected</th><th>Extension</th><th /></tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((d) => {
                const stale = d.active && (!d.lastSeenAt || Date.now() - new Date(d.lastSeenAt).getTime() > STALE_MS);
                return (
                  <tr key={d.id} className={d.active ? '' : 'dim'}>
                    <td><b>{d.userName}</b></td>
                    <td>{d.deviceName || '—'}<div className="cut-conv">{d.deviceOs || ''}</div></td>
                    <td>{d.cursorAccountEmail || '—'}</td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>
                      {fmtTime(d.lastSeenAt)}
                      {stale && <span className="cut-est" title="No sync in the last day: Cursor may be closed, or the extension removed">no recent sync</span>}
                    </td>
                    <td className="mono" style={{ whiteSpace: 'nowrap' }}>{fmtTime(d.connectedAt)}</td>
                    <td className="mono">{d.extensionVersion || '—'}</td>
                    <td className="num">
                      {d.active
                        ? <button type="button" className="cut-btn" onClick={() => disconnect(d)}>Disconnect</button>
                        : <span className="cut-conv">Disconnected {fmtTime(d.disconnectedAt)}</span>}
                    </td>
                  </tr>
                );
              }) : <tr><td colSpan={7} className="cut-empty">No computers connected yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
