import React from 'react';

const SectionHeader = ({ title, subtitle, children }) => (
  <div className="rpt-sec-head">
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
      <div>
        <h2 className="rpt-sec-title">{title}</h2>
        {subtitle && <p className="rpt-sec-sub">{subtitle}</p>}
      </div>
      {children}
    </div>
  </div>
);

export default SectionHeader;
