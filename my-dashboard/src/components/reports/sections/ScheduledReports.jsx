import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';

const CADENCES = ['daily', 'weekly', 'monthly'];
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ALL_FORMATS = ['pdf', 'xlsx', 'pptx', 'csv'];

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const ScheduledReports = () => {
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
        subtitle="Deliver a saved report on a recurring cadence. Firing is triggered by the run-due endpoint (wired to your deploy cron); email sends only when SMTP is configured."
      />

      <div className={`rpt-banner ${email.configured ? 'ok' : 'warn'}`}>
        <span>
          {email.configured
            ? <>Email delivery is <b>active</b> (from {email.from}). Due schedules will render, export and email their recipients.</>
            : <><b>Email is not configured.</b> Schedules are stored and will render + audit on run, but nothing is sent until <code>SMTP_HOST</code>/<code>SMTP_FROM</code> env vars are set. No silent "sent" status.</>}
        </span>
      </div>

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
