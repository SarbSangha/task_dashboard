import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';

/**
 * Fixed credits per generation for tools that never report a cost of their
 * own (Suno: one song = N credits). Each price has a start date; adding a
 * new one ends the previous price the day before, so older generations keep
 * the price they were made at. Saving re-stamps the generations it covers.
 * Backend: services/generation_pricing.py, routers/credit_rates_router.py.
 */

const muted = { fontSize: 12, color: 'var(--color-text-muted, #888)' };
const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric',
}) : 'now');

const PriceEditor = ({ tool, onDone }) => {
  const qc = useQueryClient();
  const [credits, setCredits] = useState(tool.currentCredits ?? '');
  const [from, setFrom] = useState(tool.history.length ? new Date().toISOString().slice(0, 10) : tool.firstGenerationDate);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const mutation = useMutation({
    mutationFn: () => reportsAPI.generationPriceSet({
      tool: tool.tool, creditsPerGeneration: Number(credits), effectiveFrom: from, notes: notes || null,
    }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ['reports', 'generation-prices'] });
      qc.invalidateQueries({ queryKey: ['reports', 'cost'] });
      setError('');
      setNotes('');
      setSaved(`Saved · ${res.generationsUpdated} ${tool.unit}${res.generationsUpdated === 1 ? '' : 's'} updated`);
      onDone?.();
    },
    onError: (e) => { setSaved(''); setError(e?.response?.data?.detail || e?.message || 'Save failed'); },
  });

  const submit = (e) => {
    e.preventDefault();
    const n = Number(credits);
    if (!Number.isInteger(n) || n < 0) { setError('Credits must be a whole number, 0 or more'); return; }
    if (!from) { setError('Pick the date this price starts'); return; }
    mutation.mutate();
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted, #888)' }}>
        Credits per {tool.unit}
        <input type="number" min="0" step="1" value={credits} onChange={(e) => setCredits(e.target.value)}
          className="rpt-input" style={{ display: 'block', width: 110 }} placeholder="e.g. 5" />
      </label>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted, #888)' }}>
        Starts on
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)}
          className="rpt-input" style={{ display: 'block', width: 150 }} />
      </label>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted, #888)', flex: '1 1 160px' }}>
        Note (optional)
        <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200}
          className="rpt-input" style={{ display: 'block', width: '100%' }} placeholder="e.g. Pro plan price" />
      </label>
      <button type="submit" className="rpt-btn" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save price'}
      </button>
      {error && <span className="rpt-error" style={{ fontSize: 12 }}>{error}</span>}
      {saved && !error && <span style={{ fontSize: 12, color: 'var(--color-success, #2e7d32)' }}>{saved}</span>}
    </form>
  );
};

const GenerationPricesAdmin = () => {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['reports', 'generation-prices'],
    queryFn: () => reportsAPI.generationPrices(),
    staleTime: 60_000,
  });
  const remove = useMutation({
    mutationFn: (id) => reportsAPI.generationPriceDelete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['reports', 'generation-prices'] }),
  });

  if (q.isLoading) return <div className="rpt-card" style={{ padding: 16 }}>Loading fixed prices…</div>;
  if (q.isError) {
    return (
      <div className="rpt-error" style={{ padding: 12 }}>
        Failed to load fixed prices: {q.error?.response?.data?.detail || q.error?.message}
      </div>
    );
  }

  const tools = q.data?.tools || [];
  return (
    <div className="rpt-card" style={{ padding: 16, marginBottom: 20 }}>
      <div className="rpt-card-head" style={{ marginBottom: 10 }}>
        <h3 className="rpt-card-title" style={{ fontSize: 14 }}>Credits per generation</h3>
        <span className="rpt-card-hint">
          For tools that never report a cost. A new price starts on its date; earlier generations keep their price.
        </span>
      </div>
      {tools.map((t) => (
        <div key={t.tool} style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border, #2a2a2a)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
            <b style={{ fontSize: 13 }}>{t.tool}</b>
            <span style={muted}>
              current: <b>{t.currentCredits != null ? `${t.currentCredits} credits per ${t.unit}` : 'not set'}</b>
              {' · '}{t.generations} {t.unit}s captured
              {t.generationsWithoutPrice > 0 && `, ${t.generationsWithoutPrice} without a price`}
            </span>
          </div>
          <PriceEditor tool={t} />
          {t.history.length > 0 && (
            <table className="rpt-table" style={{ marginTop: 10, fontSize: 12, width: '100%' }}>
              <thead>
                <tr><th style={{ textAlign: 'left' }}>From</th><th style={{ textAlign: 'left' }}>To</th>
                  <th style={{ textAlign: 'right' }}>Credits per {t.unit}</th><th style={{ textAlign: 'left' }}>Note</th><th /></tr>
              </thead>
              <tbody>
                {t.history.map((h) => (
                  <tr key={h.id}>
                    <td>{fmtDate(h.effectiveFrom)}</td>
                    <td>{h.effectiveTo ? fmtDate(h.effectiveTo) : 'now'}</td>
                    <td style={{ textAlign: 'right' }}><b>{h.credits}</b></td>
                    <td style={muted}>{h.notes || '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <button type="button" className="rpt-btn" style={{ fontSize: 11, padding: '2px 8px' }}
                        disabled={remove.isPending}
                        onClick={() => {
                          if (window.confirm(`Remove the ${h.credits}-credit price from ${fmtDate(h.effectiveFrom)}? `
                            + 'The price before it will apply to those dates again.')) remove.mutate(h.id);
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
    </div>
  );
};

export default GenerationPricesAdmin;
