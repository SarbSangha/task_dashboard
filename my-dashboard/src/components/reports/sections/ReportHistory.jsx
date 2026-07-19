import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { reportsAPI, downloadBlobResponse } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';

const FORMATS = [
  { key: 'pdf', label: 'PDF', capKey: 'pdf' },
  { key: 'xlsx', label: 'Excel', capKey: 'xlsx' },
  { key: 'pptx', label: 'PPT', capKey: 'pptx' },
  { key: 'csv', label: 'CSV', capKey: 'csv' },
  { key: 'html', label: 'HTML', capKey: 'html' },
];

const fmtDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const ReportHistory = () => {
  const [toast, setToast] = useState(null);
  const [busy, setBusy] = useState(null);
  const flash = (m) => { setToast(m); setTimeout(() => setToast(null), 3200); };

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['reports', 'library'],
    queryFn: () => reportsAPI.listReports(),
    staleTime: 30_000,
  });
  const { data: caps } = useQuery({ queryKey: ['reports', 'caps'], queryFn: () => reportsAPI.distributionCapabilities(), staleTime: 300_000 });

  const reports = data?.data || [];
  const formats = caps?.formats || {};

  const doExport = async (id, format) => {
    setBusy(`${id}:${format}`);
    try {
      const res = await reportsAPI.exportSavedReport(id, format);
      downloadBlobResponse(res, `report.${format}`);
    } catch (e) {
      flash(e?.response?.status === 501 ? 'That export engine is not installed on the server.' : 'Export failed');
    } finally { setBusy(null); }
  };

  const remove = async (id, name) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try { await reportsAPI.deleteReport(id); refetch(); } catch { flash('Delete failed'); }
  };

  return (
    <div>
      <SectionHeader
        title="Report History"
        subtitle="Every report saved from the Report Builder — re-download in any available format, or remove it. Access is scoped: you see your own reports; admins see all."
      />

      {isError ? (
        <div className="rpt-error">Failed to load reports: {error?.response?.data?.detail || error?.message}</div>
      ) : isLoading ? (
        <div className="rpt-loading">Loading library…</div>
      ) : reports.length === 0 ? (
        <div className="rpt-empty"><div className="rpt-empty-card">
          <span className="rpt-empty-eyebrow">Empty library</span>
          <h3>No saved reports yet</h3>
          <p>Build a report in the Report Builder and choose <b>Save to library</b> — it will appear here with full export and history.</p>
        </div></div>
      ) : (
        <div className="rpt-table-wrap">
          <table className="rpt-table">
            <thead>
              <tr>
                <th>Report</th><th>Owner</th><th>Created</th><th>Ver</th><th style={{ textAlign: 'right' }}>Export / actions</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td><span className="rpt-pill muted">{r.ownerName || '—'}</span></td>
                  <td>{fmtDate(r.createdAt)}</td>
                  <td className="num">v{r.version}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {FORMATS.map((f) => (
                      <button
                        key={f.key}
                        className="rpt-mini-btn"
                        disabled={formats[f.capKey] === false || busy === `${r.id}:${f.key}`}
                        title={formats[f.capKey] === false ? 'Engine not installed on server' : `Download ${f.label}`}
                        onClick={() => doExport(r.id, f.key)}
                      >
                        {busy === `${r.id}:${f.key}` ? '…' : f.label}
                      </button>
                    ))}
                    <button className="rpt-mini-btn danger" onClick={() => remove(r.id, r.name)} title="Delete">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {caps && !caps.formats?.pdf && (
        <p className="rpt-kpi-prev" style={{ marginTop: 12 }}>
          Server-side PDF is not enabled on this deployment — use the Report Builder’s <b>Generate → Print / Save as PDF</b> for PDF output, or install <code>weasyprint</code> on the server.
        </p>
      )}
      {toast && <div className="rb-toast" style={{ maxWidth: 420 }}>{toast}</div>}
    </div>
  );
};

export default ReportHistory;
