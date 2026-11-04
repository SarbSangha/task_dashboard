import React, { useEffect, useMemo, useState } from 'react';
import { itToolsAPI } from '../../../../services/api';
import Menu from '../../../ui/Menu';
import ConfigureToolAccountModal from './ConfigureToolAccountModal';
import {
  ATTENTION_STATUSES,
  PERIOD_TEXT,
  PLAN_LABELS,
  PLAN_PERIOD_MONTHS,
  formatDate,
  formatNumber,
  relativeDays,
} from './toolPlans';
import './AdminClientsTab.css';
import './AdminToolRenewalsTab.css';

const FILTERS = [
  { key: 'all', label: 'All', match: () => true },
  { key: 'attention', label: 'Needs attention', match: (row) => ATTENTION_STATUSES.has(row.renewalStatus) },
  { key: 'not_purchased', label: 'Not purchased', match: (row) => row.renewalType === 'NOT_PURCHASED' },
  { key: 'free', label: 'Free', match: (row) => row.renewalType === 'FREE' },
];

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

// Status from backend utils/tool_renewal_service.calculate_renewal_status,
// worded with the days left where that's what matters.
function StatusPill({ row }) {
  const days = row.daysToRenewal;
  const meta = {
    ok: ['OK', 'active'],
    free: ['Free', 'active'],
    not_purchased: ['Not purchased', 'inactive'],
    renews_soon: [days === 0 ? 'Renews today' : `Renews in ${days}d`, 'info'],
    due_soon: [days === 0 ? 'Due today' : `Due in ${days}d`, 'warning'],
    renewal_required: [days != null ? `Overdue ${-days}d` : 'Renewal overdue', 'danger'],
    credits_low: ['Credits low', 'warning'],
    credits_exhausted: ['Credits used up', 'danger'],
    needs_setup: ['Needs setup', 'warning'],
    not_applicable: ['No renewal date', 'inactive'],
  }[row.renewalStatus] || ['—', 'inactive'];
  return <span className={`act-status act-status--${meta[1]}`}>{meta[0]}</span>;
}

function PlanCell({ row }) {
  const auto = PLAN_PERIOD_MONTHS[row.renewalType] && row.autoRenew;
  return (
    <>
      <span className="act-name">{row.toolName}</span>
      <div><small className="art-muted">{PLAN_LABELS[row.renewalType] || row.renewalType}{auto ? ' · Auto-renew' : ''}</small></div>
    </>
  );
}

function RenewalCell({ row }) {
  if (row.renewalType === 'NOT_PURCHASED' || row.renewalType === 'FREE') return <span className="art-muted">—</span>;
  if (row.renewalType === 'CREDIT_CONSUMPTION') return <span className="art-muted">When credits run out</span>;
  if (!row.renewalDate) return <span className="art-muted">Not set</span>;
  return (
    <>
      {formatDate(row.renewalDate)}
      <div><small className="art-muted">{relativeDays(row.daysToRenewal)}</small></div>
    </>
  );
}

function CreditsCell({ row }) {
  if (row.renewalType === 'NOT_PURCHASED' || !row.creditEnabled) return <span className="art-muted">Off</span>;
  if (row.totalCredits == null) return <span className="art-muted">Not set</span>;
  const left = row.remainingCredits ?? row.totalCredits;
  const share = row.totalCredits > 0 ? Math.max(0, Math.min(1, left / row.totalCredits)) : 0;
  const tone = share <= 0 ? 'empty' : share <= 0.1 ? 'low' : 'ok';
  return (
    <div className="art-credits">
      <span>{formatNumber(left)} <small className="art-muted">/ {formatNumber(row.totalCredits)}</small></span>
      <div className={`art-credit-bar art-credit-bar--${tone}`} aria-hidden="true"><span style={{ width: `${share * 100}%` }} /></div>
      {row.creditsResetOn && <small className="art-muted">resets {formatDate(row.creditsResetOn)}</small>}
    </div>
  );
}

function CostCell({ row }) {
  if (row.renewalType === 'NOT_PURCHASED') return <span className="art-muted">—</span>;
  if (row.renewalType === 'FREE') return <span className="art-muted">Free</span>;
  if (row.toolCost == null) return <span className="art-muted">Not set</span>;
  const months = PLAN_PERIOD_MONTHS[row.renewalType];
  const per = months ? `per ${PERIOD_TEXT[months]}` : row.renewalType === 'CREDIT_CONSUMPTION' ? 'per pack' : '';
  return (
    <>
      ₹{row.toolCost.toLocaleString(undefined, { maximumFractionDigits: 2 })}
      {per && <div><small className="art-muted">{per}</small></div>}
    </>
  );
}

export default function AdminToolRenewalsTab({ search }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [removingId, setRemovingId] = useState(null);
  const [configuringRow, setConfiguringRow] = useState(null);
  const [filterKey, setFilterKey] = useState('all');

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
            creditReset: summary.creditReset || 'CYCLE',
            totalCredits: summary.totalCredits ?? null,
            costPerCredit: summary.costPerCredit ?? null,
            remainingCredits: summary.remainingCredits ?? null,
            usedCredits: summary.usedCredits ?? null,
            creditPeriodStart: summary.creditPeriodStart || '',
            creditsResetOn: summary.creditsResetOn || '',
            renewalStatus: summary.renewalStatus || 'not_applicable',
            daysToRenewal: summary.daysToRenewal ?? null,
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

  const searched = useMemo(() => {
    const q = (search || '').trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) => `${row.toolName} ${row.account}`.toLowerCase().includes(q));
  }, [rows, search]);

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((f) => [f.key, searched.filter(f.match).length])),
    [searched],
  );
  const activeFilter = FILTERS.find((f) => f.key === filterKey) || FILTERS[0];
  const filtered = useMemo(() => searched.filter(activeFilter.match), [searched, activeFilter]);

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
        Use the ⋮ menu on a row to set its plan (monthly, quarterly, half-yearly or yearly subscription, credit pack,
        custom dates, free, or not purchased), whether it auto-renews, and its credits. Renewals are flagged a week
        ahead; credit usage still feeds the Consolidated report&apos;s Client Usage and Department tables.
      </p>
      {message && <div className="act-message" role="alert">{message}</div>}

      {!loading && rows.length > 0 && (
        <div className="art-filters" role="tablist" aria-label="Filter tool accounts">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={filterKey === f.key}
              className={`art-filter${filterKey === f.key ? ' is-active' : ''}${f.key === 'attention' && counts.attention ? ' has-alert' : ''}`}
              onClick={() => setFilterKey(f.key)}
            >
              {f.label} <span className="art-filter-count">{counts[f.key]}</span>
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <EmptyState message="Loading tool accounts…" />
      ) : filtered.length === 0 ? (
        <EmptyState
          message={search ? 'No tool accounts match the search.'
            : rows.length ? `No accounts under “${activeFilter.label}”.` : 'No shared tool accounts saved yet.'}
        />
      ) : (
        <div className="act-table-wrap">
          <table className="act-table" aria-label="Tool renewal and credit configuration">
            <thead>
              <tr>
                <th scope="col">Tool / plan</th>
                <th scope="col">Account</th>
                <th scope="col">Assigned</th>
                <th scope="col">Purchase date</th>
                <th scope="col">Renewal date</th>
                <th scope="col">Credits left</th>
                <th scope="col">Cost</th>
                <th scope="col">Status</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => (
                <tr key={row.id} className="act-row">
                  <td><PlanCell row={row} /></td>
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
                  <td>{row.purchaseDate && row.renewalType !== 'NOT_PURCHASED' ? formatDate(row.purchaseDate) : <span className="art-muted">—</span>}</td>
                  <td><RenewalCell row={row} /></td>
                  <td><CreditsCell row={row} /></td>
                  <td><CostCell row={row} /></td>
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
