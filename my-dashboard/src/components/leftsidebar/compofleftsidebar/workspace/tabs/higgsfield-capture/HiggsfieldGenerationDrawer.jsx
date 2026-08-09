import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import GenerationDetailPanel from './GenerationDetailPanel';
// Reuses Kling's drawer shell (kling-drawer-*) byte-for-byte, same as
// heygen-capture/HeygenGenerationDrawer.jsx, so the providers' detail views
// read as one system.
import '../../../trending/kling/KlingGenerationDrawer.css';

/**
 * Slide-in overlay for a generation's full detail. Structurally mirrors
 * HeygenGenerationDrawer.jsx/KlingGenerationDrawer.jsx: portal to
 * document.body, mount only while a generation is selected, Escape-to-close.
 */
export default function HiggsfieldGenerationDrawer({ generationId, onClose }) {
  useEffect(() => {
    if (!generationId) return undefined;
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
  }, [generationId, onClose]);

  if (!generationId) return null;

  return createPortal(
    <div className="kling-drawer-overlay" onClick={onClose}>
      <div
        className="kling-drawer-shell"
        role="dialog"
        aria-modal="true"
        aria-label="Generation details"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kling-drawer-header">
          <h3>Generation Details</h3>
          <button type="button" className="kling-drawer-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>
        <div className="kling-drawer-body">
          <GenerationDetailPanel generationId={generationId} />
        </div>
      </div>
    </div>,
    document.body
  );
}
