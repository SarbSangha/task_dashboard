import { formatMs, formatCount } from './chatgptCaptureUtils';
import { deriveMetrics } from './observabilityHelpers';

export default function PerformanceCards({ events, media }) {
  const m = deriveMetrics(events, media);
  const cards = [
    { label: 'Response start', value: m.startLatency != null ? formatMs(m.startLatency) : '—', hint: 'prompt → first frame' },
    { label: 'Completion', value: m.completionTime != null ? formatMs(m.completionTime) : '—', hint: 'start → completed' },
    { label: 'Total duration', value: m.totalDuration != null ? formatMs(m.totalDuration) : '—', hint: 'first → last event' },
    { label: 'Events', value: formatCount(m.eventCount), hint: 'captured' },
    { label: 'Media assets', value: formatCount(m.mediaCount), hint: `${m.storedCount} stored` },
  ];

  return (
    <div className="cgpt-dev-card">
      <h6 className="cgpt-dev-card-title">Capture Performance</h6>
      <div className="cgpt-perf-grid">
        {cards.map((c) => (
          <div key={c.label} className="cgpt-perf-card">
            <span className="cgpt-perf-value">{c.value}</span>
            <span className="cgpt-perf-label">{c.label}</span>
            <span className="cgpt-perf-hint">{c.hint}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
