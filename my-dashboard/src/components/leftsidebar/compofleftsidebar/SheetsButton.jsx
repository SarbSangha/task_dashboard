import './MenuButton.css';

const SheetsButton = ({ isActive, onClick }) => (
  <button
    className={`menu-button${isActive ? ' active' : ''}`}
    onClick={onClick}
    data-label="Sheets"
    aria-label="Sheets"
    aria-current={isActive ? 'page' : undefined}
  >
    <span className="menu-button-icon" aria-hidden="true">
      {/* Document list: registered sheets and their requests */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="2" width="16" height="20" rx="2" />
        <line x1="8" y1="7" x2="16" y2="7" />
        <line x1="8" y1="12" x2="16" y2="12" />
        <line x1="8" y1="17" x2="12" y2="17" />
      </svg>
    </span>
    <span className="menu-button-label">Sheets</span>
  </button>
);

export default SheetsButton;
