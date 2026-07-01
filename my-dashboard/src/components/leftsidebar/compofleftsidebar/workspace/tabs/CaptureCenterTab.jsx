import { useEffect, useMemo, useState } from 'react';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { generationRecoveryAPI } from '../../../../../services/api';
import { usePermissions } from '../../../../../hooks/usePermissions';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import './CaptureCenterTab.css';

const AUDIT_PAGE_SIZE = 10;
const PREVIEW_FETCH_LIMIT = 500;
const PREVIEW_PAGE_SIZE = 25;

const EMPTY_AUDIT_PAGINATION = {
  limit: AUDIT_PAGE_SIZE,
  offset: 0,
  total: 0,
};

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeApiError(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }
  if (error?.response?.status === 403) {
    return 'Administrator access is required for the Capture Center.';
  }
  if (error?.message) {
    return error.message;
  }
  return fallback;
}

function formatTimestamp(value) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function formatPercent(value) {
  if (!Number.isFinite(Number(value))) return '0%';
  return `${Number(value).toFixed(2).replace(/\.00$/, '')}%`;
}

function formatCount(value) {
  return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : '0';
}

function buildAuditRate(audit) {
  const explicit = audit?.report?.capture_success_rate;
  if (Number.isFinite(Number(explicit))) {
    return Number(explicit);
  }
  const kling = Number(audit?.kling_count || 0);
  const database = Number(audit?.database_count || 0);
  return kling > 0 ? Number(((database / kling) * 100).toFixed(2)) : 0;
}

function buildMetrics(source) {
  if (!source) {
    return {
      klingCount: 0,
      databaseCount: 0,
      missingCount: 0,
      recoveredCount: 0,
      captureSuccessRate: 0,
    };
  }
  return {
    klingCount: Number(source.kling_count || 0),
    databaseCount: Number(source.database_count || 0),
    missingCount: Number(source.missing_count || 0),
    recoveredCount: Number(source.recovered_count || source.report?.recovered_count || 0),
    captureSuccessRate: Number(
      source.capture_success_rate ?? source.report?.capture_success_rate ?? buildAuditRate(source)
    ) || 0,
  };
}

function buildIdentityLabel(item) {
  return (
    item?.provider_task_id
    || item?.provider_generation_id
    || item?.canonical_asset_key
    || 'Missing identity'
  );
}

function PaginationControls({ pagination, label, onPageChange, loading = false }) {
  const total = Number(pagination?.total || 0);
  const limit = Number(pagination?.limit || AUDIT_PAGE_SIZE) || AUDIT_PAGE_SIZE;
  const offset = Number(pagination?.offset || 0) || 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = total === 0 ? 0 : Math.min(offset + limit, total);
  const canPrev = offset > 0 && !loading;
  const canNext = offset + limit < total && !loading;

  return (
    <div className="capture-center-pagination">
      <span>{label} {start}-{end} of {total}</span>
      <div className="capture-center-pagination-actions">
        <button
          type="button"
          className="capture-center-secondary-btn"
          onClick={() => onPageChange(Math.max(offset - limit, 0))}
          disabled={!canPrev}
        >
          Previous
        </button>
        <button
          type="button"
          className="capture-center-secondary-btn"
          onClick={() => onPageChange(offset + limit)}
          disabled={!canNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export default function CaptureCenterTab() {
  const { isAdmin } = usePermissions();
  const { showConfirm } = useCustomDialogs();
  const [dateMode, setDateMode] = useState('single');
  const [dateFrom, setDateFrom] = useState(getTodayIsoDate());
  const [dateTo, setDateTo] = useState(getTodayIsoDate());
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState('');
  const [previewState, setPreviewState] = useState({
    items: [],
    auditId: null,
    summary: null,
    total: 0,
    loading: false,
    error: '',
  });
  const [previewOffset, setPreviewOffset] = useState(0);
  const [audits, setAudits] = useState([]);
  const [auditsLoading, setAuditsLoading] = useState(true);
  const [auditsError, setAuditsError] = useState('');
  const [auditOffset, setAuditOffset] = useState(0);
  const [auditPagination, setAuditPagination] = useState(EMPTY_AUDIT_PAGINATION);
  const [importState, setImportState] = useState({
    loading: false,
    auditId: null,
    summary: null,
    error: '',
  });
  const [toast, setToast] = useState(null);

  const previewPageItems = useMemo(
    () => previewState.items.slice(previewOffset, previewOffset + PREVIEW_PAGE_SIZE),
    [previewOffset, previewState.items]
  );
  const previewPagination = useMemo(
    () => ({
      limit: PREVIEW_PAGE_SIZE,
      offset: previewOffset,
      total: previewState.items.length,
    }),
    [previewOffset, previewState.items.length]
  );
  const dashboardMetrics = useMemo(
    () => buildMetrics(summary || previewState.summary || audits[0] || null),
    [audits, previewState.summary, summary]
  );
  const previewWindowNote = previewState.total > previewState.items.length
    ? `Showing the first ${formatCount(previewState.items.length)} missing generations from this snapshot to avoid creating duplicate preview audits during paging.`
    : 'Preview results are paginated locally from the latest snapshot so the audit history stays clean.';

  useEffect(() => {
    if (!toast?.message) return undefined;
    const timeoutId = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  const currentDateRange = useMemo(() => {
    const resolvedTo = dateMode === 'range' ? dateTo : dateFrom;
    return {
      date_from: dateFrom,
      date_to: resolvedTo,
    };
  }, [dateFrom, dateMode, dateTo]);

  const fetchAudits = async ({ offset = auditOffset, silent = false } = {}) => {
    if (!silent) {
      setAuditsLoading(true);
    }
    setAuditsError('');
    try {
      const response = await generationRecoveryAPI.listAudits({
        limit: AUDIT_PAGE_SIZE,
        offset,
      });
      setAudits(Array.isArray(response?.data) ? response.data : []);
      setAuditPagination({
        ...EMPTY_AUDIT_PAGINATION,
        ...(response?.pagination || {}),
      });
    } catch (error) {
      console.error('Failed to load generation recovery audits:', error);
      setAuditsError(normalizeApiError(error, 'Could not load recovery audits right now.'));
      if (!silent) {
        setAudits([]);
      }
    } finally {
      if (!silent) {
        setAuditsLoading(false);
      }
    }
  };

  useEffect(() => {
    if (!isAdmin) return;
    void fetchAudits({ offset: auditOffset });
  }, [auditOffset, isAdmin]);

  const handleRunReconcile = async () => {
    setSummaryLoading(true);
    setSummaryError('');
    setImportState((prev) => ({ ...prev, error: '' }));
    try {
      const response = await generationRecoveryAPI.reconcile(currentDateRange);
      setSummary(response?.data || null);
      await fetchAudits({ offset: 0, silent: true });
      setAuditOffset(0);
      setToast({
        kind: 'success',
        message: `Reconciliation complete for ${currentDateRange.date_from}${currentDateRange.date_to !== currentDateRange.date_from ? ` to ${currentDateRange.date_to}` : ''}.`,
      });
    } catch (error) {
      console.error('Failed to run reconciliation:', error);
      setSummaryError(normalizeApiError(error, 'Could not run reconciliation right now.'));
    } finally {
      setSummaryLoading(false);
    }
  };

  const handlePreviewMissing = async () => {
    setPreviewState((prev) => ({
      ...prev,
      loading: true,
      error: '',
    }));
    setPreviewOffset(0);
    setImportState((prev) => ({ ...prev, error: '' }));
    try {
      const response = await generationRecoveryAPI.previewMissing({
        ...currentDateRange,
        limit: PREVIEW_FETCH_LIMIT,
        offset: 0,
      });
      setPreviewState({
        items: Array.isArray(response?.data) ? response.data : [],
        auditId: response?.audit_id ?? null,
        summary: response?.summary || null,
        total: Number(response?.pagination?.total || 0),
        loading: false,
        error: '',
      });
      if (response?.summary) {
        setSummary(response.summary);
      }
      await fetchAudits({ offset: 0, silent: true });
      setAuditOffset(0);
      setToast({
        kind: 'success',
        message: 'Missing-generation preview is ready for review.',
      });
    } catch (error) {
      console.error('Failed to preview missing generations:', error);
      setPreviewState((prev) => ({
        ...prev,
        loading: false,
        error: normalizeApiError(error, 'Could not load the missing-generation preview right now.'),
      }));
    }
  };

  const handleImportAudit = async (audit) => {
    const confirmed = await showConfirm(
      `Import missing generations from audit #${audit.id}? This creates recovered generation records for the snapshot tied to this audit.`,
      {
        title: 'Confirm Recovery Import',
        confirmText: 'Import Snapshot',
        cancelText: 'Cancel',
      }
    );
    if (!confirmed) return;

    setImportState({
      loading: true,
      auditId: audit.id,
      summary: null,
      error: '',
    });
    try {
      const response = await generationRecoveryAPI.importAudit(audit.id);
      setImportState({
        loading: false,
        auditId: audit.id,
        summary: response?.data || null,
        error: '',
      });
      await fetchAudits({ offset: auditOffset, silent: true });
      setToast({
        kind: 'success',
        message: `Import complete for audit #${audit.id}. Imported ${formatCount(response?.data?.imported_count || 0)} and skipped ${formatCount(response?.data?.skipped_count || 0)}.`,
      });
    } catch (error) {
      console.error('Failed to import recovery audit:', error);
      setImportState({
        loading: false,
        auditId: audit.id,
        summary: null,
        error: normalizeApiError(error, 'Could not import this recovery audit right now.'),
      });
      setToast({
        kind: 'error',
        message: normalizeApiError(error, 'Could not import this recovery audit right now.'),
      });
    }
  };

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects capture-center-tab">
        <div className="capture-center-alert">
          Administrator access is required to use the Capture Center.
        </div>
      </div>
    );
  }

  const isInitialLoading = auditsLoading && audits.length === 0;

  return (
    <div className="tab-content tab-content-projects capture-center-tab">
      <div className="capture-center-actions">
        <button
          className="capture-center-primary-btn"
          type="button"
          onClick={() => void handleRunReconcile()}
          disabled={summaryLoading}
        >
          {summaryLoading ? 'Running...' : 'Run Reconciliation'}
        </button>
        <button
          className="capture-center-primary-btn"
          type="button"
          onClick={() => void handlePreviewMissing()}
          disabled={previewState.loading}
        >
          {previewState.loading ? 'Preparing Preview...' : 'Preview Missing'}
        </button>
        <button
          className="capture-center-primary-btn"
          type="button"
          onClick={() => void fetchAudits({ offset: auditOffset })}
          disabled={auditsLoading}
        >
          {auditsLoading ? 'Refreshing...' : 'Refresh Audits'}
        </button>
      </div>

      <div className="capture-center-toolbar">
        <div className="capture-center-date-card">
          <div className="capture-center-date-copy">
            <span className="capture-center-badge">Recovery Window</span>
            <strong>Compare raw Kling capture against normalized generation records.</strong>
            <p>Run reconciliation first, then preview missing candidates, then import from a specific audit snapshot only after review.</p>
          </div>

          <div className="capture-center-date-controls">
            <div className="capture-center-mode-toggle">
              <button
                type="button"
                className={dateMode === 'single' ? 'active' : ''}
                onClick={() => {
                  setDateMode('single');
                  setDateTo(dateFrom);
                }}
              >
                Single Day
              </button>
              <button
                type="button"
                className={dateMode === 'range' ? 'active' : ''}
                onClick={() => setDateMode('range')}
              >
                Date Range
              </button>
            </div>

            <div className="capture-center-date-grid">
              <label>
                <span>Date From</span>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(event) => {
                    setDateFrom(event.target.value);
                    if (dateMode === 'single') {
                      setDateTo(event.target.value);
                    }
                  }}
                />
              </label>
              <label>
                <span>Date To</span>
                <input
                  type="date"
                  value={dateMode === 'single' ? dateFrom : dateTo}
                  onChange={(event) => setDateTo(event.target.value)}
                  disabled={dateMode === 'single'}
                />
              </label>
            </div>
          </div>
        </div>

        {(summaryError || previewState.error || auditsError || importState.error) && (
          <div className="capture-center-alert">
            {summaryError || previewState.error || auditsError || importState.error}
          </div>
        )}
      </div>

      {isInitialLoading ? (
        <WorkspaceSkeleton variant="projects" />
      ) : (
        <div className="capture-center-shell">
          <section className="capture-center-main">
            <div className="capture-center-breadcrumb">
              <span>Workspace</span>
              <span>Capture Center</span>
              <span>Generation Recovery</span>
            </div>

            <div className="capture-center-overview-grid">
              <div className="capture-center-overview-card">
                <div className="capture-center-metric-info">
                  <div className="capture-center-metric-value">{formatCount(dashboardMetrics.klingCount)}</div>
                  <div className="capture-center-metric-label">Kling Count</div>
                </div>
              </div>
              <div className="capture-center-overview-card">
                <div className="capture-center-metric-info">
                  <div className="capture-center-metric-value">{formatCount(dashboardMetrics.databaseCount)}</div>
                  <div className="capture-center-metric-label">Database Count</div>
                </div>
              </div>
              <div className="capture-center-overview-card">
                <div className="capture-center-metric-info">
                  <div className="capture-center-metric-value">{formatCount(dashboardMetrics.missingCount)}</div>
                  <div className="capture-center-metric-label">Missing Count</div>
                </div>
              </div>
              <div className="capture-center-overview-card">
                <div className="capture-center-metric-info">
                  <div className="capture-center-metric-value">{formatCount(dashboardMetrics.recoveredCount)}</div>
                  <div className="capture-center-metric-label">Recovered Count</div>
                </div>
              </div>
              <div className="capture-center-overview-card capture-center-overview-card-accent">
                <div className="capture-center-metric-info">
                  <div className="capture-center-metric-value">{formatPercent(dashboardMetrics.captureSuccessRate)}</div>
                  <div className="capture-center-metric-label">Capture Success Rate</div>
                </div>
              </div>
            </div>

            <div className="capture-center-panel">
              <div className="capture-center-panel-head">
                <div>
                  <span className="capture-center-badge">Read Only Analysis</span>
                  <h4>Reconciliation Snapshot</h4>
                  <p>
                    {summary
                      ? `Latest run covers ${summary.date_from} to ${summary.date_to}.`
                      : 'Run reconciliation to see current recovery counts before importing anything.'}
                  </p>
                </div>
              </div>
              <div className="capture-center-summary-grid">
                <div className="capture-center-summary-card">
                  <div className="capture-center-metric-info">
                    <div className="capture-center-metric-value">{formatCount(summary?.duplicate_source_count || 0)}</div>
                    <div className="capture-center-metric-label">Duplicate Source Rows</div>
                  </div>
                </div>
                <div className="capture-center-summary-card">
                  <div className="capture-center-metric-info">
                    <div className="capture-center-metric-value">{formatCount(summary?.skipped_no_identity || 0)}</div>
                    <div className="capture-center-metric-label">Skipped No Identity</div>
                  </div>
                </div>
                <div className="capture-center-summary-card">
                  <div className="capture-center-metric-info">
                    <div className="capture-center-metric-value">{formatCount(summary?.malformed_count || 0)}</div>
                    <div className="capture-center-metric-label">Malformed Rows</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="capture-center-panel">
              <div className="capture-center-panel-head">
                <div>
                  <span className="capture-center-badge">Missing Preview</span>
                  <h4>Preview Missing Generations</h4>
                  <p>{previewWindowNote}</p>
                </div>
                {previewState.auditId && (
                  <button
                    type="button"
                    className="capture-center-primary-btn capture-center-import-hero"
                    disabled={importState.loading}
                    onClick={() => {
                      const previewAudit = audits.find((audit) => audit.id === previewState.auditId) || {
                        id: previewState.auditId,
                        missing_count: previewState.total,
                      };
                      void handleImportAudit(previewAudit);
                    }}
                  >
                    {importState.loading && importState.auditId === previewState.auditId ? 'Importing...' : `Import Audit #${previewState.auditId}`}
                  </button>
                )}
              </div>

              {previewState.loading && previewState.items.length === 0 ? (
                <WorkspaceSkeleton variant="projects" />
              ) : previewState.items.length === 0 ? (
                <div className="capture-center-empty-state">
                  <strong>No missing generations in the current preview.</strong>
                  <span>Run the preview after choosing a date window to inspect missing recovery candidates.</span>
                </div>
              ) : (
                <>
                  <div className="capture-center-preview-list">
                    {previewPageItems.map((item) => (
                      <article key={`${item.source_usage_event_id}-${item.provider_task_id || item.provider_generation_id || item.canonical_asset_key || 'missing'}`} className="capture-center-preview-card">
                        <div className="capture-center-preview-head">
                          <div>
                            <span className="capture-center-status active">{(item.missing_reason || 'missing').replaceAll('_', ' ')}</span>
                            <h5>{item.prompt || buildIdentityLabel(item)}</h5>
                          </div>
                          <span className="capture-center-preview-date">{formatTimestamp(item.created_at)}</span>
                        </div>
                        <div className="capture-center-preview-meta">
                          <span>Identity {buildIdentityLabel(item)}</span>
                          <span>Usage Event #{item.source_usage_event_id}</span>
                          <span>Confidence {item.confidence || 'unknown'}</span>
                          <span>
                            Owner {item.candidate_owner?.name ? `${item.candidate_owner.name} (#${item.candidate_owner.user_id})` : 'Unknown'}
                          </span>
                        </div>
                      </article>
                    ))}
                  </div>
                  <PaginationControls
                    pagination={previewPagination}
                    label="Preview"
                    loading={previewState.loading}
                    onPageChange={setPreviewOffset}
                  />
                </>
              )}
            </div>
          </section>

          <aside className="capture-center-sidebar">
            <div className="capture-center-panel capture-center-import-panel">
              <div className="capture-center-panel-head">
                <div>
                  <span className="capture-center-badge">Import Summary</span>
                  <h4>Recovery Import</h4>
                  <p>Imports require explicit confirmation and always run from a specific audit snapshot.</p>
                </div>
              </div>

              {importState.loading ? (
                <div className="capture-center-progress">
                  <strong>Import in progress</strong>
                  <span>Processing audit #{importState.auditId}. The audit history will refresh automatically when the import finishes.</span>
                </div>
              ) : importState.summary ? (
                <div className="capture-center-import-summary">
                  <div className="capture-center-import-stat">
                    <span>Imported</span>
                    <strong>{formatCount(importState.summary.imported_count)}</strong>
                  </div>
                  <div className="capture-center-import-stat">
                    <span>Duplicates</span>
                    <strong>{formatCount(importState.summary.duplicate_count)}</strong>
                  </div>
                  <div className="capture-center-import-stat">
                    <span>Skipped</span>
                    <strong>{formatCount(importState.summary.skipped_count)}</strong>
                  </div>
                  <div className="capture-center-import-stat">
                    <span>Invalid Identity</span>
                    <strong>{formatCount(importState.summary.invalid_identity_count)}</strong>
                  </div>
                  <div className="capture-center-import-stat">
                    <span>Malformed</span>
                    <strong>{formatCount(importState.summary.malformed_count)}</strong>
                  </div>
                  <div className="capture-center-import-stat">
                    <span>Completed</span>
                    <strong>{formatTimestamp(importState.summary.completed_at)}</strong>
                  </div>
                </div>
              ) : (
                <div className="capture-center-empty-state compact">
                  <strong>No import run yet</strong>
                  <span>Select an audit below and confirm the import when you are ready.</span>
                </div>
              )}
            </div>

            <div className="capture-center-panel">
              <div className="capture-center-panel-head">
                <div>
                  <span className="capture-center-badge">Audit History</span>
                  <h4>Reconciliation Audits</h4>
                  <p>Every reconciliation and preview creates an immutable snapshot so imports are reproducible and replay-safe.</p>
                </div>
              </div>

              {auditsLoading && audits.length === 0 ? (
                <WorkspaceSkeleton variant="projects" />
              ) : audits.length === 0 ? (
                <div className="capture-center-empty-state compact">
                  <strong>No audits yet</strong>
                  <span>Run reconciliation or missing preview to create the first recovery snapshot.</span>
                </div>
              ) : (
                <>
                  <div className="capture-center-audit-list">
                    {audits.map((audit) => (
                      <article key={audit.id} className="capture-center-audit-card">
                        <div className="capture-center-audit-head">
                          <div>
                            <span className={`capture-center-status ${audit.status === 'completed' ? 'completed' : 'active'}`}>
                              {audit.status || 'unknown'}
                            </span>
                            <h5>Audit #{audit.id}</h5>
                          </div>
                          <span className="capture-center-audit-action">{audit.action || audit.provider || 'reconcile'}</span>
                        </div>

                        <div className="capture-center-audit-grid">
                          <div>
                            <span>Created</span>
                            <strong>{formatTimestamp(audit.created_at)}</strong>
                          </div>
                          <div>
                            <span>Missing</span>
                            <strong>{formatCount(audit.missing_count)}</strong>
                          </div>
                          <div>
                            <span>Imported</span>
                            <strong>{formatCount(audit.imported_count)}</strong>
                          </div>
                          <div>
                            <span>Rate</span>
                            <strong>{formatPercent(buildAuditRate(audit))}</strong>
                          </div>
                        </div>

                        <div className="capture-center-audit-actions">
                          <button
                            type="button"
                            className="capture-center-secondary-btn"
                            disabled={importState.loading || Number(audit.missing_count || 0) === 0}
                            onClick={() => void handleImportAudit(audit)}
                          >
                            {importState.loading && importState.auditId === audit.id ? 'Importing...' : 'Import Snapshot'}
                          </button>
                          {audit.error_message && (
                            <span className="capture-center-inline-note error">{audit.error_message}</span>
                          )}
                          {!audit.error_message && !Array.isArray(audit?.report?.missing_candidates) && Number(audit.missing_count || 0) > 0 && (
                            <span className="capture-center-inline-note">
                              Legacy audit: if import is attempted, the system will ask for a fresh reconciliation snapshot.
                            </span>
                          )}
                        </div>
                      </article>
                    ))}
                  </div>

                  <PaginationControls
                    pagination={auditPagination}
                    label="Audits"
                    loading={auditsLoading}
                    onPageChange={setAuditOffset}
                  />
                </>
              )}
            </div>

            <div className="capture-center-panel capture-center-placeholder">
              <div className="capture-center-panel-head">
                <div>
                  <span className="capture-center-badge">Coming Soon</span>
                  <h4>Unknown Queue</h4>
                  <p>Ownership resolution stays intentionally out of Phase 5B. This placeholder keeps the future workflow visible without enabling claim handling yet.</p>
                </div>
              </div>
              <button type="button" className="capture-center-secondary-btn" disabled>
                Ownership Resolution Coming Soon
              </button>
            </div>
          </aside>
        </div>
      )}

      {toast?.message && (
        <div className={`capture-center-toast ${toast.kind === 'error' ? 'error' : 'success'}`}>
          {toast.kind === 'error' ? '✕' : '✓'} {toast.message}
        </div>
      )}
    </div>
  );
}
