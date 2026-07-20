import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';

const CADENCES = ['daily', 'weekly', 'monthly'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_FORMATS = ['pdf', 'xlsx', 'pptx', 'csv'];

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

// Sender configuration. The password is write-only: the API never returns it,
// so a blank field means "keep the stored one" rather than "clear it".
const EmailSettings = ({ email, onSaved, flash }) => {
  const [open, setOpen] = useState(!email.configured);
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [cfg, setCfg] = useState({
    host: '', port: 587, username: '', password: '', fromAddress: '', fromName: '', useTls: true,
  });
  const [loaded, setLoaded] = useState(false);

  // Seed from the server's current status once it arrives.
  if (!loaded && email.host !== undefined) {
    setCfg((c) => ({
      ...c,
      host: email.host || '',
      port: email.port || 587,
      username: email.username || '',
      fromAddress: email.from || '',
      fromName: email.fromName || '',
      useTls: email.useTls !== false,
    }));
    setLoaded(true);
  }

  const set = (k, v) => setCfg((c) => ({ ...c, [k]: v }));

  const save = async () => {
    if (!cfg.host.trim() || !cfg.fromAddress.trim()) { flash('SMTP host and sender address are required.'); return; }
    setBusy(true);
    try {
      await reportsAPI.emailSettingsSave(cfg);
      setCfg((c) => ({ ...c, password: '' }));
      flash('Email settings saved.');
      onSaved?.();
    } catch (e) {
      flash(`Save failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  const test = async () => {
    if (!testTo.trim()) { flash('Enter an address to send the test to.'); return; }
    setBusy(true);
    try {
      const r = await reportsAPI.emailSettingsTest(testTo.trim());
      flash(r.success ? `Test email sent to ${testTo}.` : `Test failed: ${r.detail}`);
      onSaved?.();
    } catch (e) {
      flash(`Test failed: ${e?.response?.data?.detail || e.message}`);
    } finally { setBusy(false); }
  };

  return (
    <div className="rpt-form" style={{ marginBottom: 14 }}>
      <div className="rpt-card-head" style={{ marginBottom: open ? 12 : 0 }}>
        <h3 className="rpt-card-title">Sender email (SMTP)</h3>
        <span className="rpt-card-hint">
          {email.configured
            ? `Sending as ${email.fromName ? `${email.fromName} <${email.from}>` : email.from} via ${email.host}`
            : 'Not configured — schedules will not send'}
        </span>
        <button className="rpt-mini-btn" onClick={() => setOpen((v) => !v)}>{open ? 'Hide' : 'Configure'}</button>
      </div>

      {open && (
        <>
          <div className="rpt-form-row">
            <label>SMTP host
              <input value={cfg.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.gmail.com" />
            </label>
            <label>Port
              <input type="number" value={cfg.port} onChange={(e) => set('port', Number(e.target.value))} placeholder="587" />
            </label>
            <label>Our email (sender)
              <input value={cfg.fromAddress} onChange={(e) => set('fromAddress', e.target.value)} placeholder="reports@rmwcreative.in" />
            </label>
            <label>Sender name
              <input value={cfg.fromName} onChange={(e) => set('fromName', e.target.value)} placeholder="RMWeye Reports" />
            </label>
            <label>SMTP username
              <input value={cfg.username} onChange={(e) => set('username', e.target.value)} placeholder="reports@rmwcreative.in" />
            </label>
            <label>{email.hasPassword ? 'SMTP password (saved — blank keeps it)' : 'SMTP password'}
              <input
                type="password"
                autoComplete="new-password"
                value={cfg.password}
                onChange={(e) => set('password', e.target.value)}
                placeholder={email.hasPassword ? '••••••••' : 'app password'}
              />
            </label>
          </div>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, margin: '8px 0' }}>
            <input type="checkbox" checked={cfg.useTls} onChange={(e) => set('useTls', e.target.checked)} />
            Use STARTTLS (leave on for port 587; port 465 uses implicit TLS automatically)
          </label>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="rb-generate" style={{ width: 'auto', padding: '10px 18px' }} disabled={busy} onClick={save}>
              {busy ? 'Working…' : 'Save settings'}
            </button>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                style={{ minWidth: 220 }}
                value={testTo}
                onChange={(e) => setTestTo(e.target.value)}
                placeholder="you@company.com"
              />
            </label>
            <button className="rpt-mini-btn" disabled={busy || !email.configured} onClick={test}>Send test email</button>
          </div>
        </>
      )}
    </div>
  );
};

const ScheduledReports = () => {
  const queryClient = useQueryClient();
  const [toast, setToast] = useState(null);
  const [form, setForm] = useState({ name: '', sourceId: '', cadence: 'weekly', hourUtc: 8, weekday: 0, dayOfMonth: 1, recipients: '', formats: ['pdf'] });
  const [creating, setCreating] = useState(false);
  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 3600); };

  const schedulesQ = useQuery({ queryKey: ['reports', 'schedules'], queryFn: () => reportsAPI.listSchedules(), staleTime: 30_000 });
  const libraryQ = useQuery({ queryKey: ['reports', 'library'], queryFn: () => reportsAPI.listReports(), staleTime: 30_000 });
  const capsQ = useQuery({ queryKey: ['reports', 'caps'], queryFn: () => reportsAPI.distributionCapabilities(), staleTime: 300_000 });

  const schedules = schedulesQ.data?.data || [];
  const library = libraryQ.data?.data || [];
  const email = schedulesQ.data?.email || capsQ.data?.email || {};
  const caps = capsQ.data?.formats || {};

  const setF = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const toggleFmt = (f) => setForm((s) => ({ ...s, formats: s.formats.includes(f) ? s.formats.filter((x) => x !== f) : [...s.formats, f] }));

  const create = async () => {
    if (!form.sourceId) { flash('Choose a saved report to schedule.'); return; }
    setCreating(true);
    try {
      const src = await reportsAPI.getReport(form.sourceId);
      const definition = src?.data?.definition || {};
      const recipients = form.recipients.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
      await reportsAPI.createSchedule({
        name: form.name || src?.data?.name || 'Scheduled report',
        definition,
        cadence: form.cadence,
        hourUtc: Number(form.hourUtc),
        weekday: form.cadence === 'weekly' ? Number(form.weekday) : null,
        dayOfMonth: form.cadence === 'monthly' ? Number(form.dayOfMonth) : null,
        recipients,
        formats: form.formats.length ? form.formats : ['pdf'],
        active: true,
      });
      flash('Schedule created');
      setForm((f) => ({ ...f, name: '', recipients: '' }));
      schedulesQ.refetch();
    } catch (e) {
      flash(e?.response?.data?.detail || 'Could not create schedule');
    } finally { setCreating(false); }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this schedule?')) return;
    try { await reportsAPI.deleteSchedule(id); schedulesQ.refetch(); } catch { flash('Delete failed'); }
  };

  const runNow = async () => {
    try {
      const res = await reportsAPI.runDueSchedules();
      flash(`Processed ${res.processed} due schedule(s).`);
      schedulesQ.refetch();
    } catch (e) {
      flash(e?.response?.status === 403 ? 'Only admins can trigger a run.' : 'Run failed');
    }
  };

  return (
    <div>
      <SectionHeader
        title="Scheduled Reports"
        subtitle="Deliver a saved report on a recurring cadence. The server checks for due schedules every few minutes and emails them automatically — configure the sender below first."
      />

      <div className={`rpt-banner ${email.configured ? 'ok' : 'warn'}`}>
        <span>
          {email.configured
            ? <>Email delivery is <b>active</b> (from {email.from}). Due schedules will render, export and email their recipients.</>
            : <><b>Email is not configured.</b> Schedules are stored and will render + audit on run, but nothing is sent until you set the sender below. No silent "sent" status.</>}
        </span>
      </div>

      <EmailSettings
        email={email}
        flash={flash}
        onSaved={() => {
          queryClient.invalidateQueries({ queryKey: ['reports', 'schedules'] });
          queryClient.invalidateQueries({ queryKey: ['reports', 'caps'] });
        }}
      />

      {/* Create form */}
      <div className="rpt-form">
        <div className="rpt-form-row">
          <label>Name<input value={form.name} onChange={(e) => setF('name', e.target.value)} placeholder="Weekly Executive Report" /></label>
          <label>Source report
            <select value={form.sourceId} onChange={(e) => setF('sourceId', e.target.value)}>
              <option value="">Choose a saved report…</option>
              {library.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </label>
          <label>Cadence
            <select value={form.cadence} onChange={(e) => setF('cadence', e.target.value)}>
              {CADENCES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
            </select>
          </label>
          <label>Hour (UTC)<input type="number" min={0} max={23} value={form.hourUtc} onChange={(e) => setF('hourUtc', e.target.value)} /></label>
          {form.cadence === 'weekly' && (
            <label>Weekday
              <select value={form.weekday} onChange={(e) => setF('weekday', e.target.value)}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </select>
            </label>
          )}
          {form.cadence === 'monthly' && (
            <label>Day of month<input type="number" min={1} max={28} value={form.dayOfMonth} onChange={(e) => setF('dayOfMonth', e.target.value)} /></label>
          )}
        </div>
        <label style={{ textTransform: 'none', letterSpacing: 0 }}>Recipients (comma-separated)
          <input value={form.recipients} onChange={(e) => setF('recipients', e.target.value)} placeholder="ceo@company.com, coo@company.com" />
        </label>
        <div className="rpt-form-fmts">
          <span style={{ fontWeight: 600 }}>Formats:</span>
          {ALL_FORMATS.map((f) => (
            <label key={f}>
              <input type="checkbox" checked={form.formats.includes(f)} disabled={caps[f] === false} onChange={() => toggleFmt(f)} />
              {f.toUpperCase()}{caps[f] === false ? ' (off)' : ''}
            </label>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <button className="rb-generate" style={{ width: 'auto', padding: '10px 18px' }} disabled={creating} onClick={create}>{creating ? 'Creating…' : 'Create schedule'}</button>
          <button className="rpt-mini-btn" onClick={runNow} title="Admin only — process schedules that are due now">Run due now</button>
        </div>
      </div>

      {/* Schedule list */}
      {schedulesQ.isError ? (
        <div className="rpt-error">Failed to load schedules.</div>
      ) : schedules.length === 0 ? (
        <div className="rpt-empty"><div className="rpt-empty-card">
          <span className="rpt-empty-eyebrow">No schedules</span>
          <h3>No recurring reports yet</h3>
          <p>Save a report to the library, then schedule it above for automated delivery.</p>
        </div></div>
      ) : (
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead><tr><th>Schedule</th><th>Cadence</th><th>Next run (UTC)</th><th>Recipients</th><th>Formats</th><th>Last</th><th></th></tr></thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id}>
                  <td><strong>{s.name}</strong></td>
                  <td><span className="rpt-pill muted">{s.cadence}</span></td>
                  <td>{fmtDate(s.nextRunAt)}</td>
                  <td>{(s.recipients || []).length ? `${s.recipients.length} recipient(s)` : '—'}</td>
                  <td>{(s.formats || []).join(', ').toUpperCase() || '—'}</td>
                  <td>{s.lastStatus ? <span className={`rpt-pill ${s.lastStatus === 'sent' ? 'good' : 'warn'}`}>{s.lastStatus}</span> : <span className="rpt-pill muted">never</span>}</td>
                  <td style={{ textAlign: 'right' }}><button className="rpt-mini-btn danger" onClick={() => remove(s.id)}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {toast && <div className="rb-toast" style={{ maxWidth: 460 }}>{toast}</div>}
    </div>
  );
};

export default ScheduledReports;
