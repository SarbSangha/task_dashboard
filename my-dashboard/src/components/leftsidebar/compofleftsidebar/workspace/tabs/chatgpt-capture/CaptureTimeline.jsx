import { formatMs } from './chatgptCaptureUtils';
import { derivePipeline } from './observabilityHelpers';

function clockTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(d);
}

export default function CaptureTimeline({ events, media }) {
  const stages = derivePipeline(events, media);
  if (!stages.length) return null;

  return (
    <div className="cgpt-dev-card">
      <h6 className="cgpt-dev-card-title">Capture Pipeline</h6>
      <ol className="cgpt-pipeline">
        {stages.map((stage, i) => (
          <li key={stage.key} className={`cgpt-pipeline-step${stage.done ? ' done' : ' pending'}`}>
            <span className="cgpt-pipeline-node" aria-hidden="true">{stage.done ? '🟢' : '⚪'}</span>
            {i < stages.length - 1 && <span className="cgpt-pipeline-line" aria-hidden="true" />}
            <div className="cgpt-pipeline-body">
              <span className="cgpt-pipeline-label">{stage.label}</span>
              <span className="cgpt-pipeline-meta">
                <span>{stage.done ? 'Completed' : 'Not reached'}</span>
                {stage.done && <span className="cgpt-pipeline-time">{clockTime(stage.at)}</span>}
                {stage.durationMs != null && <span className="cgpt-pipeline-dur">+{formatMs(stage.durationMs)}</span>}
              </span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
