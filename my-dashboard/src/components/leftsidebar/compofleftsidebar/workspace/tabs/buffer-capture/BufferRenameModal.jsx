import { useState } from 'react';
import { createPortal } from 'react-dom';
import { bufferAPI } from '../../../../../../services/api';
import { normalizeApiError } from './bufferCaptureUtils';

/**
 * Rename/re-tag a Self Upload - owner-or-admin only, enforced server-side
 * (PATCH /api/buffer/self-uploads/{id}). Tags are a plain comma-separated
 * field here (see BufferSelfUpload.tags's own comment for why this isn't a
 * normalized tags table) rather than a chip-input widget, to keep this a
 * quick two-field edit instead of a bigger component.
 *
 * Rendered via createPortal onto document.body, same reason as
 * BufferDownloadGateModal.jsx - any ancestor with `will-change: transform`
 * (e.g. .kling-card in KlingTab.css) becomes the containing block for a
 * `position: fixed` descendant, breaking true full-viewport centering.
 * This modal isn't currently nested inside one, but the portal costs
 * nothing and keeps it correct if that ever changes.
 */
export default function BufferRenameModal({ item, onClose, onSaved }) {
  const [title, setTitle] = useState(item.title || '');
  const [tagsText, setTagsText] = useState((item.tags || []).join(', '));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      const tags = tagsText.split(',').map((tag) => tag.trim()).filter(Boolean);
      const response = await bufferAPI.updateSelfUpload(item.rawId, { title: title.trim(), tags });
      onSaved(response?.item);
      onClose();
    } catch (submitError) {
      setError(normalizeApiError(submitError, 'Unable to save changes.'));
    } finally {
      setSubmitting(false);
    }
  };

  return createPortal(
    <div className="custom-dialog-overlay" onClick={onClose}>
      <form
        className="custom-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <div className="custom-dialog-title">Edit upload</div>

        <div>
          <label htmlFor="bsu-rename-title" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Title
          </label>
          <input
            id="bsu-rename-title"
            className="custom-dialog-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Untitled"
            autoFocus
          />
        </div>

        <div>
          <label htmlFor="bsu-rename-tags" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Tags
          </label>
          <input
            id="bsu-rename-tags"
            className="custom-dialog-input"
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
            placeholder="Comma-separated, e.g. logo, draft, q3-campaign"
          />
        </div>

        {error && <div className="custom-dialog-message" style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</div>}

        <div className="custom-dialog-actions">
          <button type="button" className="custom-dialog-btn secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="custom-dialog-btn primary" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
