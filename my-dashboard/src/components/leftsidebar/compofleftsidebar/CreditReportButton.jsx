import './MenuButton.css';

const CreditReportButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Credit Report"
      aria-label="Credit Report"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Bar-chart-in-a-sheet metaphor */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="8" y1="17" x2="8" y2="11" />
          <line x1="12" y1="17" x2="12" y2="7" />
          <line x1="16" y1="17" x2="16" y2="13" />
        </svg>
      </span>
      <span className="menu-button-label">Credit Report</span>
    </button>
  );
};

export default CreditReportButton;
