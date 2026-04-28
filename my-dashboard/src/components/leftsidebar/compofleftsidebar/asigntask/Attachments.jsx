import React, { useState, useEffect } from "react";
import { useCustomDialogs } from "../../../common/CustomDialogs";
import { fileAPI } from "../../../../services/api";
import {
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from "../../../../utils/fileUploads";

export default function AttachmentBox({ attachments = [], onChange, disabled = false }) {
  const { showAlert } = useCustomDialogs();
  const [files, setFiles] = useState(attachments);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [uploadedBytes, setUploadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);

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

  // Sync with parent when attachments prop changes
  useEffect(() => {
    setFiles(attachments);
  }, [attachments]);

  // Notify parent of changes
  const notifyParent = (updatedFiles) => {
    if (onChange) {
      onChange(updatedFiles);
    }
  };

  const handleFiles = (selectedFiles) => {
    if (disabled) return;
    const fileArray = Array.from(selectedFiles);
    const updatedFiles = mergeUniqueAttachments(files, fileArray);
    setFiles(updatedFiles);
    notifyParent(updatedFiles);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    if (disabled) return;
    handleFiles(e.dataTransfer.files);
  };

  const handleBoxClick = (e) => {
    if (e.target.closest(".assign-attachment-actions")) {
      return;
    }
    if (disabled) return;
    openPicker("files");
  };

  const openPicker = (mode) => {
    if (disabled) return;
    openSystemFilePicker({
      mode,
      onSelect: handleFiles,
    });
  };

  const removeFile = (index) => {
    if (disabled) return;
    const updated = [...files];
    updated.splice(index, 1);
    setFiles(updated);
    notifyParent(updated);
  };

  const uploadFiles = async () => {
    const filesToUpload = files.filter((file) => file instanceof File);
    if (filesToUpload.length === 0) return;

    try {
      setUploading(true);
      const pendingTotalBytes = filesToUpload.reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0);
      setUploadedBytes(0);
      setTotalBytes(pendingTotalBytes);
      const response = await fileAPI.uploadFiles(filesToUpload, {
        onProgress: (percent, metrics = {}) => {
          setProgress(percent);
          setUploadedBytes(Math.max(Number(metrics?.loaded) || 0, 0));
          setTotalBytes(Math.max(Number(metrics?.total) || pendingTotalBytes, 0));
        },
      });
      const uploadedAttachments = Array.isArray(response?.data) ? response.data : [];
      const remainingFiles = files.filter((file) => !(file instanceof File));
      const updatedFiles = mergeUniqueAttachments(remainingFiles, uploadedAttachments);
      setFiles(updatedFiles);
      notifyParent(updatedFiles);

      await showAlert("All files uploaded.", { title: "Upload Complete" });
    } catch (err) {
      console.error("Upload error:", err);
      await showAlert(err?.response?.data?.detail || err?.message || "Upload failed.", { title: "Upload Failed" });
    } finally {
      setUploading(false);
      setProgress(0);
      setUploadedBytes(0);
      setTotalBytes(0);
    }
  };

  return (
    <div className="assign-card">
      <h3>Attachments</h3>

      <div
        className="assign-attachment-box"
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={handleBoxClick}
      >
        <p>📎 Drag & Drop files or click to browse</p>
        <small>Supports single files, multiple files, and full folders.</small>

        <div className="assign-attachment-actions">
          <button
            type="button"
            className="assign-attachment-action-btn"
            disabled={disabled}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openPicker("files");
            }}
          >
            Choose Files
          </button>
          <button
            type="button"
            className="assign-attachment-action-btn"
            disabled={disabled}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openPicker("folder");
            }}
          >
            Choose Folder
          </button>
        </div>
      </div>

      {files.length > 0 && (
        <>
          <div className="file-list" style={{ marginTop: "10px" }}>
            {files.map((file, index) => (
              <div key={index} className="file-item">
                <span className="file-name">
                  📄 {getAttachmentDisplayName(file)}
                  <span className="file-size">
                    ({(file.size / 1024).toFixed(1)} KB)
                  </span>
                </span>
                <button 
                  className="remove-file-btn" 
                  disabled={disabled}
                  onClick={(e) => {
                    e.stopPropagation();
                    removeFile(index);
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button 
            className="upload-files-btn" 
            onClick={uploadFiles} 
            disabled={disabled || uploading || !files.some((file) => file instanceof File)}
          >
            {uploading ? `Uploading... ${progress}%` : "📤 Upload Files"}
          </button>

          {!uploading && files.some((file) => file instanceof File) && (
            <div className="attachment-upload-size-note">
              Pending upload size: {formatUploadSize(files.filter((file) => file instanceof File).reduce((sum, file) => sum + Math.max(Number(file?.size) || 0, 0), 0))}
            </div>
          )}
        </>
      )}

      {uploading && (
        <>
          <div className="progress-container">
            <div
              className="progress-bar"
              style={{ width: `${progress}%` }}
            >
              {progress}%
            </div>
          </div>
          <div className="attachment-upload-size-note">
            {formatUploadSize(uploadedBytes)} of {formatUploadSize(totalBytes)} transferred
          </div>
        </>
      )}
    </div>
  );
}
