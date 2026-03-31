import React, { useState, useEffect } from "react";
import axios from "axios";
import { useCustomDialogs } from "../../../common/CustomDialogs";
import {
  buildUploadFormData,
  getAttachmentDisplayName,
  mergeUniqueAttachments,
  openSystemFilePicker,
} from "../../../../utils/fileUploads";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:8000";

export default function AttachmentBox({ attachments = [], onChange }) {
  const { showAlert } = useCustomDialogs();
  const [files, setFiles] = useState(attachments);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);

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
    const fileArray = Array.from(selectedFiles);
    const updatedFiles = mergeUniqueAttachments(files, fileArray);
    setFiles(updatedFiles);
    notifyParent(updatedFiles);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const handleBoxClick = (e) => {
    if (e.target.closest(".assign-attachment-actions")) {
      return;
    }
    openPicker("files");
  };

  const openPicker = (mode) => {
    openSystemFilePicker({
      mode,
      onSelect: handleFiles,
    });
  };

  const removeFile = (index) => {
    const updated = [...files];
    updated.splice(index, 1);
    setFiles(updated);
    notifyParent(updated);
  };

  const uploadFiles = async () => {
    const filesToUpload = files.filter((file) => file instanceof File);
    if (filesToUpload.length === 0) return;

    const formData = buildUploadFormData(filesToUpload);

    try {
      setUploading(true);

      const response = await axios.post(`${API_BASE}/upload`, formData, {
        headers: { "Content-Type": "multipart/form-data" },
        withCredentials: true,
        onUploadProgress: (progressEvent) => {
          const percent = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setProgress(percent);
        },
      });

      await showAlert("All files uploaded.", { title: "Upload Complete" });
      
      // Keep files in state but mark as uploaded
      // Don't clear - parent component will handle this
      // setFiles([]);
    } catch (err) {
      console.error("Upload error:", err);
      await showAlert("Upload failed.", { title: "Upload Failed" });
    } finally {
      setUploading(false);
      setProgress(0);
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
            disabled={uploading || !files.some((file) => file instanceof File)}
          >
            {uploading ? `Uploading... ${progress}%` : "📤 Upload Files"}
          </button>
        </>
      )}

      {uploading && (
        <div className="progress-container">
          <div
            className="progress-bar"
            style={{ width: `${progress}%` }}
          >
            {progress}%
          </div>
        </div>
      )}
    </div>
  );
}
