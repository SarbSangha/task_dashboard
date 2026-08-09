import { useCallback, useEffect, useState } from 'react';
import { heygenCaptureAPI } from '../../../../../../services/api';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatCredits,
  getGenerationStatusMeta,
  getOwnershipStatusMeta,
  normalizeApiError,
} from './heygenCaptureUtils';
// Renders with Kling's drawer classes (kling-drawer-section/metadata-grid/
// owner-row/etc), same as freepik-capture/GenerationDetailPanel.jsx, so the
// two providers' detail views read as one system.
import '../../../trending/kling/KlingGenerationDrawer.css';

function MetaField({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function GenerationDetailPanel({ generationId }) {
  const [generation, setGeneration] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [owner, setOwner] = useState(null);

  const load = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setError('');
    setOwner(null);
    try {
      const response = await heygenCaptureAPI.getGeneration(id);
      setGeneration(response.data);
      if (response.data?.ownerUserId) {
        heygenCaptureAPI.getUser(response.data.ownerUserId)
          .then((userResponse) => setOwner(userResponse.data))
          .catch(() => setOwner(null));
      }
    } catch (fetchError) {
      setError(normalizeApiError(fetchError, 'Unable to load this generation.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (generationId) load(generationId);
    else setGeneration(null);
  }, [generationId, load]);

  if (loading && !generation) {
    return <p className="kling-drawer-future-note">Loading…</p>;
  }

  if (error) {
    return <p className="kling-drawer-inline-error">{error}</p>;
  }

  if (!generation) return null;

  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);
  const statusMeta = getGenerationStatusMeta(generation.status);
  // mirroredAssetUrl/mirroredThumbnailUrl are our own permanent R2 copies
  // (see providers/heygen/asset_mirror.py) - preferred once they exist,
  // since HeyGen's own video/download/thumbnail/preview URLs are signed with
  // a short-lived Expires=/Signature= token and eventually 404 even for a
  // perfectly valid generation. video_url and download_url are the same
  // underlying file (download_url just adds a content-disposition query
  // param), so one mirrored copy covers both "Open Original" and "Download".
  // Falls back to HeyGen's original URLs for anything not mirrored yet.
  const primaryAssetUrl = generation.mirroredAssetUrl || generation.videoUrl;
  const primaryDownloadUrl = generation.mirroredAssetUrl || generation.downloadUrl;
  // Every HeyGen generation is a video - no image/video detection needed,
  // unlike Freepik's isVideoAssetUrl branching.
  const heroImage = generation.mirroredThumbnailUrl || generation.thumbnailUrl || generation.previewUrl || null;
  const ownerLabel = owner
    ? `${owner.name}${owner.employeeId ? ` (${owner.employeeId})` : ''}`
    : generation.ownerUserId
      ? `User #${generation.ownerUserId}`
      : 'Unclaimed — not yet attributed';

  const copyScript = async () => {
    if (!generation.scriptText) return;
    await copyTextToClipboard(generation.scriptText);
  };

  const generationDurationLabel = generation.generationDurationMs != null
    ? `${(generation.generationDurationMs / 1000).toFixed(1)}s`
    : null;

  return (
    <>
      <div className="kling-drawer-preview">
        {primaryAssetUrl ? (
          <video
            src={primaryAssetUrl}
            poster={heroImage || undefined}
            className="kling-drawer-preview-media"
            controls
            preload="metadata"
          />
        ) : heroImage ? (
          <img src={heroImage} alt={generation.scriptText || 'HeyGen generation'} className="kling-drawer-preview-media" />
        ) : (
          <div className="kling-drawer-preview-empty">Preview not available</div>
        )}
      </div>

      <div className="kling-drawer-actions">
        {primaryAssetUrl && (
          <a href={primaryAssetUrl} target="_blank" rel="noreferrer" className="kling-drawer-action-btn">
            Open Original
          </a>
        )}
        {generation.shareUrl && (
          <a href={generation.shareUrl} target="_blank" rel="noreferrer" className="kling-drawer-action-btn">
            Open Share Link
          </a>
        )}
        {primaryDownloadUrl && (
          <a href={primaryDownloadUrl} download className="kling-drawer-action-btn">
            Download
          </a>
        )}
        <button type="button" className="kling-drawer-action-btn" onClick={copyScript} disabled={!generation.scriptText}>
          Copy Script
        </button>
      </div>

      <div className="kling-drawer-section">
        <div className="kling-drawer-owner-row">
          <UserAvatar avatar={owner?.avatar} name={owner?.name || 'Unclaimed'} size={36} />
          <div>
            <div className="kling-drawer-owner-name">{ownerLabel}</div>
            <div className="kling-drawer-owner-department">{owner?.department || 'No department'}</div>
          </div>
        </div>
      </div>

      <div className="kling-drawer-section">
        <h4>Script</h4>
        <p className="kling-drawer-prompt">{generation.scriptText || 'No script captured for this generation.'}</p>
      </div>

      <div className="kling-drawer-section kling-drawer-metadata-grid">
        <MetaField label="Linked Task" value={generation.linkedTaskName} />
        <MetaField label="Linked Client" value={generation.linkedClientName} />
        <MetaField label="Avatar" value={generation.avatarName} />
        <MetaField label="Avatar Type" value={generation.avatarType} />
        <MetaField label="Voice" value={generation.voiceName} />
        <MetaField label="Voice Style" value={generation.voiceStyle} />
        <MetaField label="Layout" value={generation.layout} />
        <MetaField label="Background Type" value={generation.backgroundType} />
        <MetaField label="Resolution" value={generation.resolution} />
        <MetaField label="Aspect Ratio" value={generation.aspectRatio} />
        <MetaField label="Frame Rate" value={generation.fps != null ? `${generation.fps} fps` : null} />
        <MetaField label="Duration" value={generation.durationSeconds != null ? `${generation.durationSeconds}s` : null} />
        <MetaField label="Motion Engine" value={generation.motionEngine} />
        <MetaField label="Generation Time" value={generationDurationLabel} />
        <MetaField label="Credits Before" value={formatCredits(generation.creditsBefore)} />
        <MetaField label="Credits After" value={formatCredits(generation.creditsAfter)} />
        <MetaField label="Credits Used" value={formatCredits(generation.creditsUsed)} />
        <MetaField label="Ownership" value={ownershipMeta.label} />
        <MetaField label="Attribution Source" value={generation.ownershipSource} />
        <MetaField label="Status" value={statusMeta.label} />
        <MetaField
          label="Asset Backup"
          value={
            generation.assetMirrorStatus === 'mirrored' ? 'Saved to permanent storage'
              : generation.assetMirrorStatus === 'failed' ? `Backup failed${generation.assetMirrorError ? ` — ${generation.assetMirrorError}` : ''}`
              : generation.assetMirrorStatus === 'skipped' ? 'No source asset to back up'
              : 'Pending — will back up automatically'
          }
        />
        <MetaField label="Submitted" value={formatAbsoluteTime(generation.submittedAt)} />
        <MetaField label="Completed" value={formatAbsoluteTime(generation.completedAt)} />
        <MetaField label="Generated" value={formatAbsoluteTime(generation.providerCreatedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(generation.createdAt)} />
        <MetaField label="Video ID" value={generation.videoId} />
        <MetaField label="Render ID" value={generation.renderId} />
        <MetaField label="Job ID" value={generation.jobId} />
        <MetaField label="Workflow ID" value={generation.workflowId} />
        <MetaField label="Request ID" value={generation.requestId} />
        <MetaField label="Project ID" value={generation.projectId} />
        <MetaField label="Scene ID" value={generation.sceneId} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={generation.metadata} label="Captured payload metadata" collapsedByDefault />
      </div>
    </>
  );
}
