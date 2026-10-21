import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { generationCollectionsAPI, generationRecordsAPI } from '../../../../../services/api';
import { UserAvatar } from '../../../../common/UserAvatar';
import { usePermissions } from '../../../../../hooks/usePermissions';
import { getGenerationMediaKind, formatGenerationDate } from './klingMedia';
import KlingTagInput from './KlingTagInput';
import './KlingGenerationDrawer.css';

export default function KlingGenerationDrawer({
  generation,
  onClose,
  onToggleFavorite,
  isFavoritePending,
  canDownload,
  onGenerationUpdated,
  onGenerationDeleted,
}) {
  const { isAdmin, isFaculty } = usePermissions();
  const [detail, setDetail] = useState(generation);
  const [tagActionPending, setTagActionPending] = useState(false);
  const [tagError, setTagError] = useState('');
  const [ownershipActionPending, setOwnershipActionPending] = useState(false);
  const [ownershipError, setOwnershipError] = useState('');

  const videoInputRef = useRef(null);
  const [adminActionPending, setAdminActionPending] = useState('');
  const [uploadProgress, setUploadProgress] = useState(0);
  const [adminError, setAdminError] = useState('');

  const [collections, setCollections] = useState([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState('');
  const [collectionActionPending, setCollectionActionPending] = useState(false);
  const [collectionMessage, setCollectionMessage] = useState('');

  useEffect(() => {
    setDetail(generation);
  }, [generation]);

  useEffect(() => {
    if (!generation?.id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await generationRecordsAPI.getById(generation.id);
        if (!cancelled && response?.data) {
          setDetail((prev) => ({ ...prev, ...response.data }));
        }
      } catch (error) {
        console.warn('Failed to refresh Kling generation detail:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [generation?.id]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await generationCollectionsAPI.listCollections();
        const list = Array.isArray(response?.data) ? response.data : [];
        if (!cancelled) {
          setCollections(list);
          setSelectedCollectionId(list[0]?.id ?? '');
        }
      } catch (error) {
        console.warn('Failed to load collections for drawer:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleAddTag = async (tagText) => {
    if (!detail?.id) return;
    setTagActionPending(true);
    setTagError('');
    try {
      await generationRecordsAPI.addTag(detail.id, tagText);
      setDetail((prev) => ({ ...prev, tags: [...(prev.tags || []), tagText] }));
    } catch (error) {
      setTagError(error?.response?.data?.detail || 'Could not add tag.');
    } finally {
      setTagActionPending(false);
    }
  };

  const handleRemoveTag = async (tagText) => {
    if (!detail?.id) return;
    setTagActionPending(true);
    setTagError('');
    try {
      await generationRecordsAPI.removeTag(detail.id, tagText);
      setDetail((prev) => ({ ...prev, tags: (prev.tags || []).filter((existing) => existing !== tagText) }));
    } catch (error) {
      setTagError(error?.response?.data?.detail || 'Could not remove tag.');
    } finally {
      setTagActionPending(false);
    }
  };

  const handleAddToCollection = async () => {
    if (!detail?.id || !selectedCollectionId) return;
    setCollectionActionPending(true);
    setCollectionMessage('');
    try {
      await generationCollectionsAPI.addGeneration(selectedCollectionId, detail.id);
      const collectionName = collections.find((collection) => collection.id === Number(selectedCollectionId))?.name;
      setCollectionMessage(`Added to "${collectionName || 'collection'}".`);
    } catch (error) {
      setCollectionMessage(error?.response?.data?.detail || 'Could not add to collection.');
    } finally {
      setCollectionActionPending(false);
    }
  };

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

  if (!generation) return null;

  const mediaKind = getGenerationMediaKind(detail);
  const ownershipLabel = detail.ownershipStatus === 'resolved' ? 'Resolved' : 'Unknown';

  const handleClaim = async () => {
    if (!detail?.id) return;
    setOwnershipActionPending(true);
    setOwnershipError('');
    try {
      const response = await generationRecordsAPI.claim(detail.id);
      if (response?.data) setDetail((prev) => ({ ...prev, ...response.data }));
    } catch (error) {
      setOwnershipError(error?.response?.data?.detail || 'Could not claim this generation.');
    } finally {
      setOwnershipActionPending(false);
    }
  };

  const handleRevokeClaim = async () => {
    if (!detail?.id) return;
    setOwnershipActionPending(true);
    setOwnershipError('');
    try {
      const response = await generationRecordsAPI.revokeClaim(detail.id);
      if (response?.data) setDetail((prev) => ({ ...prev, ...response.data }));
    } catch (error) {
      setOwnershipError(error?.response?.data?.detail || 'Could not revoke this claim.');
    } finally {
      setOwnershipActionPending(false);
    }
  };

  const applyAdminUpdate = (updated) => {
    if (!updated) return;
    setDetail((prev) => ({ ...prev, ...updated }));
    onGenerationUpdated?.(updated);
  };

  const handleVideoSelected = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !detail?.id) return;
    if (file.size > 90 * 1024 * 1024) {
      setAdminError('Video is larger than 90 MB.');
      return;
    }
    setAdminActionPending('upload');
    setUploadProgress(0);
    setAdminError('');
    try {
      const response = await generationRecordsAPI.uploadVideo(detail.id, file, { onProgress: setUploadProgress });
      applyAdminUpdate(response?.data);
    } catch (error) {
      setAdminError(error?.response?.data?.detail || 'Could not upload the video.');
    } finally {
      setAdminActionPending('');
    }
  };

  const handleRemoveVideo = async () => {
    if (!detail?.id || !window.confirm('Remove the uploaded video? The card goes back to the captured video, if there is one.')) return;
    setAdminActionPending('remove');
    setAdminError('');
    try {
      const response = await generationRecordsAPI.removeVideo(detail.id);
      applyAdminUpdate(response?.data);
    } catch (error) {
      setAdminError(error?.response?.data?.detail || 'Could not remove the video.');
    } finally {
      setAdminActionPending('');
    }
  };

  const handleDeleteCard = async () => {
    if (!detail?.id || !window.confirm('Delete this card? It will disappear from Kling for everyone.')) return;
    setAdminActionPending('delete');
    setAdminError('');
    try {
      await generationRecordsAPI.deleteGeneration(detail.id);
      onGenerationDeleted?.(detail.id);
      onClose?.();
    } catch (error) {
      setAdminError(error?.response?.data?.detail || 'Could not delete the card.');
      setAdminActionPending('');
    }
  };

  const adminVideo = detail.metadata?.adminVideo;

  const copyPrompt = async () => {
    if (!detail.promptText) return;
    try {
      await navigator.clipboard.writeText(detail.promptText);
    } catch (error) {
      console.warn('Failed to copy prompt:', error);
    }
  };

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
          <div className="kling-drawer-preview">
            {mediaKind === 'image' && detail.canonicalAssetUrl ? (
              <img src={detail.canonicalAssetUrl} alt="Generation preview" className="kling-drawer-preview-media" />
            ) : mediaKind === 'video' && detail.canonicalAssetUrl ? (
              <video src={detail.canonicalAssetUrl} className="kling-drawer-preview-media" controls preload="metadata" />
            ) : (
              <div className="kling-drawer-preview-empty">Preview not available</div>
            )}
          </div>

          <div className="kling-drawer-actions">
            {detail.canonicalAssetUrl && (
              <a href={detail.canonicalAssetUrl} target="_blank" rel="noreferrer" className="kling-drawer-action-btn">
                Open Original
              </a>
            )}
            {canDownload && detail.canonicalAssetUrl && (
              <a href={detail.canonicalAssetUrl} download className="kling-drawer-action-btn">
                Download
              </a>
            )}
            <button type="button" className="kling-drawer-action-btn" onClick={copyPrompt} disabled={!detail.promptText}>
              Copy Prompt
            </button>
            <button
              type="button"
              className={`kling-drawer-action-btn ${detail.isFavorite ? 'active' : ''}`}
              onClick={() => onToggleFavorite(detail)}
              disabled={isFavoritePending}
            >
              {detail.isFavorite ? '★ Favorited' : '☆ Favorite'}
            </button>
          </div>

          {isAdmin && (
            <div className="kling-drawer-section kling-drawer-admin">
              <h4>Admin</h4>
              {adminVideo && (
                <p className="kling-drawer-inline-note">
                  Showing uploaded video{adminVideo.fileName ? ` "${adminVideo.fileName}"` : ''}.
                </p>
              )}
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/webm,video/quicktime,.mp4,.webm,.mov"
                hidden
                onChange={handleVideoSelected}
              />
              <div className="kling-drawer-actions">
                <button
                  type="button"
                  className="kling-drawer-action-btn"
                  onClick={() => videoInputRef.current?.click()}
                  disabled={Boolean(adminActionPending)}
                >
                  {adminActionPending === 'upload'
                    ? `Uploading... ${uploadProgress}%`
                    : adminVideo || detail.canonicalAssetUrl
                      ? 'Replace Video'
                      : 'Upload Video'}
                </button>
                {adminVideo && (
                  <button
                    type="button"
                    className="kling-drawer-action-btn"
                    onClick={handleRemoveVideo}
                    disabled={Boolean(adminActionPending)}
                  >
                    {adminActionPending === 'remove' ? 'Removing...' : 'Remove Uploaded Video'}
                  </button>
                )}
                <button
                  type="button"
                  className="kling-drawer-action-btn kling-drawer-danger-btn"
                  onClick={handleDeleteCard}
                  disabled={Boolean(adminActionPending)}
                >
                  {adminActionPending === 'delete' ? 'Deleting...' : 'Delete Card'}
                </button>
              </div>
              {adminError && <p className="kling-drawer-inline-error">{adminError}</p>}
            </div>
          )}

          <div className="kling-drawer-section">
            <div className="kling-drawer-owner-row">
              <UserAvatar avatar={detail.ownerAvatar} name={detail.ownerName || 'Unknown user'} size={36} />
              <div>
                <div className="kling-drawer-owner-name">{detail.ownerName || 'Unknown user'}</div>
                <div className="kling-drawer-owner-department">{detail.ownerDepartment || 'No department'}</div>
              </div>
            </div>
          </div>

          <div className="kling-drawer-section">
            <h4>Prompt</h4>
            <p className="kling-drawer-prompt">{detail.promptText || 'No prompt captured for this generation.'}</p>
          </div>

          <div className="kling-drawer-section">
            <h4>Tags</h4>
            <KlingTagInput
              tags={detail.tags || []}
              onAdd={handleAddTag}
              onRemove={handleRemoveTag}
              disabled={tagActionPending}
            />
            {tagError && <p className="kling-drawer-inline-error">{tagError}</p>}
          </div>

          <div className="kling-drawer-section">
            <h4>Add to Collection</h4>
            {collections.length === 0 ? (
              <p className="kling-drawer-future-note">You don't have any collections yet — create one from the Collections tab.</p>
            ) : (
              <div className="kling-drawer-collection-row">
                <select
                  className="trendings-filter-select"
                  value={selectedCollectionId}
                  onChange={(event) => setSelectedCollectionId(event.target.value)}
                >
                  {collections.map((collection) => (
                    <option key={collection.id} value={collection.id}>
                      {collection.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="kling-drawer-action-btn"
                  onClick={handleAddToCollection}
                  disabled={collectionActionPending}
                >
                  Add
                </button>
              </div>
            )}
            {collectionMessage && <p className="kling-drawer-inline-note">{collectionMessage}</p>}
          </div>

          <div className="kling-drawer-section kling-drawer-metadata-grid">
            <div>
              <span>Project</span>
              <strong>{detail.projectName || 'Ungrouped'}</strong>
            </div>
            <div>
              <span>Linked Task</span>
              <strong>{detail.linkedTaskName || '-'}</strong>
            </div>
            <div>
              <span>Linked Client</span>
              <strong>{detail.linkedClientName || '-'}</strong>
            </div>
            <div>
              <span>Model</span>
              <strong>{detail.modelLabel || '-'}</strong>
            </div>
            <div>
              <span>Resolution</span>
              <strong>{detail.resolutionLabel || '-'}</strong>
            </div>
            <div>
              <span>Duration</span>
              <strong>{detail.durationLabel || '-'}</strong>
            </div>
            <div>
              <span>Credits</span>
              <strong>{detail.creditsBurned ?? '-'}</strong>
            </div>
            <div>
              <span>Ownership</span>
              <strong>{ownershipLabel}</strong>
              {detail.ownershipStatus === 'unknown' && (
                <button
                  type="button"
                  className="kling-drawer-action-btn kling-drawer-ownership-btn"
                  onClick={handleClaim}
                  disabled={ownershipActionPending}
                >
                  {ownershipActionPending ? 'Claiming...' : 'This was done by me'}
                </button>
              )}
              {isFaculty && detail.ownershipSource === 'user_claimed' && (
                <button
                  type="button"
                  className="kling-drawer-action-btn kling-drawer-ownership-btn"
                  onClick={handleRevokeClaim}
                  disabled={ownershipActionPending}
                >
                  {ownershipActionPending ? 'Revoking...' : 'Revoke claim'}
                </button>
              )}
              {ownershipError && <p className="kling-drawer-inline-error">{ownershipError}</p>}
            </div>
            <div>
              <span>Created</span>
              <strong>{formatGenerationDate(detail.createdAt)}</strong>
            </div>
            <div>
              <span>Updated</span>
              <strong>{formatGenerationDate(detail.updatedAt)}</strong>
            </div>
            <div>
              <span>Generation ID</span>
              <strong>{detail.providerGenerationId || detail.id}</strong>
            </div>
            <div>
              <span>Task ID</span>
              <strong>{detail.providerTaskId || '-'}</strong>
            </div>
            <div>
              <span>Asset Key</span>
              <strong>{detail.canonicalAssetKey || '-'}</strong>
            </div>
          </div>

          <div className="kling-drawer-section kling-drawer-future">
            <h4>Related Generations</h4>
            <p className="kling-drawer-future-note">Find Similar / visual clustering is coming in a future update.</p>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
