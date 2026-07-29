import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import GenerationDetailPanel from './GenerationDetailPanel';
// Reuses Kling's drawer shell (kling-drawer-*) byte-for-byte instead of the
// chatgpt-capture-drawer* classes DeveloperToolsDrawer.jsx still uses, per
// the "make this look like the Kling sidebar" ask - same slide-in panel,
// header, action-pill row and section rhythm as KlingGenerationDrawer.jsx,
// so the two providers' detail views read as one system.
import '../../../trending/kling/KlingGenerationDrawer.css';

/**
 * Slide-in overlay for a generation's full detail. Structurally mirrors
 * KlingGenerationDrawer.jsx: portal to document.body, mount only while a
 * generation is selected (rather than always-mounted + open/close via CSS
 * transform), Escape-to-close, and the same fade/slide-in entrance.
 */
export default function FreepikGenerationDrawer({ generationId, onClose }) {
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
