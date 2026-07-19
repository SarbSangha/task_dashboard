import React from 'react';

const InsightBanner = ({ children, recommendation }) => (
  <div className="rpt-insight" role="note">
    <span className="rpt-insight-mark" aria-hidden="true">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a7 7 0 0 0-4 12.7V17a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1v-2.3A7 7 0 0 0 12 2Z" />
        <line x1="9" y1="21" x2="15" y2="21" />
      </svg>
    </span>
    <div className="rpt-insight-body">
      <p className="rpt-insight-title">
        AI Insight
        <span style={{ fontSize: 9, letterSpacing: '.05em', color: 'var(--color-text-muted)', background: 'var(--color-secondary)', padding: '1px 5px', borderRadius: 4 }}>AUTO-GENERATED</span>
      </p>
      <p className="rpt-insight-text">{children}</p>
      {recommendation && (
        <div className="rpt-insight-rec"><b>Recommendation:</b> {recommendation}</div>
      )}
    </div>
  </div>
);

export default InsightBanner;
