// components/Inbox/SubmitSection.jsx
import React, { useState } from 'react';
import './SubmitSection.css';
import { useCustomDialogs } from '../../../common/CustomDialogs';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const SubmitSection = ({ taskId, onClose, onSubmitComplete }) => {
  const { showAlert } = useCustomDialogs();
  const [formData, setFormData] = useState({
    comments: '',
    resultDetails: '',
    attachments: []
  });
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleFileUpload = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setUploading(true);
    try {
      const uploadedUrls = [];
      
      for (const file of files) {
        const formData = new FormData();
        formData.append('files', file);

        const response = await fetch(`${API_BASE}/upload`, {
          method: 'POST',
          credentials: 'include',
          body: formData
        });

        const data = await response.json();
        if (data.success && data.data?.length > 0) {
          uploadedUrls.push(data.data[0].url);
        }
      }

      setFormData(prev => ({
        ...prev,
        attachments: [...prev.attachments, ...uploadedUrls]
      }));

      await showAlert(`${files.length} file(s) uploaded successfully!`, { title: 'Upload Complete' });
    } catch (error) {
      console.error('Upload error:', error);
      await showAlert('Failed to upload files.', { title: 'Upload Failed' });
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!formData.resultDetails.trim()) {
      await showAlert('Please provide result details.', { title: 'Missing Details' });
      return;
    }

    setSubmitting(true);
    try {
      const response = await fetch(`${API_BASE}/api/tasks/${taskId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(formData)
      });

      const data = await response.json();

      if (data.success) {
        await showAlert('Task submitted successfully!', { title: 'Success' });
        onSubmitComplete();
      } else {
        await showAlert(data.detail || 'Task submission failed.', { title: 'Submission Failed' });
      }
    } catch (error) {
      console.error('Submit error:', error);
      await showAlert('Failed to submit task.', { title: 'Submission Failed' });
    } finally {
      setSubmitting(false);
    }
  };

  const removeAttachment = (index) => {
    setFormData(prev => ({
      ...prev,
      attachments: prev.attachments.filter((_, i) => i !== index)
    }));
  };

  return (
    <div className="submit-overlay" onClick={onClose}>
      <div className="submit-modal" onClick={e => e.stopPropagation()}>
        <div className="submit-header">
          <h2>📤 Submit Task Result</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        <form onSubmit={handleSubmit} className="submit-form">
          {/* Result Details */}
          <div className="form-group">
            <label>Result Details *</label>
            <textarea
              value={formData.resultDetails}
              onChange={(e) => setFormData({...formData, resultDetails: e.target.value})}
              placeholder="Describe what you've accomplished..."
              rows="6"
              required
            />
          </div>

          {/* Comments */}
          <div className="form-group">
            <label>Additional Comments</label>
            <textarea
              value={formData.comments}
              onChange={(e) => setFormData({...formData, comments: e.target.value})}
              placeholder="Any additional notes or feedback..."
              rows="3"
            />
          </div>

          {/* File Upload */}
          <div className="form-group">
            <label>Attachments</label>
            <div className="upload-area">
              <input
                type="file"
                multiple
                onChange={handleFileUpload}
                disabled={uploading}
                id="file-upload"
                style={{ display: 'none' }}
              />
              <label htmlFor="file-upload" className="upload-btn">
                {uploading ? '⏳ Uploading...' : '📎 Upload Files'}
              </label>
            </div>

            {/* Attachment List */}
            {formData.attachments.length > 0 && (
              <div className="attachments-preview">
                <h4>Uploaded Files ({formData.attachments.length})</h4>
                {formData.attachments.map((url, index) => (
                  <div key={index} className="attachment-preview-item">
                    <span>📄 {url.split('/').pop()}</span>
                    <button 
                      type="button" 
                      onClick={() => removeAttachment(index)}
                      className="remove-btn"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Submit Button */}
          <div className="submit-actions">
            <button 
              type="submit" 
              className="submit-btn"
              disabled={submitting || uploading}
            >
              {submitting ? '⏳ Submitting...' : '✓ Submit Result'}
            </button>
            <button 
              type="button" 
              className="cancel-btn"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default SubmitSection;
