import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { formatCount, formatMs, formatRelativeTime, getHealthStatusMeta } from './chatgptCaptureUtils';

function DiagnosticGroup({ title, rows }) {
  return (
    <div className="chatgpt-capture-diag-group">
      <span className="chatgpt-capture-diag-group-title">{title}</span>
      <div className="chatgpt-capture-diag-group-rows">
        {rows.map((row) => (
          <div key={row.label} className="chatgpt-capture-diag-row">
            <span className="chatgpt-capture-diag-row-label">{row.label}</span>
            <span className={`chatgpt-capture-diag-row-value${row.tone ? ` tone-${row.tone}` : ''}`}>{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DiagnosticsPanel({ metrics, loading }) {
  if (loading && !metrics) {
    return (
      <div className="chatgpt-capture-panel" aria-hidden="true">
        <SkeletonBlock width={160} height={18} style={{ marginBottom: 12 }} />
        <div className="chatgpt-capture-diag-grid">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="chatgpt-capture-diag-group">
              <SkeletonBlock width="50%" height={11} style={{ marginBottom: 10 }} />
              <SkeletonBlock width="100%" height={14} style={{ marginBottom: 6 }} />
              <SkeletonBlock width="100%" height={14} style={{ marginBottom: 6 }} />
              <SkeletonBlock width="100%" height={14} />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!metrics) return null;

  const queue = metrics.queue || {};
  const ingestStats = metrics.ingestStats || {};
  const extension = metrics.extension || {};
  const backend = metrics.backend || {};
  const healthMeta = getHealthStatusMeta(metrics.captureHealth);
  const breakdown = metrics.installHealthBreakdown || {};

  return (
    <div className="chatgpt-capture-panel chatgpt-capture-diagnostics">
      <div className="chatgpt-capture-panel-head">
        <h4>Diagnostics</h4>
        <span className={`chatgpt-capture-status tone-${healthMeta.tone}`}>{healthMeta.label}</span>
      </div>

      <div className="chatgpt-capture-diag-grid">
        <DiagnosticGroup
          title="Queue"
          rows={[
            { label: 'Queue Size', value: formatCount(queue.queueLengthTotal), tone: queue.queueLengthTotal > 0 ? 'warning' : 'success' },
            { label: 'Pending Uploads', value: formatCount(queue.eventsWaitingTotal), tone: queue.eventsWaitingTotal > 0 ? 'warning' : 'success' },
            { label: 'Retry Count', value: formatCount(queue.maxRetryCount), tone: queue.maxRetryCount > 3 ? 'error' : queue.maxRetryCount > 0 ? 'warning' : 'success' },
            { label: 'Average Upload', value: formatMs(queue.averageUploadTimeMs) },
          ]}
        />
        <DiagnosticGroup
          title="Capture"
          rows={[
            { label: 'Events Today', value: formatCount(metrics.eventsToday) },
            { label: 'Prompts', value: formatCount(metrics.promptsCaptured) },
            { label: 'Responses', value: formatCount(metrics.responsesCaptured) },
            { label: 'Duplicates Prevented', value: formatCount(ingestStats.duplicate), tone: 'info' },
            { label: 'Rejected Events', value: formatCount(ingestStats.rejected), tone: ingestStats.rejected > 0 ? 'warning' : 'success' },
            { label: 'Parse Failures', value: metrics.parseFailures == null ? 'Not instrumented' : formatCount(metrics.parseFailures) },
          ]}
        />
        <DiagnosticGroup
          title="Extension"
          rows={[
            { label: 'Version', value: extension.version || '—' },
            { label: 'Capture Version', value: extension.captureVersion ?? '—' },
            { label: 'Last Heartbeat', value: formatRelativeTime(extension.lastHeartbeatAt) },
          ]}
        />
        <DiagnosticGroup
          title="Backend"
          rows={[
            { label: 'Status', value: backend.status === 'connected' ? 'Connected' : backend.status || '—', tone: 'success' },
            { label: 'Database', value: backend.database === 'healthy' ? 'Healthy' : backend.database || '—', tone: 'success' },
            { label: 'Active Installs', value: formatCount(queue.activeInstalls) },
          ]}
        />
      </div>

      {Object.keys(breakdown).length > 0 && (
        <div className="chatgpt-capture-install-breakdown">
          <span className="chatgpt-capture-field-label">Installs by health status</span>
          <div className="chatgpt-capture-install-breakdown-chips">
            {Object.entries(breakdown).map(([status, count]) => {
              const meta = getHealthStatusMeta(status);
              return (
                <span key={status} className={`chatgpt-capture-badge tone-${meta.tone}`}>
                  {meta.label}: {count}
                </span>
              );
            })}
          </div>
        </div>
      )}

      <p className="chatgpt-capture-inline-note">
        Ingest counters reset on server restart ({ingestStats.windowLabel || 'since last restart'}).
      </p>
    </div>
  );
}
