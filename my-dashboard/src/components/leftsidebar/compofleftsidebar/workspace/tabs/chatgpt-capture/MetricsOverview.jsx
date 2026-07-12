import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { formatCount, formatPercent, getHealthStatusMeta } from './chatgptCaptureUtils';

function MetricCard({ icon, label, value, tone = 'muted', hint }) {
  return (
    <div className={`chatgpt-capture-metric-card tone-${tone}`}>
      <div className="chatgpt-capture-metric-card-top">
        <span className="chatgpt-capture-metric-icon" aria-hidden="true">{icon}</span>
        <span className={`chatgpt-capture-status-dot tone-${tone}`} aria-hidden="true" />
      </div>
      <div className="chatgpt-capture-metric-value">{value}</div>
      <div className="chatgpt-capture-metric-label">{label}</div>
      {hint && <div className="chatgpt-capture-metric-hint">{hint}</div>}
    </div>
  );
}

function MetricSkeletonGrid({ count = 9 }) {
  return (
    <div className="chatgpt-capture-metrics-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="chatgpt-capture-metric-card">
          <SkeletonBlock width={28} height={28} rounded />
          <SkeletonBlock width="60%" height={26} style={{ marginTop: 10 }} />
          <SkeletonBlock width="80%" height={12} style={{ marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

export default function MetricsOverview({ metrics, loading, error }) {
  if (loading && !metrics) {
    return <MetricSkeletonGrid />;
  }

  if (error) {
    return (
      <div className="chatgpt-capture-alert" role="alert">
        {error}
      </div>
    );
  }

  if (!metrics) return null;

  const ingestStats = metrics.ingestStats || {};
  const healthMeta = getHealthStatusMeta(metrics.captureHealth);

  return (
    <div className="chatgpt-capture-metrics-grid">
      <MetricCard icon="👤" tone="primary" label="Users" value={formatCount(metrics.usersCaptured)} />
      <MetricCard icon="💭" tone="primary" label="Conversations" value={formatCount(metrics.conversationsCaptured)} />
      <MetricCard icon="🗨️" tone="info" label="Messages" value={formatCount(metrics.messagesCaptured)} />
      <MetricCard icon="💬" tone="info" label="Prompts" value={formatCount(metrics.promptsCaptured)} />
      <MetricCard icon="🤖" tone="info" label="Responses" value={formatCount(metrics.responsesCaptured)} />
      <MetricCard icon="🖼️" tone="muted" label="Images" value={formatCount(metrics.imagesCaptured)} />
      <MetricCard icon="📄" tone="muted" label="Files" value={formatCount(metrics.filesCaptured)} />
      <MetricCard
        icon="✅"
        tone={ingestStats.successRatePercent == null ? 'muted' : ingestStats.successRatePercent >= 95 ? 'success' : 'warning'}
        label="Capture Success"
        value={ingestStats.successRatePercent == null ? '—' : formatPercent(ingestStats.successRatePercent)}
        hint={ingestStats.windowLabel}
      />
      <MetricCard
        icon={healthMeta.tone === 'success' ? '🟢' : healthMeta.tone === 'error' ? '🔴' : '🟡'}
        tone={healthMeta.tone}
        label="Capture Health"
        value={healthMeta.label}
      />
    </div>
  );
}
