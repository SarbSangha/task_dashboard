import { useCallback, useEffect, useState } from 'react';
import { higgsfieldCaptureAPI } from '../../../../../../services/api';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatCredits,
  getGenerationStatusMeta,
  getKindLabel,
  getOwnershipStatusMeta,
  normalizeApiError,
} from './higgsfieldCaptureUtils';
// Renders with Kling's drawer classes (kling-drawer-section/metadata-grid/
// owner-row/etc), same as heygen-capture/GenerationDetailPanel.jsx, so the
// providers' detail views read as one system.
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
      const response = await higgsfieldCaptureAPI.getGeneration(id);
      setGeneration(response.data);
      if (response.data?.ownerUserId) {
        higgsfieldCaptureAPI.getUser(response.data.ownerUserId)
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
  // No mirrored asset URLs exist for Higgsfield yet (asset mirroring is
  // deferred - see providers/higgsfield/registry.py's notes), so this always
  // uses Higgsfield's own video/download/thumbnail/preview URLs directly,
  // unlike heygen-capture's identical panel which prefers a permanent R2
  // copy. Higgsfield is NOT video-only (confirmed 2026-08-05 from real
  // traffic - a "nano_banana_2" job set produces images, see
  // providers/higgsfield/normalization.py's module docstring), so
  // outputType decides <video> vs <img> below, same role Freepik's
  // isVideoAssetUrl plays for its own image/video mix - except this is a
  // real captured signal, not a URL-extension guess. Defaults to treating
  // an unknown/not-yet-captured outputType as a video (this column is only
  // ever populated once a real network snapshot of the confirmed job-set
  // detail response has been captured).
  const isVideo = generation.outputType !== 'image';
  const primaryAssetUrl = generation.videoUrl;
  const primaryDownloadUrl = generation.downloadUrl || generation.videoUrl;
  const heroImage = generation.thumbnailUrl || generation.previewUrl || null;
  const ownerLabel = owner
    ? `${owner.name}${owner.employeeId ? ` (${owner.employeeId})` : ''}`
    : generation.ownerUserId
      ? `User #${generation.ownerUserId}`
      : 'Unclaimed — not yet attributed';

  const copyPrompt = async () => {
    if (!generation.promptText) return;
    await copyTextToClipboard(generation.promptText);
  };

  const generationDurationLabel = generation.generationDurationMs != null
    ? `${(generation.generationDurationMs / 1000).toFixed(1)}s`
    : null;

  return (
    <>
      <div className="kling-drawer-preview">
        {primaryAssetUrl && isVideo ? (
          <video
            src={primaryAssetUrl}
            poster={heroImage || undefined}
            className="kling-drawer-preview-media"
            controls
            preload="metadata"
          />
        ) : primaryAssetUrl || heroImage ? (
          <img src={primaryAssetUrl || heroImage} alt={generation.promptText || 'Higgsfield generation'} className="kling-drawer-preview-media" />
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
        {primaryDownloadUrl && (
          <a href={primaryDownloadUrl} download className="kling-drawer-action-btn">
            Download
          </a>
        )}
        <button type="button" className="kling-drawer-action-btn" onClick={copyPrompt} disabled={!generation.promptText}>
          Copy Prompt
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
        <h4>Prompt</h4>
        <p className="kling-drawer-prompt">{generation.promptText || 'No prompt captured for this generation.'}</p>
      </div>

      <div className="kling-drawer-section kling-drawer-metadata-grid">
        <MetaField label="Linked Task" value={generation.linkedTaskName} />
        <MetaField label="Linked Client" value={generation.linkedClientName} />
        <MetaField label="Action" value={getKindLabel(generation.kind)} />
        <MetaField label="Output Type" value={generation.outputType ? (generation.outputType === 'image' ? 'Image' : 'Video') : null} />
        <MetaField label="Preset" value={generation.presetName} />
        <MetaField label="Preset Category" value={generation.presetCategory} />
        <MetaField label="Multi-shot" value={generation.multiShot === true ? 'On' : generation.multiShot === false ? 'Off' : null} />
        <MetaField label="Enhance Prompt" value={generation.enhancePrompt === true ? 'On' : generation.enhancePrompt === false ? 'Off' : null} />
        <MetaField label="Resolution" value={generation.resolution} />
        <MetaField label="Aspect Ratio" value={generation.aspectRatio} />
        <MetaField label="Frame Rate" value={generation.fps != null ? `${generation.fps} fps` : null} />
        <MetaField label="Duration" value={generation.durationSeconds != null ? `${generation.durationSeconds}s` : null} />
        <MetaField label="Quality" value={generation.quality} />
        <MetaField label="Generation Time" value={generationDurationLabel} />
        <MetaField label="Credits Before" value={formatCredits(generation.creditsBefore)} />
        <MetaField label="Credits After" value={formatCredits(generation.creditsAfter)} />
        <MetaField label="Credits Used" value={formatCredits(generation.creditsUsed)} />
        <MetaField label="Ownership" value={ownershipMeta.label} />
        <MetaField label="Attribution Source" value={generation.ownershipSource} />
        <MetaField label="Status" value={statusMeta.label} />
        <MetaField label="Submitted" value={formatAbsoluteTime(generation.submittedAt)} />
        <MetaField label="Completed" value={formatAbsoluteTime(generation.completedAt)} />
        <MetaField label="Generated" value={formatAbsoluteTime(generation.providerCreatedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(generation.createdAt)} />
        <MetaField label="Generation ID" value={generation.generationId} />
        <MetaField label="Job ID" value={generation.jobId} />
        <MetaField label="Request ID" value={generation.requestId} />
        <MetaField label="Project ID" value={generation.projectId} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={generation.metadata} label="Captured payload metadata" collapsedByDefault />
      </div>
    </>
  );
}
