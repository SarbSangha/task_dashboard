import { useEffect, useMemo, useState } from 'react';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { creditReportAPI, downloadBlobResponse } from '../../services/reports';
import './TaskReportPanel.css';
import './CreditReportPanel.css';

/**
 * Credit Consumption Report export (Testing Report section).
 *
 * Only collects the date range and filters - every number is computed by
 * the backend (GET /api/reports/credit/export.xlsx) and lands in a
 * multi-sheet workbook. Visibility is the "credit_report" Section Access
 * grant (Admin Queue -> Section Access); the endpoints enforce it too.
 */

const ALL = 'all';

const pad = (n) => String(n).padStart(2, '0');
const localIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayIso = () => localIso(new Date());
const monthStartIso = () => {
  const d = new Date();
  return localIso(new Date(d.getFullYear(), d.getMonth(), 1));
};

const SHEETS = [
  ['Home', 'Charged and pending credits, quick answers with links, trend chart, sheet index'],
  ['By Department', 'Credits, pending credits, top user and top tool per department'],
  ['By User', 'Credits, ranks, credits per generation, client-tagging rate, top tool and client'],
  ['By Tool', 'Credits, credits per generation, top user and department, cost notes'],
  ['By Client', 'Credits, users, top user and top tool per client'],
  ['Dept × Tool', 'Colour-scaled matrix: which tool each department uses most'],
  ['User × Tool', 'Each user per tool as a filterable table'],
  ['User × Client', 'For which client each user used each tool, sorted by client'],
  ['Monthly Trend', 'Credits and generations by month, per tool and per department'],
  ['Data Quality', 'Unassigned, no client, pending, failed, possible duplicates, zero-credit rows'],
  ['Generation Log', 'Every generation with client, prompt, output link, credits, charge status'],
];

// A blob request's error body is a Blob, not parsed JSON.
const readError = async (err, fallback) => {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try {
      const parsed = JSON.parse(await data.text());
      return parsed?.detail || parsed?.message || fallback;
    } catch {
      return fallback;
    }
  }
  return data?.detail || fallback;
};

export default function CreditReportPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('credit-report-panel', isOpen && isMinimized);

  const [options, setOptions] = useState({ departments: [], users: [], tools: [], clients: [], excludedAccounts: [] });
  const [optionsError, setOptionsError] = useState('');
  const [dateFrom, setDateFrom] = useState(monthStartIso);
  const [dateTo, setDateTo] = useState(todayIso);
  const [department, setDepartment] = useState(ALL);
  const [userId, setUserId] = useState(ALL);
  const [tool, setTool] = useState(ALL);
  const [client, setClient] = useState(ALL);
  const [excludeTestAccounts, setExcludeTestAccounts] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [lastExport, setLastExport] = useState('');

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    setOptionsError('');
    creditReportAPI.options()
      .then((data) => {
        if (cancelled) return;
        setOptions({
          departments: data?.departments || [],
          users: data?.users || [],
          tools: data?.tools || [],
          clients: data?.clients || [],
          excludedAccounts: data?.excludedAccounts || [],
        });
      })
      .catch(async (err) => {
        if (!cancelled) setOptionsError(await readError(err, 'Could not load the filter lists.'));
      });
    return () => { cancelled = true; };
  }, [isOpen]);

  const usersInDepartment = useMemo(() => {
    if (department === ALL) return options.users;
    // Keeps "Unassigned (no owner)" available under the Unassigned department.
    return options.users.filter((u) => u.department === department);
  }, [options.users, department]);

  useEffect(() => {
    if (userId !== ALL && !usersInDepartment.some((u) => String(u.id) === String(userId))) setUserId(ALL);
  }, [usersInDepartment, userId]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    } else {
      setIsMaximized(isMobileViewport());
    }
  }, [isOpen]);

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((prev) => !prev);
  };

  const resetFilters = () => {
    setDateFrom(monthStartIso());
    setDateTo(todayIso());
    setDepartment(ALL);
    setUserId(ALL);
    setTool(ALL);
    setClient(ALL);
    setExcludeTestAccounts(true);
    setError('');
  };

  const exportReport = async () => {
    if (!dateFrom || !dateTo) {
      setError('Pick both a "From" and a "To" date.');
      return;
    }
    if (dateFrom > dateTo) {
      setError('"From" date must be on or before the "To" date.');
      return;
    }
    setExporting(true);
    setError('');
    try {
      const response = await creditReportAPI.exportXlsx({
        start: dateFrom,
        end: dateTo,
        department: department === ALL ? undefined : department,
        user: userId === ALL ? undefined : userId,
        tool: tool === ALL ? undefined : tool,
        client: client === ALL ? undefined : client,
        excludeTestAccounts,
      });
      const fileName = `credit-report_${dateFrom}_to_${dateTo}.xlsx`;
      downloadBlobResponse(response, fileName);
      setLastExport(fileName);
    } catch (err) {
      setError(await readError(err, 'Failed to export the credit report.'));
    } finally {
      setExporting(false);
    }
  };

  const excludedTitle = options.excludedAccounts.length
    ? `Leaves out: ${options.excludedAccounts.map((a) => a.name).join(', ')}`
    : 'Leaves out admin accounts and any configured test accounts';

  if (!isOpen) return null;

  return (
    <>
      <div className={`trp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`trp-panel crp-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Credit Report"
      >
        <div className="trp-header">
          <div className="trp-brand">
            <span className="trp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <line x1="8" y1="17" x2="8" y2="11" /><line x1="12" y1="17" x2="12" y2="7" /><line x1="16" y1="17" x2="16" y2="13" />
              </svg>
            </span>
            <h2 className="trp-title">Credit Consumption Report</h2>
          </div>
          <div className="trp-header-spacer" />
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <div className="trp-body">
            <p className="trp-hint">
              Choose a date range (required) and any filters, then export. The Excel file answers who used which
              tool, for which client, and how many credits it cost. Every sheet links back to Home.
            </p>

            <div className="trp-filters">
              <label className="trp-field">
                <span>From *</span>
                <input type="date" required value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} max={dateTo || undefined} />
              </label>
              <label className="trp-field">
                <span>To *</span>
                <input type="date" required value={dateTo} onChange={(e) => setDateTo(e.target.value)} min={dateFrom || undefined} />
              </label>
              <label className="trp-field">
                <span>Department</span>
                <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                  <option value={ALL}>All Departments</option>
                  {options.departments.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>User</span>
                <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value={ALL}>All Users</option>
                  {usersInDepartment.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>Tool</span>
                <select value={tool} onChange={(e) => setTool(e.target.value)}>
                  <option value={ALL}>All Tools</option>
                  {options.tools.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="trp-field">
                <span>Client</span>
                <select value={client} onChange={(e) => setClient(e.target.value)}>
                  <option value={ALL}>All Clients</option>
                  {options.clients.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
              <label className="crp-check" title={excludedTitle}>
                <input
                  type="checkbox"
                  checked={excludeTestAccounts}
                  onChange={(e) => setExcludeTestAccounts(e.target.checked)}
                />
                <span>Exclude test &amp; admin accounts</span>
              </label>
              <div className="crp-actions">
                <button type="button" className="crp-reset-btn" onClick={resetFilters} disabled={exporting}>
                  Reset
                </button>
                <button type="button" className="trp-generate-btn" onClick={exportReport} disabled={exporting}>
                  {exporting ? 'Building workbook…' : 'Export Report'}
                </button>
              </div>
            </div>

            {optionsError && <div className="trp-error" role="alert">{optionsError}</div>}
            {error && <div className="trp-error" role="alert">{error}</div>}
            {!error && lastExport && <div className="crp-success" role="status">Downloaded {lastExport}</div>}
            {exporting && (
              <div className="trp-truncated-note">Large date ranges can take a minute; the file downloads when it is ready.</div>
            )}

            <div className="crp-sheets">
              <h3>What's in the workbook</h3>
              <ul>
                {SHEETS.map(([name, desc]) => (
                  <li key={name}><strong>{name}</strong><span>{desc}</span></li>
                ))}
              </ul>
              <p className="crp-note">
                Totals count charged generations only; pending and failed ones are listed separately. Generations
                with no owner appear as user and department "Unassigned", and a blank client as "No client".
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
