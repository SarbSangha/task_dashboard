import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import { formatFull } from '../utils/format';

// Enter a package (credits bought for rupees); the per-credit rate is derived.
const RateEditor = ({ credentialId, current, currency, onSaved }) => {
  const qc = useQueryClient();
  const [credits, setCredits] = useState(current?.packageCredits ?? '');
  const [rupees, setRupees] = useState(current?.packageRupees ?? '');
  const [error, setError] = useState('');

  const nCredits = Number(credits);
  const nRupees = Number(rupees);
  const preview = nCredits > 0 && nRupees >= 0 ? (nRupees / nCredits) : null;

  const mutation = useMutation({
    mutationFn: () => reportsAPI.creditRateUpsert({
      credentialId: credentialId ?? null,
      packageCredits: nCredits,
      packageRupees: nRupees,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['reports', 'credit-rates'] });
      qc.invalidateQueries({ queryKey: ['reports', 'cost'] }); // refresh ₹ on the cost page
      setError('');
      onSaved?.();
    },
    onError: (e) => setError(e?.response?.data?.detail || e?.message || 'Save failed'),
  });

  const submit = (e) => {
    e.preventDefault();
    if (!(nCredits > 0)) { setError('Credits must be greater than 0'); return; }
    if (!(nRupees >= 0)) { setError('Rupees must be 0 or greater'); return; }
    mutation.mutate();
  };

  return (
    <form onSubmit={submit} style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted, #888)' }}>
        Credits bought
        <input type="number" min="0" step="any" value={credits} onChange={(e) => setCredits(e.target.value)}
          className="rpt-input" style={{ display: 'block', width: 120 }} placeholder="e.g. 10000" />
      </label>
      <label style={{ fontSize: 11, color: 'var(--color-text-muted, #888)' }}>
        Rupees paid (₹)
        <input type="number" min="0" step="any" value={rupees} onChange={(e) => setRupees(e.target.value)}
          className="rpt-input" style={{ display: 'block', width: 120 }} placeholder="e.g. 5000" />
      </label>
      <div style={{ fontSize: 12, minWidth: 110 }}>
        <div style={{ color: 'var(--color-text-muted, #888)' }}>₹ / credit</div>
        <b>{preview != null ? `${currency || 'INR'} ${preview.toLocaleString(undefined, { maximumFractionDigits: 4 })}` : '—'}</b>
      </div>
      <button type="submit" className="rpt-btn" disabled={mutation.isPending}>
        {mutation.isPending ? 'Saving…' : 'Save'}
      </button>
      {error && <span className="rpt-error" style={{ fontSize: 12 }}>{error}</span>}
    </form>
  );
};

const CreditRatesAdmin = () => {
  const q = useQuery({
    queryKey: ['reports', 'credit-rates'],
    queryFn: () => reportsAPI.creditRatesList(),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const data = q.data || {};
  const currency = data.currency || 'INR';
  const accounts = data.accounts || [];
  const globalDefault = data.globalDefault;

  if (q.isLoading) return <div className="rpt-card" style={{ padding: 16 }}>Loading credit rates…</div>;
  if (q.isError) {
    return (
      <div className="rpt-error" style={{ padding: 12 }}>
        Failed to load credit rates: {q.error?.response?.data?.detail || q.error?.message}
      </div>
    );
  }

  return (
    <div className="rpt-card" style={{ padding: 16, marginBottom: 20 }}>
      <div className="rpt-card-head" style={{ marginBottom: 10 }}>
        <h3 className="rpt-card-title" style={{ fontSize: 14 }}>Kling credit → ₹ rates</h3>
        <span className="rpt-card-hint">Set what each Kling account paid, so credits convert to real money.</span>
      </div>

      {/* Global fallback */}
      <div style={{ padding: '10px 0', borderBottom: '1px solid var(--color-border, #2a2a2a)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
          <b style={{ fontSize: 13 }}>Global fallback</b>
          <span style={{ fontSize: 12, color: 'var(--color-text-muted, #888)' }}>
            Used for generations not linked to an account · current:{' '}
            <b>{globalDefault ? `${currency} ${formatFull(globalDefault.ratePerCredit)}/cr` : 'not set (defaults to 1:1)'}</b>
          </span>
        </div>
        <RateEditor credentialId={null} current={globalDefault} currency={currency} />
      </div>

      {/* Per Kling account */}
      <div style={{ marginTop: 8 }}>
        {accounts.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--color-text-muted, #888)' }}>No Kling accounts found in the IT vault.</p>
        )}
        {accounts.map((a) => (
          <div key={a.credentialId} style={{ padding: '12px 0', borderBottom: '1px solid var(--color-border, #2a2a2a)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
              <span style={{ fontSize: 13 }}>
                <b>{a.label}</b>
                {!a.isActive && <span className="rpt-pill muted" style={{ marginLeft: 8 }}>inactive</span>}
              </span>
              <span style={{ fontSize: 12, color: 'var(--color-text-muted, #888)' }}>
                current:{' '}
                <b>{a.currentRate ? `${a.currentRate.currency || currency} ${formatFull(a.currentRate.ratePerCredit)}/cr` : 'using global fallback'}</b>
              </span>
            </div>
            <RateEditor credentialId={a.credentialId} current={a.currentRate} currency={currency} />
          </div>
        ))}
      </div>
    </div>
  );
};

export default CreditRatesAdmin;
