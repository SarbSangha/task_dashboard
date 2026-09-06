import React, { useEffect, useMemo, useState } from 'react';
import { itToolsAPI } from '../../../../services/api';
import Menu from '../../../ui/Menu';
import ConfigureToolAccountModal from './ConfigureToolAccountModal';
import './AdminClientsTab.css';
import './AdminToolRenewalsTab.css';

const RENEWAL_STATUS_META = {
  ok: { label: 'OK', className: 'act-status--active' },
  renewal_required: { label: 'Renewal Required', className: 'act-status--warning' },
};

const RENEWAL_TYPE_LABELS = {
  MONTHLY: 'Monthly',
  CREDIT_CONSUMPTION: 'Credit consumption',
  MANUAL: 'Manual',
};

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

// "not_applicable" from the backend covers several different reasons -- say
// which one instead of a blanket "Not applicable".
function StatusPill({ row }) {
  if (row.renewalStatus !== 'not_applicable') {
    const meta = RENEWAL_STATUS_META[row.renewalStatus] || RENEWAL_STATUS_META.ok;
    return <span className={`act-status ${meta.className}`}>{meta.label}</span>;
  }
  const label = !row.creditEnabled
    ? 'Not configured'
    : row.renewalType === 'MANUAL'
      ? 'Manual'
      : 'No renewal date';
  return <span className="act-status act-status--inactive">{label}</span>;
}

const formatDate = (value) => {
  if (!value) return '—';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

const formatCredits = (row) => {
  if (!row.creditEnabled) return <span className="art-muted">Not configured</span>;
  if (row.totalCredits == null) return <span className="art-muted">Not set</span>;
  return row.totalCredits.toLocaleString();
};

const formatCost = (row) => {
  if (row.toolCost == null) return <span className="art-muted">Not set</span>;
  return `₹${row.toolCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
};

export default function AdminToolRenewalsTab({ search }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [removingId, setRemovingId] = useState(null);
  const [configuringRow, setConfiguringRow] = useState(null);

  const loadAccounts = async () => {
    setLoading(true);
    try {
      const toolsResult = await itToolsAPI.listTools();
      const tools = toolsResult?.tools || [];
      const summariesByToolId = toolsResult?.credentialSummariesByToolId || {};
      const flat = [];
      for (const tool of tools) {
        const summaries = summariesByToolId[`${tool.id}`] || [];
        for (const summary of summaries) {
          if (summary.scope !== 'company' || !summary.isActive) continue;
          flat.push({
            id: summary.id,
            toolId: tool.id,
            toolName: tool.name,
            account: summary.loginIdentifierPreview || `Saved login #${summary.id}`,
            assignedCount: Array.isArray(summary.assignedUsers) ? summary.assignedUsers.length : null,
            renewalDate: summary.renewalDate || '',
            purchaseDate: summary.purchaseDate || '',
            creditEnabled: Boolean(summary.creditEnabled),
            renewalType: summary.renewalType || 'MANUAL',
            autoRenew: Boolean(summary.autoRenew),
            totalCredits: summary.totalCredits ?? null,
            costPerCredit: summary.costPerCredit ?? null,
            remainingCredits: summary.remainingCredits ?? null,
            renewalStatus: summary.renewalStatus || 'not_applicable',
            toolCost: summary.toolCost ?? null,
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

  const removeRow = async (row) => {
    const confirmed = window.confirm(
      `Remove ${row.account} from ${row.toolName}? This also removes any users currently assigned to it and its renewal/credit configuration.`,
    );
    if (!confirmed) return;

    setRemovingId(row.id);
    try {
      await itToolsAPI.deleteCredential(row.toolId, row.id);
      setMessage('');
      await loadAccounts();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to remove account');
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="act-root">
      <p className="art-hint">
        Not every tool uses credits. Use the ⋮ menu on a row to turn its credit system on or off and pick how it
        renews (monthly auto-renew, credit consumption, or manual) — credit usage still feeds the Consolidated
        report&apos;s Client Usage and Department detail tables automatically.
      </p>
      {message && <div className="act-message" role="alert">{message}</div>}

      {loading ? (
        <EmptyState message="Loading tool accounts…" />
      ) : filtered.length === 0 ? (
        <EmptyState message={search ? 'No tool accounts match the search.' : 'No shared tool accounts saved yet.'} />
      ) : (
        <div className="act-table-wrap">
          <table className="act-table" aria-label="Tool renewal and credit configuration">
            <thead>
              <tr>
                <th scope="col">Tool</th>
                <th scope="col">Account</th>
                <th scope="col">Assigned</th>
                <th scope="col">Purchase date</th>
                <th scope="col">Renewal date</th>
                <th scope="col">Credits</th>
                <th scope="col">Cost</th>
                <th scope="col">Status</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="act-row">
                  <td>
                    <span className="act-name">{row.toolName}</span>
                    <div>
                      <small className="art-muted">{RENEWAL_TYPE_LABELS[row.renewalType] || row.renewalType}{row.renewalType === 'MONTHLY' && row.autoRenew ? ' · Auto' : ''}</small>
                    </div>
                  </td>
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
                  <td>{formatDate(row.purchaseDate)}</td>
                  <td>{row.renewalType === 'CREDIT_CONSUMPTION' ? <span className="art-muted">Based on consumption</span> : formatDate(row.renewalDate)}</td>
                  <td>{formatCredits(row)}</td>
                  <td>{formatCost(row)}</td>
                  <td><StatusPill row={row} /></td>
                  <td>
                    <Menu
                      align="end"
                      menuLabel={`Actions for ${row.toolName} (${row.account})`}
                      items={[
                        { key: 'configure', label: 'Configure…', icon: '⚙️', onSelect: () => setConfiguringRow(row) },
                        { type: 'separator' },
                        {
                          key: 'remove',
                          label: removingId === row.id ? 'Removing…' : 'Remove account',
                          icon: '🗑',
                          variant: 'danger',
                          disabled: removingId === row.id,
                          onSelect: () => removeRow(row),
                        },
                      ]}
                      renderTrigger={(triggerProps) => (
                        <button {...triggerProps} type="button" className="act-btn art-row-menu-btn" aria-label={`Actions for ${row.toolName} account`}>
                          ⋮
                        </button>
                      )}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {configuringRow && (
        <ConfigureToolAccountModal
          key={configuringRow.id}
          row={configuringRow}
          onClose={() => setConfiguringRow(null)}
          onSaved={loadAccounts}
        />
      )}
    </div>
  );
}
