import React, { memo } from 'react';
import './WindowControls.css';

const MinimizeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
    <line x1="3" y1="8" x2="13" y2="8" />
  </svg>
);

const MaximizeIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
  </svg>
);

const RestoreIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="4" width="8.5" height="8.5" rx="1" />
    <path d="M4 4V3.5A1.5 1.5 0 0 1 5.5 2H12.5A1.5 1.5 0 0 1 14 3.5V10.5A1.5 1.5 0 0 1 12.5 12H12" />
  </svg>
);

const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true">
    <line x1="3.5" y1="3.5" x2="12.5" y2="12.5" />
    <line x1="12.5" y1="3.5" x2="3.5" y2="12.5" />
  </svg>
);

const WindowControls = memo(({
  isMinimized = false,
  isMaximized = false,
  onMinimize,
  onMaximize,
  onClose,
}) => {
  const handleMinimize = (e) => {
    e.stopPropagation();
    onMinimize?.();
  };

  const handleMaximize = (e) => {
    e.stopPropagation();
    onMaximize?.();
  };

  const handleClose = (e) => {
    e.stopPropagation();
    onClose?.();
  };

  const maximizeLabel = isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize';

  return (
    <div className="wc-root" role="group" aria-label="Window controls">
      {!isMinimized && (
        <button
          type="button"
          className="wc-btn wc-btn--minimize"
          onClick={handleMinimize}
          aria-label="Minimize"
          title="Minimize"
        >
          <MinimizeIcon />
        </button>
      )}

      <button
        type="button"
        className="wc-btn wc-btn--maximize"
        onClick={handleMaximize}
        aria-label={maximizeLabel}
        title={maximizeLabel}
      >
        {isMinimized || isMaximized ? <RestoreIcon /> : <MaximizeIcon />}
      </button>

      <button
        type="button"
        className="wc-btn wc-btn--close"
        onClick={handleClose}
        aria-label="Close"
        title="Close"
      >
        <CloseIcon />
      </button>
    </div>
  );
});

WindowControls.displayName = 'WindowControls';

export default WindowControls;
