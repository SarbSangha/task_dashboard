import React from 'react';
import { ResponsiveContainer } from 'recharts';
import { questionFor } from '../reportBuilder/blockQuestions';

export const ChartTooltip = ({ active, payload, label, labelFormatter, valueFormatter }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="rpt-chart-tooltip">
      {label != null && <div className="t-label">{labelFormatter ? labelFormatter(label) : label}</div>}
      {payload.map((entry, i) => (
        <div className="t-row" key={i}>
          <span className="t-dot" style={{ background: entry.color || entry.fill }} />
          <span>{entry.name}</span>
          <span className="t-val">{valueFormatter ? valueFormatter(entry.value, entry) : entry.value}</span>
        </div>
      ))}
    </div>
  );
};

// `blockKind` makes the chart self-describing: it pulls the question the chart
// answers from the shared registry, and — when the panel passes onAddToCanvas —
// lets the chart be sent to the Report Builder with that question attached.
const ChartFrame = ({
  title, hint, height = 240, children, actions,
  blockKind, blockProps, question, onAddToCanvas,
}) => {
  const q = question || (blockKind ? questionFor(blockKind) : '');
  const canAdd = !!(onAddToCanvas && blockKind);

  return (
    <div className="rpt-card">
      {(title || actions || canAdd) && (
        <div className="rpt-card-head">
          <h3 className="rpt-card-title">{title}</h3>
          {hint && <span className="rpt-card-hint">{hint}</span>}
          {actions}
          {canAdd && (
            <button
              className="rpt-chart-canvas"
              title={q ? `Add to report — answers: ${q}` : 'Add this chart to the Report Builder'}
              aria-label={`Move ${title} to canvas`}
              onClick={() => onAddToCanvas({ kind: blockKind, ...(blockProps || {}) }, title)}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" />
              </svg>
              Canvas
            </button>
          )}
        </div>
      )}
      {q && <p className="rpt-chart-q">{q}</p>}
      <div className="rpt-chart" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          {children}
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default ChartFrame;
