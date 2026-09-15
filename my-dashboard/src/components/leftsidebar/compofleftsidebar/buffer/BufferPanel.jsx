import React, { useState } from 'react';
import WindowControls from '../../../common/WindowControls';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import BufferExplorerBody from '../workspace/tabs/buffer-capture/BufferExplorerBody';
import './BufferPanel.css';

/**
 * Buffer - a standalone sidebar entry (not a tab inside RMW Data), same
 * window-chrome pattern as TaskReportPanel/AdminRequestPanel: overlay,
 * minimize-to-taskbar via useMinimizedWindowStack, maximize, close. The
 * actual cross-tool feed lives in BufferExplorerBody (shared with the tab
 * this replaced inside TrendingsPanel, before Buffer was promoted to its own
 * sidebar item) - this component is just the window it now lives in.
 */
export default function BufferPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('buffer-panel', isOpen && isMinimized);
  const [searchInput, setSearchInput] = useState('');

  React.useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  React.useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    } else {
      setIsMaximized(isMobileViewport());
    }
  }, [isOpen]);

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((prev) => !prev);
  };

  if (!isOpen) return null;

  return (
    <>
      <div className={`bfp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`bfp-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Buffer"
      >
        <div className="bfp-header">
          <div className="bfp-brand">
            <span className="bfp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 8l-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" />
              </svg>
            </span>
            <h2 className="bfp-title">Buffer</h2>
          </div>
          {!isMinimized && (
            <input
              className="bfp-search"
              placeholder="Search titles..."
              aria-label="Search the Buffer feed by title"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
            />
          )}
          <div className="bfp-header-spacer" />
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <div className="bfp-body">
            <BufferExplorerBody searchInput={searchInput} />
          </div>
        )}
      </div>
    </>
  );
}
