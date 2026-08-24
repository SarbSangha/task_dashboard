import React, { useEffect, useMemo, useState } from 'react';
import { creditRatesAPI, itToolsAPI } from '../../../../services/api';
import './AdminClientsTab.css';
import './AdminToolRenewalsTab.css';

function EmptyState({ message }) {
  return (
    <div className="act-empty">
      <svg className="act-empty-icon" viewBox="0 0 48 48" fill="none" aria-hidden="true">
        <circle cx="24" cy="24" r="20" stroke="currentColor" strokeWidth="1.8" opacity=".25" />
        <path d="M24 14v12l8 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" opacity=".4" />
      </svg>
      <p className="act-empty-text">{message}</p>
    </div>
  );
}

export default function AdminToolRenewalsTab({ search }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [drafts, setDrafts] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [removingId, setRemovingId] = useState(null);

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const [toolsResult, ratesResult] = await Promise.all([
        itToolsAPI.listTools(),
        creditRatesAPI.list().catch(() => null),
      ]);
      const tools = toolsResult?.tools || [];
      const summariesByToolId = toolsResult?.credentialSummariesByToolId || {};
      const rateByCredentialId = new Map(
        (ratesResult?.accounts || []).map((a) => [a.credentialId, a.currentRate]),
      );
      const flat = [];
      for (const tool of tools) {
        const summaries = summariesByToolId[`${tool.id}`] || [];
        for (const summary of summaries) {
          if (summary.scope !== 'company' || !summary.isActive) continue;
          const rate = rateByCredentialId.get(summary.id) || null;
          flat.push({
            id: summary.id,
            toolId: tool.id,
            toolName: tool.name,
            account: summary.loginIdentifierPreview || `Saved login #${summary.id}`,
            assignedCount: Array.isArray(summary.assignedUsers) ? summary.assignedUsers.length : null,
            renewalDate: summary.renewalDate || '',
            packageCredits: rate?.packageCredits != null ? String(rate.packageCredits) : '',
            packageRupees: rate?.packageRupees != null ? String(rate.packageRupees) : '',
            ratePerCredit: rate?.ratePerCredit ?? null,
          });
        }
      }
      flat.sort((a, b) => (a.toolName || '').localeCompare(b.toolName || '') || (a.account || '').localeCompare(b.account || ''));
      setRows(flat);
      setMessage('');
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to load tool accounts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { loadAccounts(); }, []);

  const filtered = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => `${row.toolName} ${row.account}`.toLowerCase().includes(q));
  }, [rows, search]);

  const fieldValue = (row, field) => {
    const draft = drafts[row.id];
    return draft && field in draft ? draft[field] : row[field] || '';
  };
  const isDirty = (row) => {
    const d = drafts[row.id];
    if (!d) return false;
    return (
      ('renewalDate' in d && d.renewalDate !== (row.renewalDate || ''))
      || ('packageCredits' in d && d.packageCredits !== (row.packageCredits || ''))
      || ('packageRupees' in d && d.packageRupees !== (row.packageRupees || ''))
    );
  };

  const setField = (row, field, value) => {
    setDrafts((prev) => ({ ...prev, [row.id]: { ...(prev[row.id] || {}), [field]: value } }));
  };

  const saveRow = async (row) => {
    const renewalDate = fieldValue(row, 'renewalDate');
    const packageCredits = fieldValue(row, 'packageCredits');
    const packageRupees = fieldValue(row, 'packageRupees');

    const wantsRate = packageCredits !== '' || packageRupees !== '';
    if (wantsRate && (Number(packageCredits) <= 0 || packageRupees === '' || Number(packageRupees) < 0)) {
      setMessage('Enter both credits (> 0) and cost (₹, 0 or more) to save a rate.');
      return;
    }

    setSavingId(row.id);
    try {
      await itToolsAPI.upsertCredential(row.toolId, {
        credential_id: row.id,
        scope: 'company',
        renewal_date: renewalDate || '',
      });
      if (wantsRate) {
        await creditRatesAPI.upsert({
          credentialId: row.id,
          packageCredits: Number(packageCredits),
          packageRupees: Number(packageRupees),
        });
      }
      setMessage('');
      await loadAccounts();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to save changes');
    } finally {
      setSavingId(null);
    }
  };

  const removeRow = async (row) => {
    const confirmed = window.confirm(
      `Remove ${row.account} from ${row.toolName}? This also removes any users currently assigned to it and its renewal date / credit rate.`,
    );
    if (!confirmed) return;

    setRemovingId(row.id);
    try {
      await itToolsAPI.deleteCredential(row.toolId, row.id);
      setMessage('');
      await loadAccounts();
      setDrafts((prev) => {
        const next = { ...prev };
        delete next[row.id];
        return next;
      });
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to remove account');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="act-root">
      <p className="art-hint">
        Enter what a credit package cost (e.g. 10000 credits for ₹20000) to convert credit usage into rupee cost on the Consolidated report&apos;s Client Usage and Department detail tables.
      </p>
      {message && <div className="act-message" role="alert">{message}</div>}

      {loading ? (
        <EmptyState message="Loading tool accounts…" />
      ) : filtered.length === 0 ? (
        <EmptyState message={search ? 'No tool accounts match the search.' : 'No shared tool accounts saved yet.'} />
      ) : (
        <div className="act-table-wrap">
          <table className="act-table" aria-label="Tool renewal dates and credit rates">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Account</th>
                <th scope="col">Assigned</th>
                <th scope="col">Renewal date</th>
                <th scope="col">Credits</th>
                <th scope="col">Cost (₹)</th>
                <th scope="col">Rate</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="act-row">
                  <td><span className="act-name">{row.toolName}</span></td>
                  <td>{row.account}</td>
                  <td>
                    {row.assignedCount === null ? (
                      <span className="art-muted">—</span>
                    ) : (
                      <span className={`act-status ${row.assignedCount > 0 ? 'act-status--active' : 'act-status--inactive'}`}>
                        {row.assignedCount} user{row.assignedCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </td>
                  <td>
                    <input
                      type="date"
                      className="art-date-input"
                      value={fieldValue(row, 'renewalDate')}
                      onChange={(e) => setField(row, 'renewalDate', e.target.value)}
                      aria-label={`Renewal date for ${row.toolName} ${row.account}`}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      className="art-number-input"
                      placeholder="e.g. 10000"
                      value={fieldValue(row, 'packageCredits')}
                      onChange={(e) => setField(row, 'packageCredits', e.target.value)}
                      aria-label={`Package credits for ${row.toolName} ${row.account}`}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className="art-number-input"
                      placeholder="e.g. 20000"
                      value={fieldValue(row, 'packageRupees')}
                      onChange={(e) => setField(row, 'packageRupees', e.target.value)}
                      aria-label={`Package cost in rupees for ${row.toolName} ${row.account}`}
                    />
                  </td>
                  <td>
                    <span className="art-muted">
                      {row.ratePerCredit != null ? `₹${row.ratePerCredit}/credit` : '—'}
                    </span>
                  </td>
                  <td>
                    <div className="act-actions">
                      <button
                        type="button"
                        className="act-btn act-btn--approve"
                        onClick={() => saveRow(row)}
                        disabled={!isDirty(row) || savingId === row.id || removingId === row.id}
                      >
                        {savingId === row.id ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        className="act-btn act-btn--reject"
                        onClick={() => removeRow(row)}
                        disabled={savingId === row.id || removingId === row.id}
                      >
                        {removingId === row.id ? 'Removing…' : 'Remove'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
