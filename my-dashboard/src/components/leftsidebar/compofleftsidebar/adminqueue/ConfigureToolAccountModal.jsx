import { useState } from 'react';
import { creditRatesAPI, itToolsAPI } from '../../../../services/api';
import './ConfigureToolAccountModal.css';
import {
  NO_COST_PLANS,
  OTHER_PLANS,
  PERIOD_TEXT,
  PLAN_LABELS,
  PLAN_PERIOD_MONTHS,
  SUBSCRIPTION_PLANS,
  addMonths,
  formatDate,
  formatNumber,
  formatRupees,
} from './toolPlans';

const PLAN_HINTS = {
  CREDIT_CONSUMPTION: 'Bought once as a pack of credits. Flagged for renewal when the credits run out.',
  MANUAL: 'No fixed billing cycle. Enter the dates yourself; it is flagged once the renewal date passes.',
  FREE: 'A free plan: no cost is counted. Turn on credits below if the free plan has a credit limit.',
  NOT_PURCHASED: 'This account is not bought right now. No cost or renewal is tracked until you pick a plan.',
};

function ChipGroup({ label, options, value, onChange }) {
  return (
    <div className="ctam-plan-group">
      <span className="ctam-plan-group-label">{label}</span>
      <div className="ctam-radio-group" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <label key={option.value} className={`ctam-radio${value === option.value ? ' is-selected' : ''}`}>
            <input
              type="radio"
              name={label}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

function Switch({ checked, onChange, label }) {
  return (
    <label className="ctam-switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} aria-label={label} />
      <span className="ctam-switch-track" aria-hidden="true" />
    </label>
  );
}

/**
 * The "⋮ Configure" dialog for one Tool Renew account row. Per-account, not
 * per-tool: two accounts on the same tool (e.g. two Behance logins) can be
 * configured independently. Credit numbers (Total Credits / Cost) still ride
 * the existing credit-rate endpoint; everything else is the account's own
 * renewal configuration, saved through the existing credential upsert
 * endpoint the rest of this page already uses.
 */
export default function ConfigureToolAccountModal({ row, onClose, onSaved }) {
  const [plan, setPlan] = useState(row.renewalType || 'MANUAL');
  const [creditEnabled, setCreditEnabled] = useState(Boolean(row.creditEnabled));
  const [totalCredits, setTotalCredits] = useState(row.totalCredits != null ? String(row.totalCredits) : '');
  const [creditReset, setCreditReset] = useState(row.creditReset || 'CYCLE');
  const [renewalDate, setRenewalDate] = useState(row.renewalDate || '');
  const [autoRenew, setAutoRenew] = useState(Boolean(row.autoRenew));
  const [purchaseDate, setPurchaseDate] = useState(row.purchaseDate || '');
  const [toolCost, setToolCost] = useState(row.toolCost != null ? String(row.toolCost) : '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const planMonths = PLAN_PERIOD_MONTHS[plan];
  const isSubscription = Boolean(planMonths);
  const notPurchased = plan === 'NOT_PURCHASED';
  const noCost = NO_COST_PLANS.has(plan);
  const showRenewalDate = isSubscription || plan === 'MANUAL';
  const creditsOn = !notPurchased && creditEnabled;
  // A monthly plan already resets monthly and a pack never resets, so the
  // choice only matters for longer plans, custom dates and free plans.
  const showCreditReset = creditsOn && ((planMonths && planMonths > 1) || plan === 'MANUAL' || plan === 'FREE');
  const costLabel = isSubscription ? `Cost per ${PERIOD_TEXT[planMonths]} (₹)` : plan === 'CREDIT_CONSUMPTION' ? 'Pack cost (₹)' : 'Cost (₹)';
  const purchaseLabel = isSubscription ? 'Purchase / last renewed' : plan === 'FREE' ? 'Start date (optional)' : 'Purchase date';

  const creditsNumber = Number(totalCredits);
  const costNumber = noCost ? 0 : Number(toolCost || 0);
  const costPerCredit = creditsOn && creditsNumber > 0 ? costNumber / creditsNumber : null;

  // On a subscription the renewal date follows from the purchase date, so
  // fill it in (still editable) whenever either one changes.
  const changePurchaseDate = (value) => {
    setPurchaseDate(value);
    if (value && planMonths) setRenewalDate(addMonths(value, planMonths));
  };
  const changePlan = (value) => {
    setPlan(value);
    setError('');
    const months = PLAN_PERIOD_MONTHS[value];
    if (months && purchaseDate) setRenewalDate(addMonths(purchaseDate, months));
    if (value === 'CREDIT_CONSUMPTION') setCreditEnabled(true);
  };

  const resetOptions = [
    {
      value: 'CYCLE',
      label: isSubscription ? 'When the plan renews' : plan === 'FREE' ? 'Never (one-time credits)' : 'When it is renewed',
    },
    { value: 'MONTHLY', label: 'Every month' },
  ];

  const validate = () => {
    if (!noCost && toolCost !== '' && Number(toolCost) < 0) return 'Cost must be 0 or greater.';
    if (plan === 'CREDIT_CONSUMPTION' && !creditEnabled) return 'A credit pack needs the credit system on.';
    if (creditsOn && !(creditsNumber > 0)) return 'Enter the total credits, or turn the credit system off.';
    if (isSubscription && !renewalDate) return 'Enter the purchase date (or the next renewal date) for this plan.';
    if (showRenewalDate && renewalDate && purchaseDate && renewalDate <= purchaseDate) {
      return 'The renewal date must be after the purchase date.';
    }
    return '';
  };

  const handleSave = async () => {
    const problem = validate();
    if (problem) {
      setError(problem);
      return;
    }

    setSaving(true);
    setError('');
    try {
      const payload = {
        credential_id: row.id,
        scope: 'company',
        renewal_type: plan,
        credit_enabled: creditsOn,
        credit_reset: creditReset,
        auto_renew: isSubscription ? autoRenew : false,
        tool_cost: costNumber,
      };
      if (!notPurchased) payload.purchase_date = purchaseDate || '';
      // A credit pack doesn't use a calendar renewal date -- leave whatever
      // is stored untouched rather than wiping it, in case the admin
      // switches back to a subscription later. (Not purchased is cleared by
      // the backend.)
      if (showRenewalDate) payload.renewal_date = renewalDate || '';
      else if (plan === 'FREE') payload.renewal_date = '';
      await itToolsAPI.upsertCredential(row.toolId, payload);

      // A new rate row starts today, so only write one when the numbers
      // actually changed.
      const creditsChanged = Number(row.totalCredits) !== creditsNumber;
      const costChanged = Number(row.toolCost ?? 0) !== costNumber;
      if (creditsOn && creditsNumber > 0 && (creditsChanged || costChanged || row.costPerCredit == null)) {
        await creditRatesAPI.upsert({
          credentialId: row.id,
          packageCredits: creditsNumber,
          packageRupees: costNumber,
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

  const summary = (() => {
    if (notPurchased) return 'Not purchased — no cost, renewal or credits are tracked.';
    const parts = [isSubscription ? `${PLAN_LABELS[plan]} plan` : PLAN_LABELS[plan]];
    if (!noCost && toolCost !== '') {
      parts.push(isSubscription ? `${formatRupees(costNumber)} per ${PERIOD_TEXT[planMonths]}` : formatRupees(costNumber));
    }
    if (isSubscription && renewalDate) {
      parts.push(`${autoRenew ? 'auto-renews' : 'renew manually by'} ${formatDate(renewalDate)}`);
    } else if (plan === 'MANUAL' && renewalDate) {
      parts.push(`renew by ${formatDate(renewalDate)}`);
    } else if (plan === 'CREDIT_CONSUMPTION') {
      parts.push('renew when the credits run out');
    }
    if (creditsOn && creditsNumber > 0) {
      const resets = plan === 'CREDIT_CONSUMPTION' || (plan === 'FREE' && creditReset === 'CYCLE')
        ? 'no reset'
        : plan === 'MONTHLY' || creditReset === 'MONTHLY' ? 'reset monthly' : 'reset at renewal';
      parts.push(`${formatNumber(creditsNumber)} credits (${resets})`);
    }
    return parts.join(' · ');
  })();

  const hasUsage = row.creditEnabled && row.totalCredits != null && row.remainingCredits != null;

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
            <h4 className="ctam-section-title">Plan</h4>
            <ChipGroup label="Subscription" options={SUBSCRIPTION_PLANS} value={plan} onChange={changePlan} />
            <ChipGroup label="Other" options={OTHER_PLANS} value={plan} onChange={changePlan} />
            {PLAN_HINTS[plan] && <p className="ctam-field-hint">{PLAN_HINTS[plan]}</p>}
          </section>

          {!notPurchased && (
            <section className="ctam-section">
              <h4 className="ctam-section-title">{noCost ? 'Dates' : 'Billing'}</h4>
              <div className="ctam-grid">
                <label className="ctam-field">
                  <span>{purchaseLabel}</span>
                  <input
                    type="date"
                    className="ctam-input"
                    value={purchaseDate}
                    onChange={(e) => changePurchaseDate(e.target.value)}
                  />
                </label>
                {showRenewalDate && (
                  <label className="ctam-field">
                    <span>{isSubscription ? 'Next renewal' : 'Renewal date (optional)'}</span>
                    <input
                      type="date"
                      className="ctam-input"
                      value={renewalDate}
                      onChange={(e) => setRenewalDate(e.target.value)}
                    />
                  </label>
                )}
                {!noCost && (
                  <label className="ctam-field">
                    <span>{costLabel}</span>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="ctam-input"
                      placeholder="e.g. 2000"
                      value={toolCost}
                      onChange={(e) => setToolCost(e.target.value)}
                    />
                  </label>
                )}
              </div>

              {isSubscription && (
                <div className="ctam-toggle-row">
                  <div>
                    <span className="ctam-field-label">Auto renew</span>
                    <p className="ctam-field-hint">
                      {autoRenew
                        ? `Charged automatically: on the renewal date it becomes the new purchase date and the next renewal moves ${planMonths === 1 ? 'one month' : planMonths === 12 ? 'one year' : PERIOD_TEXT[planMonths]} ahead.`
                        : 'Renewed by hand: flagged a week before the renewal date and again once it passes.'}
                    </p>
                  </div>
                  <Switch checked={autoRenew} onChange={setAutoRenew} label="Auto renew" />
                </div>
              )}
            </section>
          )}

          {!notPurchased && (
            <section className="ctam-section">
              <div className="ctam-toggle-row">
                <div>
                  <span className="ctam-field-label">Credit system</span>
                  <p className="ctam-field-hint">Track this account&apos;s credit balance and cost per credit.</p>
                </div>
                <Switch
                  checked={creditEnabled}
                  onChange={setCreditEnabled}
                  label="Enable credit system"
                />
              </div>

              {creditsOn && (
                <>
                  <div className="ctam-grid">
                    <label className="ctam-field">
                      <span>{plan === 'CREDIT_CONSUMPTION' ? 'Credits in the pack' : 'Credits per period'}</span>
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
                      <span>Cost per credit</span>
                      <input
                        type="text"
                        className="ctam-input"
                        readOnly
                        value={costPerCredit == null ? '—' : formatRupees(costPerCredit, 4)}
                      />
                    </label>
                  </div>

                  {showCreditReset && (
                    <ChipGroup label="Credits reset" options={resetOptions} value={creditReset} onChange={setCreditReset} />
                  )}

                  {hasUsage && (
                    <div className="ctam-usage">
                      <div className="ctam-usage-bar" aria-hidden="true">
                        <span style={{ width: `${Math.min(100, (row.usedCredits / row.totalCredits) * 100 || 0)}%` }} />
                      </div>
                      <p className="ctam-field-hint">
                        {formatNumber(row.usedCredits)} used · {formatNumber(row.remainingCredits)} left this period
                        {row.creditPeriodStart ? ` (since ${formatDate(row.creditPeriodStart)})` : ''}
                        {row.creditsResetOn ? ` · resets ${formatDate(row.creditsResetOn)}` : ''}
                      </p>
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <p className="ctam-summary">{summary}</p>
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
