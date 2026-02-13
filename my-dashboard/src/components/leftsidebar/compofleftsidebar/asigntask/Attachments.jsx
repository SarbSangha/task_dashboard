import React, { useState, useRef, useEffect } from "react";
import axios from "axios";

export default function AttachmentBox({ attachments = [], onChange }) {
  const [files, setFiles] = useState(attachments);
  const [progress, setProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

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
    const updatedFiles = [...files, ...fileArray];
    setFiles(updatedFiles);
    notifyParent(updatedFiles);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const removeFile = (index) => {
    const updated = [...files];
    updated.splice(index, 1);
    setFiles(updated);
    notifyParent(updated);
  };

  const uploadFiles = async () => {
    if (files.length === 0) return;

    const formData = new FormData();
    files.forEach((file) => {
      formData.append("files", file);
    });

    try {
      setUploading(true);

      const response = await axios.post("http://localhost:8000/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
        onUploadProgress: (progressEvent) => {
          const percent = Math.round(
            (progressEvent.loaded * 100) / progressEvent.total
          );
          setProgress(percent);
        },
      });

      alert("All files uploaded 🚀");
      
      // Keep files in state but mark as uploaded
      // Don't clear - parent component will handle this
      // setFiles([]);
    } catch (err) {
      console.error("Upload error:", err);
      alert("Upload failed ❌");
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
        onClick={() => fileInputRef.current.click()}
      >
        <p>📎 Drag & Drop files or click to browse</p>

        <input
          type="file"
          multiple
          hidden
          ref={fileInputRef}
          onChange={(e) => handleFiles(e.target.files)}
        />
      </div>

      {files.length > 0 && (
        <>
          <div className="file-list" style={{ marginTop: "10px" }}>
            {files.map((file, index) => (
              <div key={index} className="file-item">
                <span className="file-name">
                  📄 {file.name} 
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
            disabled={uploading}
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
