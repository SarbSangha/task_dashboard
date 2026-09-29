import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import DownloadDetailPanel from './DownloadDetailPanel';
import '../../../trending/kling/KlingGenerationDrawer.css';

// Mirrors EnvatoGenerationDrawer.jsx exactly, for downloads instead of
// generations. Takes the whole `download` object rather than an id - see
// DownloadDetailPanel.jsx's header for why no fetch is needed.
export default function EnvatoDownloadDrawer({ download, onClose }) {
  useEffect(() => {
    if (!download) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [download, onClose]);

  if (!download) return null;

  return createPortal(
    <div className="kling-drawer-overlay" onClick={onClose}>
      <div
        className="kling-drawer-shell"
        role="dialog"
        aria-modal="true"
        aria-label="Download details"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kling-drawer-header">
          <h3>Download Details</h3>
          <button type="button" className="kling-drawer-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="kling-drawer-body">
          <DownloadDetailPanel download={download} />
        </div>
      </div>
    </div>,
    document.body
  );
}
