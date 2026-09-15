import { useCallback, useEffect, useRef, useState } from 'react';
import { useCustomDialogs } from '../../../../../common/CustomDialogs';
import { bufferAPI, fileAPI } from '../../../../../../services/api';
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from '../../../../../../utils/fileUploads';
import BufferFeedGrid from './BufferFeedGrid';
import BufferRenameModal from './BufferRenameModal';
import { normalizeApiError } from './bufferCaptureUtils';
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import './BufferSelfUploadTab.css';

const PAGE_SIZE = 24;

const formatUploadSize = (bytes = 0) => {
  const safeBytes = Number.isFinite(bytes) ? Math.max(bytes, 0) : 0;
  if (safeBytes < 1024) return `${safeBytes} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = safeBytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  const decimals = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(decimals)} ${units[unitIndex]}`;
};

/**
 * Buffer's "Self Upload" tab - lets any signed-in user drop a file straight
 * into the Buffer feed for something they did that no provider's own
 * capture flow could tag with the Buffer client (work outside any tracked
 * tool, or something the extension's capture missed). Reuses the exact same
 * upload plumbing as every other attachment box in this app (fileAPI.
 * uploadFiles -> presigned R2 PUT, see asigntask/Attachments.jsx for the
 * pattern this mirrors) rather than inventing a second upload path - only
 * the "record this into Buffer" step (bufferAPI.createSelfUpload) is new.
 */
export default function BufferSelfUploadTab() {
  const { showAlert, showConfirm } = useCustomDialogs();
  const [pendingFiles, setPendingFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);

  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [renamingItem, setRenamingItem] = useState(null);
  const requestTokenRef = useRef(0);

  const loadMine = useCallback(async (offset, { append } = {}) => {
    const token = ++requestTokenRef.current;
    if (append) setLoadingMore(true);
    else setLoading(true);
    setError('');
    try {
      const response = await bufferAPI.getMySelfUploads({ limit: PAGE_SIZE, offset });
      if (token !== requestTokenRef.current) return;
      setItems((prev) => (append ? [...prev, ...(response.items || [])] : response.items || []));
      setTotal(response.total || 0);
    } catch (fetchError) {
      if (token !== requestTokenRef.current) return;
      setError(normalizeApiError(fetchError, 'Unable to load your uploads.'));
    } finally {
      if (token === requestTokenRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, []);

  useEffect(() => {
    loadMine(0, { append: false });
  }, [loadMine]);

  const handleLoadMore = () => {
    if (loadingMore || items.length >= total) return;
    loadMine(items.length, { append: true });
  };

  const handleFilesSelected = (selectedFiles) => {
    if (uploading) return;
    setPendingFiles((prev) => mergeUniqueAttachments(prev, Array.from(selectedFiles)));
  };

  const handleDrop = (event) => {
    event.preventDefault();
    if (uploading) return;
    handleFilesSelected(event.dataTransfer.files);
  };

  const handleRemovePending = (index) => {
    if (uploading) return;
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleUpload = async () => {
    if (pendingFiles.length === 0 || uploading) return;

    try {
      setUploading(true);
      const pendingTotalBytes = pendingFiles.reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0);
      setUploadedBytes(0);
      setTotalBytes(pendingTotalBytes);

      const uploadResponse = await fileAPI.uploadFiles(pendingFiles, {
        onProgress: (percent, metrics = {}) => {
          setProgress(percent);
          setUploadedBytes(Math.max(Number(metrics?.loaded) || 0, 0));
          setTotalBytes(Math.max(Number(metrics?.total) || pendingTotalBytes, 0));
        },
      });
      const uploadedAttachments = Array.isArray(uploadResponse?.data) ? uploadResponse.data : [];
      if (uploadedAttachments.length === 0) {
        throw new Error('Upload did not return any files.');
      }

      // The R2 upload is a plain attachment record with no idea it's headed
      // into Buffer - this second step is what actually creates the Buffer
      // row per uploaded file, recording who uploaded it.
      await Promise.all(
        uploadedAttachments.map((attachment) =>
          bufferAPI.createSelfUpload({
            url: attachment.url,
            path: attachment.path,
            mimetype: attachment.mimetype,
            size: attachment.size,
            originalName: attachment.originalName || attachment.filename,
          })
        )
      );

      setPendingFiles([]);
      await loadMine(0, { append: false });
      await showAlert(
        `${uploadedAttachments.length} file(s) added to Buffer.`,
        { title: 'Upload Complete' }
      );
    } catch (uploadError) {
      await showAlert(normalizeApiError(uploadError, 'Upload failed.'), { title: 'Upload Failed' });
    } finally {
      setUploading(false);
      setProgress(0);
      setUploadedBytes(0);
      setTotalBytes(0);
    }
  };

  const handleDelete = async (item) => {
    const ok = await showConfirm('Delete this upload from Buffer? This cannot be undone.', {
      title: 'Delete Upload',
    });
    if (!ok) return;

    try {
      await bufferAPI.deleteSelfUpload(item.rawId ?? item.id);
      setItems((prev) => prev.filter((existing) => existing.id !== item.id));
      setTotal((prev) => Math.max(0, prev - 1));
    } catch (deleteError) {
      await showAlert(normalizeApiError(deleteError, 'Unable to delete this upload.'), { title: 'Delete Failed' });
    }
  };

  const handleRenameSaved = (updatedItem) => {
    if (!updatedItem) return;
    setItems((prev) => prev.map((existing) => (existing.id === updatedItem.id ? updatedItem : existing)));
  };

  const pendingBytes = pendingFiles.reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0);

  return (
    <div className="bsu-tab">
      <div
        className="bsu-dropzone"
        onDrop={handleDrop}
        onDragOver={(event) => event.preventDefault()}
        onClick={() => !uploading && openSystemFilePicker({ mode: 'files', onSelect: handleFilesSelected })}
      >
        <span className="bsu-dropzone-icon" aria-hidden="true">📤</span>
        <p className="bsu-dropzone-title">Drag &amp; drop files, or click to browse</p>
        <p className="bsu-dropzone-hint">Anything you generated or downloaded yourself gets added to the shared Buffer feed.</p>
        <div className="bsu-dropzone-actions">
          <button
            type="button"
            className="chatgpt-capture-secondary-btn"
            disabled={uploading}
            onClick={(event) => {
              event.stopPropagation();
              openSystemFilePicker({ mode: 'files', onSelect: handleFilesSelected });
            }}
          >
            Choose Files
          </button>
        </div>
      </div>

      {pendingFiles.length > 0 && (
        <div className="bsu-pending">
          {pendingFiles.map((file, index) => (
            <div key={`${file.name}-${file.size}-${file.lastModified}`} className="bsu-pending-item">
              <span className="bsu-pending-name">📄 {getAttachmentDisplayName(file)}</span>
              <span className="bsu-pending-size">{formatUploadSize(file.size)}</span>
              <button
                type="button"
                className="bsu-pending-remove"
                aria-label="Remove from upload queue"
                disabled={uploading}
                onClick={() => handleRemovePending(index)}
              >
                ✕
              </button>
            </div>
          ))}

          <button
            type="button"
            className="chatgpt-capture-primary-btn"
            style={{ width: '100%', marginTop: 10 }}
            onClick={handleUpload}
            disabled={uploading}
          >
            {uploading ? `Uploading... ${progress}%` : `📤 Upload ${pendingFiles.length} file(s) (${formatUploadSize(pendingBytes)})`}
          </button>
        </div>
      )}

      {uploading && (
        <div className="bsu-progress-wrap">
          <div className="bsu-progress-bar">
            <div className="bsu-progress-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="bsu-progress-note">
            {formatUploadSize(uploadedBytes)} of {formatUploadSize(totalBytes)} transferred
          </div>
        </div>
      )}

      <h3 className="bsu-mine-heading">My uploads</h3>

      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && items.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">📤</span>
          <strong>You haven't self-uploaded anything yet</strong>
          <p>Files you upload here show up both above and in the main Buffer feed.</p>
        </div>
      )}

      <BufferFeedGrid
        items={items}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={items.length < total}
        onLoadMore={handleLoadMore}
        onDelete={handleDelete}
        onRename={setRenamingItem}
      />

      {renamingItem && (
        <BufferRenameModal
          item={renamingItem}
          onClose={() => setRenamingItem(null)}
          onSaved={handleRenameSaved}
        />
      )}
    </div>
  );
}
