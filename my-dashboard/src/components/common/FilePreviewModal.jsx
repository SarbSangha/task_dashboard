import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  buildFileDownloadUrl,
  buildFileOpenUrl,
  getFileDisplayName,
  getFilePreviewKind,
} from '../../utils/fileLinks';
import './FilePreviewModal.css';

function renderPreviewBody(file, previewUrl) {
  const previewKind = getFilePreviewKind(file);
  const label = getFileDisplayName(file, 'Attachment');
  const downloadUrl = buildFileDownloadUrl(file, label);

  if (!previewUrl) {
    return (
      <div className="file-preview-modal-empty">
        <p>Preview is not available for this file.</p>
        {downloadUrl ? (
          <a href={downloadUrl} className="file-preview-modal-download">
            Download file
          </a>
        ) : null}
      </div>
    );
  }

  if (previewKind === 'image') {
    return <img src={previewUrl} alt={label} className="file-preview-modal-image" />;
  }

  if (previewKind === 'video') {
    return <video src={previewUrl} className="file-preview-modal-video" controls preload="metadata" />;
  }

  if (previewKind === 'audio') {
    return (
      <div className="file-preview-modal-audio-wrap">
        <audio src={previewUrl} className="file-preview-modal-audio" controls preload="metadata" />
      </div>
    );
  }

  if (previewKind === 'pdf' || previewKind === 'frame') {
    return <iframe src={previewUrl} title={label} className="file-preview-modal-frame" />;
  }

  return (
    <div className="file-preview-modal-empty">
      <p>This file type cannot be previewed inside the dashboard yet.</p>
      {downloadUrl ? (
        <a href={downloadUrl} className="file-preview-modal-download">
          Download file
        </a>
      ) : null}
    </div>
  );
}

export default function FilePreviewModal({ file, title, subtitle, onClose }) {
  const previewUrl = buildFileOpenUrl(file);
  const label = title || getFileDisplayName(file, 'Attachment');

  useEffect(() => {
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
  }, [onClose]);

  if (!file) return null;

  return createPortal(
    <div className="file-preview-modal-overlay" onClick={onClose}>
      <div
        className="file-preview-modal-shell"
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="file-preview-modal-header">
          <div>
            <h3>{label}</h3>
            {subtitle ? <p>{subtitle}</p> : null}
          </div>
          <button type="button" className="file-preview-modal-close" onClick={onClose} aria-label="Close preview">
            ×
          </button>
        </div>
        <div className="file-preview-modal-body">{renderPreviewBody(file, previewUrl)}</div>
      </div>
    </div>,
    document.body
  );
}
