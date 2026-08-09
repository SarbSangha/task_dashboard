import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import GenerationDetailPanel from './GenerationDetailPanel';
import '../../../trending/kling/KlingGenerationDrawer.css';

// Mirrors freepik-capture/FreepikGenerationDrawer.jsx exactly.
export default function EnvatoGenerationDrawer({ generationId, onClose }) {
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
