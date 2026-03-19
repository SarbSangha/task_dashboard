import React, { useEffect, useState } from 'react';
import { authAPI } from '../../services/api';
import { normalizeAvatarSrc } from '../../utils/avatar';
import './AvatarUpload.css';

export function AvatarUpload({ currentAvatar, onAvatarUpdate }) {
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState(normalizeAvatarSrc(currentAvatar));
  const [error, setError] = useState('');

  useEffect(() => {
    setPreview(normalizeAvatarSrc(currentAvatar));
  }, [currentAvatar]);

  const handleFileChange = async (e) => {
    const file = e.target.files[0];
    
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (max 2MB)
    if (file.size > 2 * 1024 * 1024) {
      setError('Image size should be less than 2MB');
      return;
    }

    setError('');
    setUploading(true);

    // Convert to base64
    const reader = new FileReader();
    reader.onloadend = async () => {
      const base64String = reader.result;
      const previousPreview = preview;
      setPreview(base64String);

      try {
        const response = await authAPI.uploadAvatar(base64String);
        const savedAvatar = normalizeAvatarSrc(response?.avatar) || base64String;
        setPreview(savedAvatar);
        
        if (onAvatarUpdate) {
          onAvatarUpdate(savedAvatar);
        }
      } catch (error) {
        console.error('❌ Upload failed:', error);
        setPreview(previousPreview);
        setError('Failed to upload avatar');
      } finally {
        setUploading(false);
      }
    };

    reader.readAsDataURL(file);
  };

  const handleDeleteAvatar = async () => {
    try {
      await authAPI.deleteAvatar();
      setPreview(null);
      
      if (onAvatarUpdate) {
        onAvatarUpdate(null);
      }
      
      console.log('✅ Avatar deleted');
    } catch (error) {
      console.error('❌ Delete failed:', error);
      setError('Failed to delete avatar');
    }
  };

  return (
    <div className="avatar-upload-container">
      <div className="avatar-preview">
        {preview ? (
          <img src={preview} alt="Avatar" className="avatar-image" />
        ) : (
          <div className="avatar-placeholder">
            <span className="avatar-placeholder-text">
              {currentAvatar ? '?' : 'No Avatar'}
            </span>
          </div>
        )}
      </div>

      <div className="avatar-actions">
        <label className="avatar-upload-btn">
          {uploading ? 'Uploading...' : 'Upload Photo'}
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            disabled={uploading}
            style={{ display: 'none' }}
          />
        </label>

        {preview && (
          <button
            onClick={handleDeleteAvatar}
            className="avatar-delete-btn"
            disabled={uploading}
          >
            Remove
          </button>
        )}
      </div>

      {error && <div className="avatar-error">{error}</div>}
      
      <p className="avatar-hint">
        JPG, PNG or GIF. Max size 2MB.
      </p>
    </div>
  );
}
