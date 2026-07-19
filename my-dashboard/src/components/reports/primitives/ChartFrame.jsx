import React from 'react';
import { ResponsiveContainer } from 'recharts';

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

const ChartFrame = ({ title, hint, height = 240, children, actions }) => (
  <div className="rpt-card">
    {(title || actions) && (
      <div className="rpt-card-head">
        <h3 className="rpt-card-title">{title}</h3>
        {actions || (hint && <span className="rpt-card-hint">{hint}</span>)}
      </div>
    )}
    <div className="rpt-chart" style={{ height }}>
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  </div>
);

export default ChartFrame;
