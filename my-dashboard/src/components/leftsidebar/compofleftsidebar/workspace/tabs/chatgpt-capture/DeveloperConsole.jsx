import CaptureTimeline from './CaptureTimeline';
import PerformanceCards from './PerformanceCards';
import EventExplorer from './EventExplorer';
import AIAnalysisStatus from './AIAnalysisStatus';
import { formatMs, formatAbsoluteTime, getHealthStatusMeta } from './chatgptCaptureUtils';
import { deriveMetrics, deriveErrors, deriveMediaDiagnostics } from './observabilityHelpers';

const STATUS_ICON = { success: '🟢', warning: '🟡', error: '🔴', muted: '⚪' };

// AI analysis jobs - no backend yet, so every job is an explicit pending
// placeholder (never a fabricated result).
const AI_JOBS = [
  { key: 'prompt-scoring', label: 'Prompt scoring' },
  { key: 'similarity', label: 'Similarity analysis' },
  { key: 'quality', label: 'Output quality scoring' },
  { key: 'golden', label: 'Golden prompt generation' },
];

function AIAnalysisSection() {
  return (
    <div className="cgpt-dev-card">
      <h6 className="cgpt-dev-card-title">AI Analysis</h6>
      <ul className="cgpt-dev-jobs">
        {AI_JOBS.map((job) => (
          <li key={job.key} className="cgpt-dev-job">
            <span className="cgpt-dev-job-label">{job.label}</span>
            <AIAnalysisStatus status="pending" label="Pending" />
          </li>
        ))}
      </ul>
      <p className="cgpt-ai-hint">Jobs run once an analysis backend is connected; results surface in the Intelligence tab.</p>
    </div>
  );
}

function ErrorsSection({ events, media }) {
  const errors = deriveErrors(events, media);
  return (
    <div className="cgpt-dev-card">
      <h6 className="cgpt-dev-card-title">Errors &amp; Warnings</h6>
      {errors.length === 0 ? (
        <div className="cgpt-dev-ok">🟢 No errors detected</div>
      ) : (
        <ul className="cgpt-dev-errors">
          {errors.map((err, i) => (
            <li key={i} className={`cgpt-dev-error tone-${err.tone}`}>
              <span className="cgpt-dev-error-icon">{STATUS_ICON[err.tone] || '⚠'}</span>
              <div className="cgpt-dev-error-body">
                <span className="cgpt-dev-error-label">{err.label}</span>
                <span className="cgpt-dev-error-detail">{err.detail}</span>
              </div>
              {err.timestamp && <span className="cgpt-dev-error-time">{formatAbsoluteTime(err.timestamp)}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MediaDiagnostics({ media }) {
  if (!media || media.length === 0) return null;
  const diag = deriveMediaDiagnostics(media);
  const check = (ok) => (ok ? '✓' : '—');
  return (
    <div className="cgpt-dev-card">
      <h6 className="cgpt-dev-card-title">Media Pipeline Diagnostics</h6>
      <div className="cgpt-diag-row">
        <span className={`cgpt-diag-pill${diag.domDetected ? ' ok' : ''}`}>DOM detection {check(diag.domDetected)}</span>
        <span className={`cgpt-diag-pill${diag.networkDetected ? ' ok' : ''}`}>Network detection {check(diag.networkDetected)}</span>
        <span className={`cgpt-diag-pill${diag.stored ? ' ok' : ''}`}>Storage {check(diag.stored)}</span>
        {diag.avgConfidence != null && <span className="cgpt-diag-pill ok">Assoc. confidence {diag.avgConfidence}%</span>}
      </div>
      <div className="cgpt-diag-assets">
        {diag.assets.map((a) => (
          <div key={a.id} className="cgpt-diag-asset">
            <span className="cgpt-diag-asset-id">#{a.id} · {a.mediaType}</span>
            <span className="cgpt-diag-asset-meta">
              <span>src: {a.source}</span>
              <span className={`cgpt-diag-status tone-${a.status === 'stored' ? 'success' : a.status === 'failed' ? 'error' : 'warning'}`}>{a.status}</span>
              <span>enrich: {a.enrichmentStatus}</span>
              {a.confidence != null && <span>{a.confidence}%</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function DeveloperConsole({ events, media, detail, loading, error }) {
  const metrics = deriveMetrics(events || [], media || []);
  const health = getHealthStatusMeta(detail?.captureHealth);

  return (
    <div className="cgpt-dev-console">
      <div className="cgpt-dev-header">
        <div className="cgpt-dev-header-title">
          <h5>Developer Console</h5>
          <span className="cgpt-dev-subtitle">Capture observability &amp; diagnostics</span>
        </div>
        <div className="cgpt-dev-header-stats">
          <span className={`cgpt-dev-stat status tone-${health.tone}`}>{STATUS_ICON[health.tone] || '⚪'} {health.label}</span>
          <span className="cgpt-dev-stat"><strong>{metrics.eventCount}</strong> events</span>
          {metrics.totalDuration != null && <span className="cgpt-dev-stat"><strong>{formatMs(metrics.totalDuration)}</strong> duration</span>}
          <span className="cgpt-dev-stat"><strong>{detail?.provider === 'chatgpt' ? 'ChatGPT' : (detail?.provider || 'ChatGPT')}</strong></span>
          {detail?.model && <span className="cgpt-dev-stat"><strong>{detail.model}</strong></span>}
        </div>
      </div>

      <div className="cgpt-dev-grid">
        <CaptureTimeline events={events || []} media={media || []} />
        <PerformanceCards events={events || []} media={media || []} />
      </div>

      <ErrorsSection events={events || []} media={media || []} />
      <MediaDiagnostics media={media || []} />
      <AIAnalysisSection />
      <EventExplorer events={events} loading={loading} error={error} />
    </div>
  );
}
