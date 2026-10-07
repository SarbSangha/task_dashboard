import './MenuButton.css';

const SheetActivityButton = ({ isActive, onClick }) => {
  return (
    <button
      className={`menu-button${isActive ? ' active' : ''}`}
      onClick={onClick}
      data-label="Sheet Activity"
      aria-label="Sheet Activity"
      aria-current={isActive ? 'page' : undefined}
    >
      <span className="menu-button-icon" aria-hidden="true">
        {/* Spreadsheet grid with a pencil-edit mark */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="9" y1="9" x2="9" y2="21" />
          <path d="M14 17l3.5-3.5 1.5 1.5L15.5 18.5H14z" />
        </svg>
      </span>
      <span className="menu-button-label">Sheet Activity</span>
    </button>
  );
};

export default SheetActivityButton;
