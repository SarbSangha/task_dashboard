import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import CollapsibleSection from './CollapsibleSection';

/**
 * Flow credits: Flow shows no cost per generation, so each output is priced
 * from Google's published rate for its model, resolution and duration,
 * under the plan its account was on that day (Free is charged the Plus & Pro
 * rate). Rates and plans are both dated: a change starts on its date and
 * earlier generations keep their price. Saving re-prices what it covers.
 * Backend: providers/flow/pricing.py, routers/credit_rates_router.py.
 */

const muted = { fontSize: 12, color: 'var(--color-text-muted, #888)' };
const label = { fontSize: 11, color: 'var(--color-text-muted, #888)' };
const rowBorder = { padding: '10px 0', borderBottom: '1px solid var(--color-border, #2a2a2a)' };
const today = () => new Date().toISOString().slice(0, 10);
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric',
}) : 'now');
const credits = (n) => (n == null ? '—' : n);
const settingsOf = (r) => [r.resolution, r.durationSeconds != null && `${r.durationSeconds}s`].filter(Boolean).join(' · ') || 'any';
const errorText = (e) => e?.response?.data?.detail || e?.message || 'Save failed';
const QUERY_KEY = ['reports', 'flow-pricing'];
const LOGIN_LABEL = { google: 'Google sign-in', email_password: 'email sign-in' };
// "Company account · Google sign-in · used by Administrator, chahal"
const accountKind = (a) => [
  a.scope === 'user' ? 'Personal account' : 'Company account',
  LOGIN_LABEL[a.loginMethod] || a.loginMethod,
  (a.linkedUserNames || []).length ? `used by ${a.linkedUserNames.join(', ')}` : '',
].filter(Boolean).join(' · ');

const useFlowMutation = (fn, onDone) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (res) => {
      qc.setQueryData(QUERY_KEY, res);
      qc.invalidateQueries({ queryKey: ['reports', 'cost'] });
      onDone?.(res);
    },
  });
};

const PlanEditor = ({ account, plans }) => {
  const [plan, setPlan] = useState(account.currentPlan || 'pro');
  const [from, setFrom] = useState(account.history.length ? today() : '2026-01-01');
  const [saved, setSaved] = useState('');
  const m = useFlowMutation(
    () => reportsAPI.flowPlanSet({ credentialId: account.id, plan, effectiveFrom: from }),
    (res) => setSaved(`Saved · ${res.generationsUpdated} generation${res.generationsUpdated === 1 ? '' : 's'} re-priced`),
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); setSaved(''); m.mutate(); }}
      style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <label style={label}>
        Plan
        <select value={plan} onChange={(e) => setPlan(e.target.value)} className="rpt-input" style={{ display: 'block', width: 130 }}>
          {plans.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
        </select>
      </label>
      <label style={label}>
        Starts on
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required
          className="rpt-input" style={{ display: 'block', width: 150 }} />
      </label>
      <button type="submit" className="rpt-btn" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save plan'}</button>
      {m.isError && <span className="rpt-error" style={{ fontSize: 12 }}>{errorText(m.error)}</span>}
      {saved && !m.isError && <span style={{ fontSize: 12, color: 'var(--color-success, #2e7d32)' }}>{saved}</span>}
    </form>
  );
};

const RateEditor = ({ initial, onDone }) => {
  const [form, setForm] = useState({
    model: initial?.model || '',
    resolution: initial?.resolution || '',
    durationSeconds: initial?.durationSeconds ?? '',
    creditsPlusPro: initial?.creditsPlusPro ?? '',
    creditsUltra: initial?.creditsUltra ?? '',
    effectiveFrom: initial?.effectiveFrom || today(),
    notes: '',
  });
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const m = useFlowMutation(() => reportsAPI.flowRateSet({
    model: form.model.trim(),
    resolution: form.resolution.trim() || null,
    durationSeconds: num(form.durationSeconds),
    creditsPlusPro: num(form.creditsPlusPro),
    creditsUltra: num(form.creditsUltra),
    effectiveFrom: form.effectiveFrom,
    notes: form.notes.trim() || null,
  }), onDone);
  const submit = (e) => {
    e.preventDefault();
    const bad = [form.creditsPlusPro, form.creditsUltra, form.durationSeconds]
      .some((v) => v !== '' && (!Number.isInteger(Number(v)) || Number(v) < 0));
    if (!form.model.trim()) { setError('Model is required'); return; }
    if (bad) { setError('Credits and duration must be whole numbers, 0 or more'); return; }
    setError('');
    m.mutate();
  };
  const field = (k, text, width, props = {}) => (
    <label style={label}>
      {text}
      <input value={form[k]} onChange={set(k)} className="rpt-input" style={{ display: 'block', width }} {...props} />
    </label>
  );
  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap', padding: '8px 0' }}>
      {field('model', 'Model (as Flow shows it)', 200, { placeholder: 'e.g. Veo 3.1 - Fast', disabled: Boolean(initial?.id) })}
      {field('resolution', 'Resolution', 80, { placeholder: 'any', disabled: Boolean(initial?.id) })}
      {field('durationSeconds', 'Seconds', 70, { type: 'number', min: 0, placeholder: 'any', disabled: Boolean(initial?.id) })}
      {field('creditsPlusPro', 'Plus & Pro / Free', 110, { type: 'number', min: 0, placeholder: 'no price' })}
      {field('creditsUltra', 'Ultra', 80, { type: 'number', min: 0, placeholder: 'no price' })}
      {field('effectiveFrom', 'Starts on', 150, { type: 'date', required: true })}
      {field('notes', 'Note (optional)', 160, { maxLength: 200 })}
      <button type="submit" className="rpt-btn" disabled={m.isPending}>{m.isPending ? 'Saving…' : 'Save rate'}</button>
      {onDone && <button type="button" className="rpt-btn" onClick={() => onDone()}>Cancel</button>}
      {(error || m.isError) && <span className="rpt-error" style={{ fontSize: 12 }}>{error || errorText(m.error)}</span>}
    </form>
  );
};

// Every setting combination Flow offers, expanded from the current rates -
// the Combinations tab of flow_credit_combinations.xlsx. Aspect ratio and
// Frames vs Ingredients do not change the price; outputs multiply it. The
// rates stay the one thing an admin edits, so the combinations always agree.
const ASPECTS = ['16:9', '9:16'];
const OUTPUTS = [1, 2, 3, 4];
const modelKey = (m) => `${m || ''}`.toLowerCase().replace(/[^a-z0-9]/g, '');

function modesFor(rate) {
  if (rate.resolution == null && rate.durationSeconds == null) return [{ mode: '—' }];
  const key = modelKey(rate.model);
  if (key.includes('quality')) return [{ mode: 'Frames', note: 'Quality has no Ingredients' }];
  if (key.includes('omni')) return [{ mode: 'Frames' }, { mode: 'Ingredients', note: 'Omni Ingredients support not confirmed' }];
  return rate.durationSeconds === 8
    ? [{ mode: 'Frames' }, { mode: 'Ingredients', note: 'Ingredients is 8s only' }]
    : [{ mode: 'Frames' }];
}

// The sheet's row order; models not in it follow, alphabetically.
const MODEL_ORDER = ['veo31lite', 'veo31fast', 'veo31litelowerpriority', 'veo31quality', 'geminiomniflash',
  'nanobanana2lite', 'nanobanana21', 'nanobananapro'];
const modelRank = (m) => { const i = MODEL_ORDER.indexOf(modelKey(m)); return i < 0 ? MODEL_ORDER.length : i; };
const resolutionPx = (r) => parseInt(r, 10) || 0;

function expandCombinations(rates) {
  const rows = [];
  const ordered = rates.filter((r) => r.current).sort((a, b) => modelRank(a.model) - modelRank(b.model)
    || a.model.localeCompare(b.model)
    || resolutionPx(b.resolution) - resolutionPx(a.resolution)
    || (a.durationSeconds || 0) - (b.durationSeconds || 0));
  for (const rate of ordered) {
    const isImage = rate.resolution == null && rate.durationSeconds == null;
    for (const { mode, note } of modesFor(rate)) {
      for (const aspect of ASPECTS) {
        for (const outputs of OUTPUTS) {
          rows.push({
            key: `${rate.id}|${mode}|${aspect}|${outputs}`,
            rate, type: isImage ? 'Image' : 'Video', mode, aspect, outputs,
            plusPro: rate.creditsPlusPro == null ? null : rate.creditsPlusPro * outputs,
            ultra: rate.creditsUltra == null ? null : rate.creditsUltra * outputs,
            note: [note, rate.creditsPlusPro == null && rate.creditsUltra != null ? 'Ultra only' : ''].filter(Boolean).join('; '),
          });
        }
      }
    }
  }
  return rows;
}

const CombinationsTable = ({ rates, onEditRate }) => {
  const [model, setModel] = useState('');
  const all = expandCombinations(rates);
  const models = [...new Set(all.map((c) => c.rate.model))];
  const rows = model ? all.filter((c) => c.rate.model === model) : all;
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
        <select value={model} onChange={(e) => setModel(e.target.value)} className="rpt-input" style={{ width: 240 }}>
          <option value="">All models ({all.length} combinations)</option>
          {models.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <span style={muted}>Totals are for all outputs of one click. &ldquo;Edit rate&rdquo; changes every combination of that model, resolution and duration.</span>
      </div>
      <div style={{ maxHeight: 420, overflow: 'auto' }}>
        <table className="rpt-table" style={{ fontSize: 12, width: '100%' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>#</th><th style={{ textAlign: 'left' }}>Type</th>
              <th style={{ textAlign: 'left' }}>Mode</th><th style={{ textAlign: 'left' }}>Aspect</th>
              <th style={{ textAlign: 'left' }}>Model</th><th style={{ textAlign: 'left' }}>Resolution</th>
              <th style={{ textAlign: 'left' }}>Duration</th><th style={{ textAlign: 'right' }}>Outputs</th>
              <th style={{ textAlign: 'right' }}>Plus &amp; Pro</th><th style={{ textAlign: 'right' }}>Ultra</th>
              <th style={{ textAlign: 'left' }}>Notes</th><th />
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => (
              <tr key={c.key}>
                <td style={muted}>{i + 1}</td>
                <td>{c.type}</td><td>{c.mode}</td><td>{c.aspect}</td><td>{c.rate.model}</td>
                <td>{c.rate.resolution || '—'}</td>
                <td>{c.rate.durationSeconds != null ? `${c.rate.durationSeconds}s` : '—'}</td>
                <td style={{ textAlign: 'right' }}>{c.outputs}</td>
                <td style={{ textAlign: 'right' }}><b>{credits(c.plusPro)}</b></td>
                <td style={{ textAlign: 'right' }}><b>{credits(c.ultra)}</b></td>
                <td style={muted}>{c.note}</td>
                <td style={{ textAlign: 'right' }}>
                  <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    onClick={() => onEditRate(c.rate)}>
                    Edit rate
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const FlowPricingAdmin = () => {
  const q = useQuery({ queryKey: QUERY_KEY, queryFn: () => reportsAPI.flowPricing(), staleTime: 60_000 });
  const [editing, setEditing] = useState(null); // rate (or {model,...} prefill) being edited; {} = new
  const [showPast, setShowPast] = useState(false);
  const [view, setView] = useState('rates'); // rates | combinations
  const removeRate = useFlowMutation((id) => reportsAPI.flowRateDelete(id));
  const removePlan = useFlowMutation((id) => reportsAPI.flowPlanDelete(id));

  if (q.isLoading) return <div className="rpt-card" style={{ padding: 16 }}>Loading Flow pricing…</div>;
  if (q.isError) {
    return <div className="rpt-error" style={{ padding: 12 }}>Failed to load Flow pricing: {errorText(q.error)}</div>;
  }

  const { rates = [], accounts = [], plans = [], generations = {} } = q.data || {};
  const planLabel = Object.fromEntries(plans.map((p) => [p.value, p.label]));
  const shownRates = showPast ? rates : rates.filter((r) => r.current);
  const editKey = (r) => (editing && editing.id === r.id);
  const withPlan = accounts.filter((a) => a.currentPlan).length;
  const currentRates = rates.filter((r) => r.current).length;
  const accountsSummary = `${accounts.length} account${accounts.length === 1 ? '' : 's'} · ${withPlan} with a plan`;
  const summary = `${generations.priced ?? 0} of ${generations.total ?? 0} generations priced · ${accountsSummary} · ${currentRates} rates`;

  return (
    <CollapsibleSection title="Flow credits" summary={summary} storageKey="rmw.pricing.flow.open">
      <div className="rpt-card-hint" style={{ marginBottom: 6 }}>
        Each output costs Google&apos;s rate for its model, resolution and duration, under the account&apos;s plan.
        Free accounts use the Plus &amp; Pro rate.
      </div>
      <div style={{ ...muted, marginBottom: 4 }}>
        <b>{generations.priced ?? 0}</b> of {generations.total ?? 0} Flow generations priced
        {generations.withoutSettings > 0 && ` · ${generations.withoutSettings} captured before settings were recorded (left blank)`}
        {generations.withoutPlan > 0 && ` · ${generations.withoutPlan} on accounts with no plan`}
      </div>

      <CollapsibleSection level="section" title="Account plans" summary={accountsSummary}
        storageKey="rmw.pricing.flow.accounts.open" defaultOpen>
      {accounts.length === 0 && <div style={muted}>No Flow accounts found.</div>}
      {accounts.map((a) => (
        <div key={a.id} style={rowBorder}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <div style={{ minWidth: 220, flex: '1 1 260px' }}>
              <b style={{ fontSize: 13 }}>{a.label}{!a.active && <span style={muted}> (inactive)</span>}</b>
              <div style={muted}>
                {accountKind(a)}
                {' · now: '}<b>{a.currentPlan ? planLabel[a.currentPlan] : 'not set'}</b>
                {' · '}{a.generations} generation{a.generations === 1 ? '' : 's'}
              </div>
            </div>
            <PlanEditor account={a} plans={plans} />
          </div>
          {a.history.length > 0 && (
            <table className="rpt-table" style={{ marginTop: 8, fontSize: 12, width: '100%' }}>
              <tbody>
                {a.history.map((h) => (
                  <tr key={h.id}>
                    <td>{fmtDate(h.effectiveFrom)} → {h.effectiveTo ? fmtDate(h.effectiveTo) : 'now'}</td>
                    <td><b>{planLabel[h.plan] || h.plan}</b></td>
                    <td style={muted}>{h.notes || ''}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                        disabled={removePlan.isPending}
                        onClick={() => {
                          if (window.confirm(`Remove the ${planLabel[h.plan]} plan from ${fmtDate(h.effectiveFrom)}? `
                            + 'The plan before it will apply to those dates again.')) removePlan.mutate(h.id);
                        }}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
      </CollapsibleSection>

      {(generations.withoutRate || []).length > 0 && (
        <div style={{ marginTop: 14 }}>
          <h4 style={{ fontSize: 13, margin: '4px 0' }}>Generations with no rate</h4>
          {generations.withoutRate.map((w) => (
            <div key={`${w.model}|${w.resolution}|${w.durationSeconds}|${w.plan}`}
              style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', ...rowBorder }}>
              <span style={{ fontSize: 12 }}>
                <b>{w.model}</b> · {settingsOf(w)} on {planLabel[w.plan] || w.plan} — {w.count} generation{w.count === 1 ? '' : 's'}
              </span>
              <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => setEditing({ model: w.model, resolution: w.resolution, durationSeconds: w.durationSeconds })}>
                Add rate
              </button>
            </div>
          ))}
        </div>
      )}

      <CollapsibleSection level="section" title="Rates & combinations"
        summary={`${currentRates} current rates · every setting combination`}
        storageKey="rmw.pricing.flow.rates.open" forceOpen={Boolean(editing)}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {[['rates', `Rates (${shownRates.length})`], ['combinations', 'All combinations']].map(([id, text]) => (
            <button key={id} type="button" className="rpt-btn" onClick={() => setView(id)}
              style={{ fontSize: 12, padding: '2px 10px', ...(view === id ? { borderColor: 'var(--color-primary, #2563eb)', fontWeight: 700 } : {}) }}>
              {text}
            </button>
          ))}
          <span style={muted}>{view === 'rates' ? 'credits per output' : 'every setting combination, from the rates'}</span>
        </span>
        <span style={{ display: view === 'rates' ? 'flex' : 'none', gap: 8, alignItems: 'center' }}>
          <label style={{ ...muted, display: 'flex', gap: 4, alignItems: 'center' }}>
            <input type="checkbox" checked={showPast} onChange={(e) => setShowPast(e.target.checked)} /> show past rates
          </label>
          <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => setEditing({})}>
            Add rate
          </button>
        </span>
      </div>
      {view === 'combinations' && (
        <CombinationsTable rates={rates} onEditRate={(r) => { setEditing({ ...r, effectiveFrom: today() }); setView('rates'); }} />
      )}
      {view === 'rates' && editing && !editing.id && <RateEditor initial={editing} onDone={() => setEditing(null)} />}
      {view === 'rates' && (
      <table className="rpt-table" style={{ marginTop: 6, fontSize: 12, width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Model</th><th style={{ textAlign: 'left' }}>Settings</th>
            <th style={{ textAlign: 'right' }}>Plus &amp; Pro</th><th style={{ textAlign: 'right' }}>Ultra</th>
            <th style={{ textAlign: 'left' }}>From</th><th style={{ textAlign: 'left' }}>Note</th><th />
          </tr>
        </thead>
        <tbody>
          {shownRates.map((r) => (
            <React.Fragment key={r.id}>
              <tr style={r.current ? undefined : { opacity: 0.55 }}>
                <td>{r.model}</td>
                <td>{settingsOf(r)}</td>
                <td style={{ textAlign: 'right' }}><b>{credits(r.creditsPlusPro)}</b></td>
                <td style={{ textAlign: 'right' }}><b>{credits(r.creditsUltra)}</b></td>
                <td>{fmtDate(r.effectiveFrom)}{r.effectiveTo && ` → ${fmtDate(r.effectiveTo)}`}</td>
                <td style={muted}>{r.notes || ''}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {r.current && (
                    <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
                      onClick={() => setEditing({ ...r, effectiveFrom: today() })}>
                      Change
                    </button>
                  )}
                  <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                    disabled={removeRate.isPending}
                    onClick={() => {
                      if (window.confirm(`Remove this ${r.model} (${settingsOf(r)}) rate from ${fmtDate(r.effectiveFrom)}? `
                        + 'The rate before it will apply to those dates again.')) removeRate.mutate(r.id);
                    }}>
                    Remove
                  </button>
                </td>
              </tr>
              {editKey(r) && (
                <tr><td colSpan={7}><RateEditor initial={editing} onDone={() => setEditing(null)} /></td></tr>
              )}
            </React.Fragment>
          ))}
        </tbody>
      </table>
      )}
      <div style={{ ...muted, marginTop: 8 }}>
        &ldquo;—&rdquo; = no price: not offered on that plan, or not published by Google yet. Those generations stay unpriced.
      </div>
      </CollapsibleSection>
    </CollapsibleSection>
  );
};

export default FlowPricingAdmin;
