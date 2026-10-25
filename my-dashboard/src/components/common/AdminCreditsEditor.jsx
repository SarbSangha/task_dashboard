import { useEffect, useState } from 'react';
import '../leftsidebar/compofleftsidebar/trending/kling/KlingGenerationDrawer.css';

// Credits row of a card's Admin section (AdminCardActions.jsx, and Kling's
// drawer): enter / edit the card's credits, or reset them to what capture
// recorded. The saved value goes into the column the credit reports read and
// is held there against later capture writes (backend
// utils/admin_card_credits.py).

function formatCredits(value) {
  return value === null || value === undefined || value === '' ? 'none' : `${value}`;
}

function apiErrorMessage(error, fallback) {
  const detail = error?.response?.data?.detail;
  return typeof detail === 'string' ? detail : fallback;
}

export default function AdminCreditsEditor({ currentCredits, adminCredits, whole = false, max, onSave, onReset }) {
  const shown = adminCredits?.value ?? currentCredits;
  const [draft, setDraft] = useState(shown ?? '');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    setDraft(shown ?? '');
  }, [shown]);

  const handleSave = async (event) => {
    event.preventDefault();
    const text = `${draft}`.trim();
    const value = Number(text);
    if (!text || !Number.isFinite(value) || value < 0) {
      setError('Enter the credits as a number of 0 or more.');
      return;
    }
    if (whole && !Number.isInteger(value)) {
      setError('Credits for this tool are whole numbers.');
      return;
    }
    if (max !== undefined && value > max) {
      setError(`Credits can't be more than ${max}.`);
      return;
    }
    setPending('save');
    setError('');
    try {
      await onSave(value);
    } catch (saveError) {
      setError(apiErrorMessage(saveError, 'Could not save the credits.'));
    } finally {
      setPending('');
    }
  };

  const handleReset = async () => {
    if (!window.confirm(`Reset the credits to the captured value (${formatCredits(adminCredits?.capturedValue)})?`)) return;
    setPending('reset');
    setError('');
    try {
      await onReset();
    } catch (resetError) {
      setError(apiErrorMessage(resetError, 'Could not reset the credits.'));
    } finally {
      setPending('');
    }
  };

  const unchanged = `${draft}`.trim() === `${shown ?? ''}`;

  return (
    <div>
      <form className="kling-drawer-collection-row" onSubmit={handleSave}>
        <input
          type="number"
          className="kling-tag-input-field"
          min="0"
          max={max}
          step={whole ? 1 : 'any'}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Credits"
          aria-label="Credits"
          disabled={Boolean(pending)}
        />
        <button type="submit" className="kling-drawer-action-btn" disabled={Boolean(pending) || unchanged}>
          {pending === 'save' ? 'Saving...' : 'Save Credits'}
        </button>
        {adminCredits && (
          <button type="button" className="kling-drawer-action-btn" onClick={handleReset} disabled={Boolean(pending)}>
            {pending === 'reset' ? 'Resetting...' : 'Reset'}
          </button>
        )}
      </form>
      <p className="kling-drawer-inline-note">
        {adminCredits
          ? `Admin-entered credits. Captured value: ${formatCredits(adminCredits.capturedValue)}.`
          : `Captured credits: ${formatCredits(currentCredits)}.`}
      </p>
      {error && <p className="kling-drawer-inline-error">{error}</p>}
    </div>
  );
}
