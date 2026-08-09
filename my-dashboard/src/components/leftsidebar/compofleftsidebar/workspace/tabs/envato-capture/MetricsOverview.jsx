import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { formatCount, formatCredits } from './envatoCaptureUtils';

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

function MetricSkeletonGrid({ count = 4 }) {
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
  if (loading && !metrics) return <MetricSkeletonGrid />;

  if (error) {
    return (
      <div className="chatgpt-capture-alert" role="alert">
        {error}
      </div>
    );
  }

  if (!metrics) return null;

  const unknownCount = metrics.unknownOwnershipCount || 0;

  return (
    <div className="chatgpt-capture-metrics-grid">
      <MetricCard icon="✨" tone="primary" label="Generations Captured" value={formatCount(metrics.totalGenerations)} />
      <MetricCard icon="✅" tone="success" label="Attributed to an Employee" value={formatCount(metrics.resolvedOwnershipCount)} />
      <MetricCard
        icon="❔"
        tone={unknownCount > 0 ? 'warning' : 'success'}
        label="Unclaimed (needs review)"
        value={formatCount(unknownCount)}
        hint={unknownCount > 0 ? 'From reconciliation import - no ticket was active at capture time' : undefined}
      />
      <MetricCard
        icon="💳"
        tone="info"
        label="Credit Badge Total (best-effort)"
        value={formatCredits(metrics.creditsChargedTotal)}
        hint="Envato exposes no numeric credit ledger - this sums the DOM-scraped Generate-button badge only"
      />
    </div>
  );
}
