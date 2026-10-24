import './MenuButton.css';

const AiLibraryButton = ({ isActive, onClick }) => (
  <button
    className={`menu-button${isActive ? ' active' : ''}`}
    onClick={onClick}
    data-label="AI Library"
    aria-label="AI Library"
    aria-current={isActive ? 'page' : undefined}
  >
    <span className="menu-button-icon" aria-hidden="true">
      {/* Cloud with an up arrow: files go up to Google Drive */}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 18a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 8.5a4 4 0 0 1-.5 9.5" />
        <polyline points="9 14 12 11 15 14" />
        <line x1="12" y1="11" x2="12" y2="20" />
      </svg>
    </span>
    <span className="menu-button-label">AI Library</span>
  </button>
);

export default AiLibraryButton;
