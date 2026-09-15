import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { bufferAPI, clientsAPI } from '../../../../../../services/api';
import { buildFileDownloadUrl, openUrlInNewTab } from '../../../../../../utils/fileLinks';
import { normalizeApiError } from './bufferCaptureUtils';

/**
 * A self-upload has no client of its own (see BufferSelfUpload's docstring
 * in models_new.py) - unlike a provider's own captured generation/download,
 * which is always gated behind a Task/Client picker at capture time (see
 * utils/client_gate.py). So the accountability moves to the OTHER end:
 * whoever downloads a self-upload has to say which real client and purpose
 * it's for, right before the file actually saves. Reuses the same Customer
 * Name picker data as the Create Task form (clientsAPI.getClientsForTasks)
 * and the shared .custom-dialog* look from CustomDialogs.css, already
 * loaded app-wide by CustomDialogProvider at the app root.
 *
 * Rendered via createPortal straight onto document.body - this component is
 * mounted inside BufferFeedCard, which lives inside .kling-card
 * (KlingTab.css), and that class sets `will-change: transform`
 * unconditionally. Per spec, that makes .kling-card the containing block
 * for any `position: fixed` descendant, so without the portal this modal
 * centered itself inside the ~300px card instead of the viewport (reported
 * 2026-09-15, cramped/left-aligned dialog). A portal escapes that
 * entirely, the same way CustomDialogs.jsx doesn't need one only because
 * it's mounted at the app root, outside any transformed ancestor.
 */
export default function BufferDownloadGateModal({ item, onClose }) {
  const [clientOptions, setClientOptions] = useState([]);
  const [clientName, setClientName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    clientsAPI.getClientsForTasks()
      .then((response) => {
        if (cancelled) return;
        setClientOptions(Array.isArray(response?.clients) ? response.clients : []);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleSubmit = async (event) => {
    event.preventDefault();
    const trimmedClient = clientName.trim();
    const trimmedPurpose = purpose.trim();
    if (!trimmedClient || !trimmedPurpose) {
      setError('Client and purpose are both required.');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await bufferAPI.recordSelfUploadDownload(item.rawId, {
        clientName: trimmedClient,
        purpose: trimmedPurpose,
      });
      const downloadUrl = buildFileDownloadUrl({ url: item.assetUrl, path: item.filePath }, item.title);
      openUrlInNewTab(downloadUrl);
      onClose();
    } catch (submitError) {
      setError(normalizeApiError(submitError, 'Unable to record this download.'));
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
        <div className="custom-dialog-title">Download "{item.title || 'this file'}"</div>
        <div className="custom-dialog-message">
          This came from Buffer's Self Upload, so it isn't tied to a client yet. Tell us who it's for before it downloads.
        </div>

        <div>
          <label htmlFor="bsu-download-client" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Client
          </label>
          <input
            id="bsu-download-client"
            className="custom-dialog-input"
            list="bsu-download-client-options"
            value={clientName}
            onChange={(event) => setClientName(event.target.value)}
            placeholder="Select or type a client name"
            autoFocus
          />
          <datalist id="bsu-download-client-options">
            {clientOptions.map((client) => (
              <option key={client.id} value={client.name} />
            ))}
          </datalist>
        </div>

        <div>
          <label htmlFor="bsu-download-purpose" style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
            Purpose
          </label>
          <textarea
            id="bsu-download-purpose"
            className="custom-dialog-textarea"
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            placeholder="What is this download for?"
            style={{ minHeight: 80 }}
          />
        </div>

        {error && <div className="custom-dialog-message" style={{ color: 'var(--color-danger, #dc2626)' }}>{error}</div>}

        <div className="custom-dialog-actions">
          <button type="button" className="custom-dialog-btn secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button type="submit" className="custom-dialog-btn primary" disabled={submitting}>
            {submitting ? 'Downloading…' : 'Download'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
