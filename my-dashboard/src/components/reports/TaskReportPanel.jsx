import React, { useEffect, useMemo, useState } from 'react';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { authAPI } from '../../services/api';
import { downloadBlobResponse, reportsAPI } from '../../services/reports';
import './TaskReportPanel.css';

const ALL_DEPARTMENTS = 'all';
const ALL_STATUSES = 'all';
const ALL_USERS = 'all';
const REPORT_ROW_CAP = 500;

// No "Draft" option: the backend always excludes drafts from this report
// (a draft hasn't been raised yet, so it isn't a task to list here).
const STATUS_OPTIONS = [
  { value: ALL_STATUSES, label: 'All Statuses' },
  { value: 'pending', label: 'Pending' },
  { value: 'forwarded', label: 'Forwarded' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'under_review', label: 'Under Review' },
  { value: 'need_improvement', label: 'Needs Improvement' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

const STATUS_LABELS = STATUS_OPTIONS.reduce((acc, opt) => ({ ...acc, [opt.value]: opt.label }), {});

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (days) => {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
};

const formatDateTime = (value, emptyLabel = '—') => {
  if (!value) return emptyLabel;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};

export default function TaskReportPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('task-report-panel', isOpen && isMinimized);

  const [departmentOptions, setDepartmentOptions] = useState([]);
  const [department, setDepartment] = useState(ALL_DEPARTMENTS);
  const [status, setStatus] = useState(ALL_STATUSES);
  const [userOptions, setUserOptions] = useState([]);
  const [userId, setUserId] = useState(ALL_USERS);
  const [dateFrom, setDateFrom] = useState(() => daysAgoIso(29));
  const [dateTo, setDateTo] = useState(() => todayIso());

  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [hasGenerated, setHasGenerated] = useState(false);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    authAPI.getDepartments()
      .then((response) => {
        if (cancelled) return;
        const departments = Array.isArray(response?.departments) ? response.departments : [];
        setDepartmentOptions(departments);
      })
      .catch(() => {});
    authAPI.getAdminAllUsers()
      .then((response) => {
        if (cancelled) return;
        const users = (Array.isArray(response?.users) ? response.users : [])
          .filter((u) => !u.isDeleted)
          .sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''));
        setUserOptions(users);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  // Keep the User list in sync with the selected Department -- picking a
  // department should only offer the people actually in it, not the whole
  // company roster.
  const filteredUserOptions = useMemo(() => {
    if (department === ALL_DEPARTMENTS) return userOptions;
    const normalizedDepartment = department.trim().toLowerCase();
    return userOptions.filter((u) => (u.department || '').trim().toLowerCase() === normalizedDepartment);
  }, [userOptions, department]);

  // If the department changes out from under the currently selected user
  // (or the list just loaded), drop a now-invalid selection back to "all".
  useEffect(() => {
    if (userId === ALL_USERS) return;
    if (!filteredUserOptions.some((u) => String(u.id) === String(userId))) {
      setUserId(ALL_USERS);
    }
  }, [filteredUserOptions, userId]);

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

  // Shared by the on-screen preview (capped, paginated) and the Excel export
  // (uncapped on the backend) so they always agree on which tasks match.
  const buildFilterParams = () => ({
    start: dateFrom || undefined,
    end: dateTo || undefined,
    department: department === ALL_DEPARTMENTS ? undefined : department,
    status: status === ALL_STATUSES ? undefined : status,
    user_id: userId === ALL_USERS ? undefined : userId,
  });

  const generateReport = async () => {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setError('"From" date must be on or before the "To" date.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const response = await reportsAPI.tasksDetail({ ...buildFilterParams(), limit: REPORT_ROW_CAP });
      setResult(response);
      setHasGenerated(true);
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to generate the task report.');
    } finally {
      setLoading(false);
    }
  };

  const exportReport = async () => {
    setExporting(true);
    setError('');
    try {
      const response = await reportsAPI.tasksDetailXlsx(buildFilterParams());
      downloadBlobResponse(response, 'Task-Report.xlsx');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to export the task report.');
    } finally {
      setExporting(false);
    }
  };

  if (!isOpen) return null;

  const tasks = result?.tasks || [];

  return (
    <>
      <div className={`trp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`trp-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Task Report"
      >
        <div className="trp-header">
          <div className="trp-brand">
            <span className="trp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l2 2 4-4" /><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="7" y1="16" x2="13" y2="16" />
              </svg>
            </span>
            <h2 className="trp-title">Task Report</h2>
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
              Pick a department, date range, and optionally a user, then generate a report listing every task raised
              in that window.
            </p>

            <div className="trp-filters">
              <label className="trp-field">
                <span>Department</span>
                <select value={department} onChange={(e) => setDepartment(e.target.value)}>
                  <option value={ALL_DEPARTMENTS}>All Departments</option>
                  {departmentOptions.map((dept) => (
                    <option key={dept} value={dept}>{dept}</option>
                  ))}
                </select>
              </label>
              <label className="trp-field">
                <span>From</span>
                <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} max={dateTo || undefined} />
              </label>
              <label className="trp-field">
                <span>To</span>
                <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} min={dateFrom || undefined} />
              </label>
              <label className="trp-field">
                <span>Status</span>
                <select value={status} onChange={(e) => setStatus(e.target.value)}>
                  {STATUS_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </label>
              <label className="trp-field">
                <span>User</span>
                <select value={userId} onChange={(e) => setUserId(e.target.value)}>
                  <option value={ALL_USERS}>All Users</option>
                  {filteredUserOptions.map((u) => (
                    <option key={u.id} value={u.id}>{u.name || u.email}</option>
                  ))}
                </select>
              </label>
              <button type="button" className="trp-generate-btn" onClick={generateReport} disabled={loading}>
                {loading ? 'Generating…' : 'Generate Report'}
              </button>
            </div>

            {error && <div className="trp-error" role="alert">{error}</div>}

            {!error && hasGenerated && result && (
              <>
                <div className="trp-summary">
                  <span><strong>{result.department}</strong></span>
                  {userId !== ALL_USERS && (
                    <span>Assignee: <strong>{filteredUserOptions.find((u) => String(u.id) === String(userId))?.name || 'Selected user'}</strong></span>
                  )}
                  <span>{result.period?.start} → {result.period?.end}</span>
                  <span>{result.total} task{result.total === 1 ? '' : 's'}</span>
                  <button type="button" className="trp-export-btn" onClick={exportReport} disabled={exporting || result.total === 0}>
                    {exporting ? 'Exporting…' : 'Export Excel'}
                  </button>
                </div>

                {result.total > result.count && (
                  <div className="trp-truncated-note">
                    Showing the first {result.count.toLocaleString()} of {result.total.toLocaleString()} matching tasks — narrow the department or date range to see the rest.
                  </div>
                )}

                {tasks.length === 0 ? (
                  <div className="trp-empty">No tasks match this department and date range.</div>
                ) : (
                  <div className="trp-table-wrap">
                    <table className="trp-table">
                      <thead>
                        <tr>
                          <th>Task</th>
                          <th>Project</th>
                          <th>From Dept</th>
                          <th>To Dept</th>
                          <th>Priority</th>
                          <th>Status</th>
                          <th>Created By</th>
                          <th>Assignees</th>
                          <th>Created At</th>
                          <th>Deadline</th>
                          <th>Completed At</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tasks.map((t) => (
                          <tr key={t.id}>
                            <td className="trp-title-cell" title={t.title}>{t.title}</td>
                            <td className="trp-title-cell" title={t.projectName}>{t.projectName || '—'}</td>
                            <td>{t.fromDepartment || '—'}</td>
                            <td>{t.toDepartment || '—'}</td>
                            <td className="trp-capitalize">{t.priority || '—'}</td>
                            <td>
                              <span className={`trp-status-pill trp-status-${t.status || 'unknown'}`}>
                                {STATUS_LABELS[t.status] || t.status || 'Unknown'}
                              </span>
                            </td>
                            <td>{t.createdBy || '—'}</td>
                            <td>{(t.assignees || []).join(', ') || '—'}</td>
                            <td>{formatDateTime(t.createdAt)}</td>
                            <td>{formatDateTime(t.deadline, 'Not set')}</td>
                            <td>{formatDateTime(t.completedAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}

            {!hasGenerated && !error && (
              <div className="trp-empty">Set your filters above and click "Generate Report" to see task details.</div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
