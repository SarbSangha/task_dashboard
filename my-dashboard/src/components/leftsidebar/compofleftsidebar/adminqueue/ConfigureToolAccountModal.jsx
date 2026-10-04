import { useState } from 'react';
import { creditRatesAPI, itToolsAPI } from '../../../../services/api';
import './ConfigureToolAccountModal.css';

const RENEWAL_TYPE_OPTIONS = [
  { value: 'MONTHLY', label: 'Monthly Plan' },
  { value: 'YEARLY', label: 'Yearly Plan' },
  { value: 'CREDIT_CONSUMPTION', label: 'Credit Consumption' },
  { value: 'MANUAL', label: 'Manual' },
];

// Calendar-billed plans and how many months one billing period spans --
// mirrors PLAN_PERIOD_MONTHS in backend utils/tool_renewal_service.py.
const PLAN_PERIOD_MONTHS = { MONTHLY: 1, YEARLY: 12 };

// 'YYYY-MM-DD' + n months, clamping the day (Jan 31 + 1 -> Feb 28).
const addMonths = (isoDate, months) => {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (!y || !m || !d) return '';
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDay))}`;
};

const formatRupees = (value) => {
  if (value === null || value === undefined) return '—';
  return `₹${Number(value).toLocaleString(undefined, { maximumFractionDigits: 4 })}`;
};

/**
 * The "⋮ Configure" dialog for one Tool Renew account row. Per-account, not
 * per-tool: two accounts on the same tool (e.g. two Behance logins) can be
 * configured independently. Credit numbers (Total Credits / Cost) still ride
 * the existing credit-rate endpoint; everything else is the account's own
 * renewal configuration, saved through the existing credential upsert
 * endpoint the rest of this page already uses.
 */
export default function ConfigureToolAccountModal({ row, onClose, onSaved }) {
  const [creditEnabled, setCreditEnabled] = useState(Boolean(row.creditEnabled));
  const [totalCredits, setTotalCredits] = useState(row.totalCredits != null ? String(row.totalCredits) : '');
  const [renewalType, setRenewalType] = useState(row.renewalType || 'MANUAL');
  const [renewalDate, setRenewalDate] = useState(row.renewalDate || '');
  const [autoRenew, setAutoRenew] = useState(Boolean(row.autoRenew));
  const [purchaseDate, setPurchaseDate] = useState(row.purchaseDate || '');
  const [toolCost, setToolCost] = useState(row.toolCost != null ? String(row.toolCost) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const planMonths = PLAN_PERIOD_MONTHS[renewalType];

  // On a monthly/yearly plan the renewal date follows from the purchase
  // date, so fill it in (still editable) whenever either one changes.
  const changePurchaseDate = (value) => {
    setPurchaseDate(value);
    if (value && planMonths) setRenewalDate(addMonths(value, planMonths));
  };
  const changeRenewalType = (value) => {
    setRenewalType(value);
    const months = PLAN_PERIOD_MONTHS[value];
    if (months && purchaseDate) setRenewalDate(addMonths(purchaseDate, months));
  };

  const handleSave = async () => {
    if (toolCost !== '' && Number(toolCost) < 0) {
      setError('Cost must be 0 or greater.');
      return;
    }
    if (creditEnabled && totalCredits !== '' && Number(totalCredits) <= 0) {
      setError('Total credits must be greater than 0.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const payload = {
        credential_id: row.id,
        scope: 'company',
        credit_enabled: creditEnabled,
        renewal_type: renewalType,
        auto_renew: planMonths ? autoRenew : false,
        purchase_date: purchaseDate || '',
        tool_cost: toolCost === '' ? 0 : Number(toolCost),
      };
      // Credit Consumption doesn't use a calendar renewal date -- leave
      // whatever is already stored untouched rather than wiping it, in case
      // the admin switches back to Monthly later.
      if (renewalType !== 'CREDIT_CONSUMPTION') {
        payload.renewal_date = renewalDate || '';
      }
      await itToolsAPI.upsertCredential(row.toolId, payload);

      if (creditEnabled && totalCredits !== '' && Number(totalCredits) > 0) {
        await creditRatesAPI.upsert({
          credentialId: row.id,
          packageCredits: Number(totalCredits),
          packageRupees: Number(toolCost || 0),
        });
      }

      await onSaved();
      onClose();
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to save configuration.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="ctam-overlay" onClick={saving ? undefined : onClose} />
      <div className="ctam-modal" role="dialog" aria-modal="true" aria-label={`Configure ${row.toolName} account`}>
        <div className="ctam-header">
          <div>
            <h3 className="ctam-title">Configure Tool</h3>
            <p className="ctam-subtitle">{row.toolName} · {row.account}</p>
          </div>
          <button type="button" className="ctam-close" onClick={onClose} aria-label="Close" disabled={saving}>✕</button>
        </div>

        <div className="ctam-body">
          {error && <div className="ctam-error" role="alert">{error}</div>}

          <section className="ctam-section">
            <div className="ctam-toggle-row">
              <div>
                <span className="ctam-field-label">Credit System</span>
                <p className="ctam-field-hint">Turn on to track this account's credit balance and cost per credit.</p>
              </div>
              <label className="ctam-switch">
                <input
                  type="checkbox"
                  checked={creditEnabled}
                  onChange={(e) => setCreditEnabled(e.target.checked)}
                  aria-label="Enable credit system"
                />
                <span className="ctam-switch-track" aria-hidden="true" />
              </label>
            </div>
          </section>

          {creditEnabled && (
            <section className="ctam-section">
              <h4 className="ctam-section-title">Credit Configuration</h4>
              <div className="ctam-grid">
                <label className="ctam-field">
                  <span>Total Credits</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    className="ctam-input"
                    placeholder="e.g. 10000"
                    value={totalCredits}
                    onChange={(e) => setTotalCredits(e.target.value)}
                  />
                </label>
                <label className="ctam-field">
                  <span>Cost Per Credit</span>
                  <input type="text" className="ctam-input" readOnly value={formatRupees(row.costPerCredit)} />
                </label>
              </div>
            </section>
          )}

          <section className="ctam-section">
            <h4 className="ctam-section-title">Renewal Configuration</h4>
            <div className="ctam-radio-group" role="radiogroup" aria-label="Renewal type">
              {RENEWAL_TYPE_OPTIONS.map((option) => (
                <label key={option.value} className={`ctam-radio${renewalType === option.value ? ' is-selected' : ''}`}>
                  <input
                    type="radio"
                    name="renewalType"
                    value={option.value}
                    checked={renewalType === option.value}
                    onChange={() => changeRenewalType(option.value)}
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>

            {renewalType !== 'CREDIT_CONSUMPTION' && (
              <div className="ctam-grid">
                <label className="ctam-field">
                  <span>Renewal Date{renewalType === 'MANUAL' ? ' (optional)' : ''}</span>
                  <input
                    type="date"
                    className="ctam-input"
                    value={renewalDate}
                    onChange={(e) => setRenewalDate(e.target.value)}
                  />
                </label>
                {planMonths && (
                  <div className="ctam-toggle-row ctam-toggle-row--inline">
                    <span className="ctam-field-label">Auto Renew</span>
                    <label className="ctam-switch">
                      <input
                        type="checkbox"
                        checked={autoRenew}
                        onChange={(e) => setAutoRenew(e.target.checked)}
                        aria-label="Auto renew"
                      />
                      <span className="ctam-switch-track" aria-hidden="true" />
                    </label>
                  </div>
                )}
              </div>
            )}

            {planMonths && (
              <p className="ctam-field-hint">
                {autoRenew
                  ? `Auto renew: when the renewal date arrives it becomes the new purchase date and the renewal date moves ${planMonths === 12 ? 'one year' : 'one month'} ahead.`
                  : 'Turn on Auto Renew if this tool is charged automatically; otherwise it is flagged once the renewal date passes.'}
              </p>
            )}

            {renewalType === 'CREDIT_CONSUMPTION' && (
              <p className="ctam-field-hint">
                {creditEnabled
                  ? 'Renews automatically once the credits above are fully consumed.'
                  : 'Turn on the credit system above so this account knows when its credits run out.'}
              </p>
            )}
          </section>

          <section className="ctam-section">
            <h4 className="ctam-section-title">Purchase Information</h4>
            <div className="ctam-grid">
              <label className="ctam-field">
                <span>Purchase Date</span>
                <input
                  type="date"
                  className="ctam-input"
                  value={purchaseDate}
                  onChange={(e) => changePurchaseDate(e.target.value)}
                />
              </label>
              <label className="ctam-field">
                <span>Cost (₹)</span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  className="ctam-input"
                  placeholder="e.g. 20000"
                  value={toolCost}
                  onChange={(e) => setToolCost(e.target.value)}
                />
              </label>
            </div>
          </section>
        </div>

        <div className="ctam-footer">
          <button type="button" className="ctam-btn ctam-btn--ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="ctam-btn ctam-btn--primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </>
  );
}
