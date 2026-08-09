import { useCallback, useEffect, useState } from 'react';
import { freepikCaptureAPI } from '../../../../../../services/api';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatCredits,
  getGenerationStatusMeta,
  getOwnershipStatusMeta,
  isVideoAssetUrl,
  normalizeApiError,
} from './freepikCaptureUtils';
// Renders with Kling's drawer classes (kling-drawer-section/metadata-grid/
// owner-row/etc) rather than the chatgpt-capture-panel "nested card" look,
// per the "make this look like the Kling sidebar" ask - see
// FreepikGenerationDrawer.jsx for the shell this mounts inside. Imported
// directly here too (not just by the drawer) so this component isn't
// silently depending on a parent's side-effect import for its own classes.
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
      const response = await freepikCaptureAPI.getGeneration(id);
      setGeneration(response.data);
      if (response.data?.ownerUserId) {
        freepikCaptureAPI.getUser(response.data.ownerUserId)
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
  // (see providers/freepik/asset_mirror.py) - preferred once they exist,
  // since Freepik's own preview/download/raw URLs are signed with a
  // short-lived token and eventually 404 even for a perfectly valid
  // generation (the "Akamai error page instead of the image" report this
  // was built to fix). Falls back to Freepik's original URLs for anything
  // not mirrored yet.
  const primaryAssetUrl = generation.mirroredAssetUrl || generation.downloadUrl;
  // downloadUrl/rawUrl point at the actual .mp4 for video-generator creations
  // (see freepikCaptureUtils.isVideoAssetUrl) - only ever fed to a <video>
  // tag, never <img>, or a video creation renders a broken image icon.
  const videoUrl = [generation.mirroredAssetUrl, generation.downloadUrl, generation.rawUrl].find(isVideoAssetUrl) || null;
  const heroImage = generation.mirroredThumbnailUrl || generation.thumbnailUrl || generation.previewUrl || generation.largePreviewUrl
    || (videoUrl ? null : primaryAssetUrl);
  const dimensions = generation.width && generation.height ? `${generation.width} × ${generation.height}` : null;
  const outputDimensions = generation.outputWidth && generation.outputHeight
    ? `${generation.outputWidth} × ${generation.outputHeight}`
    : null;
  const ownerLabel = owner
    ? `${owner.name}${owner.employeeId ? ` (${owner.employeeId})` : ''}`
    : generation.ownerUserId
      ? `User #${generation.ownerUserId}`
      : 'Unclaimed — not yet attributed';

  const copyPrompt = async () => {
    if (!generation.prompt) return;
    await copyTextToClipboard(generation.prompt);
  };

  return (
    <>
      <div className="kling-drawer-preview">
        {videoUrl ? (
          <video
            src={videoUrl}
            poster={heroImage || undefined}
            className="kling-drawer-preview-media"
            controls
            preload="metadata"
          />
        ) : heroImage ? (
          <img src={heroImage} alt={generation.prompt || 'Freepik generation'} className="kling-drawer-preview-media" />
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
        {generation.webUrl && (
          <a href={generation.webUrl} target="_blank" rel="noreferrer" className="kling-drawer-action-btn">
            Open on Magnific
          </a>
        )}
        {primaryAssetUrl && (
          <a href={primaryAssetUrl} download className="kling-drawer-action-btn">
            Download
          </a>
        )}
        <button type="button" className="kling-drawer-action-btn" onClick={copyPrompt} disabled={!generation.prompt}>
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
        <p className="kling-drawer-prompt">{generation.prompt || 'No prompt captured for this generation.'}</p>
        {generation.inputPrompt && generation.inputPrompt !== generation.prompt && (
          <p className="kling-drawer-inline-note">
            <strong>Original prompt: </strong>
            {generation.inputPrompt}
          </p>
        )}
        {generation.variationPrompt && generation.variationPrompt !== generation.prompt && (
          <p className="kling-drawer-inline-note">
            <strong>Variation prompt: </strong>
            {generation.variationPrompt}
          </p>
        )}
      </div>

      <div className="kling-drawer-section kling-drawer-metadata-grid">
        <MetaField label="Linked Task" value={generation.linkedTaskName} />
        <MetaField label="Linked Client" value={generation.linkedClientName} />
        <MetaField label="Tool" value={generation.tool} />
        <MetaField label="Mode" value={generation.mode} />
        <MetaField label="Service" value={generation.service} />
        <MetaField label="Aspect Ratio" value={generation.aspectRatio} />
        <MetaField label="Resolution" value={generation.resolution} />
        <MetaField label="Dimensions" value={dimensions} />
        <MetaField label="Output Dimensions" value={outputDimensions} />
        {/* Duration/FPS only exist on video-generator creations - read
            straight off the raw metadata blob rather than adding dedicated
            columns for two fields nothing else needs yet. */}
        <MetaField label="Duration" value={generation.metadata?.duration != null ? `${generation.metadata.duration}s` : null} />
        <MetaField label="Frame Rate" value={generation.metadata?.fps != null ? `${generation.metadata.fps} fps` : null} />
        <MetaField label="Elapsed Time" value={generation.elapsedTimeMs != null ? `${(generation.elapsedTimeMs / 1000).toFixed(1)}s` : null} />
        <MetaField label="Credits Charged" value={formatCredits(generation.creditsCharged)} />
        <MetaField label="Credits Estimated" value={formatCredits(generation.creditsEstimated)} />
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
        <MetaField label="Generated" value={formatAbsoluteTime(generation.providerCreatedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(generation.createdAt)} />
        <MetaField label="Creation ID" value={generation.creationId} />
        <MetaField label="Identifier" value={generation.identifier} />
        <MetaField label="Reference" value={generation.reference} />
        <MetaField label="Family ID" value={generation.familyId} />
        <MetaField label="Transaction ID" value={generation.transactionId} />
        <MetaField label="Seed" value={generation.seed} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={generation.metadata} label="creation.metadata" collapsedByDefault />
        <JsonViewer data={generation.sourceMetadata} label="creation.metadata.source_metadata" collapsedByDefault />
        <JsonViewer data={generation.imageReferences} label="Image references (image-to-image lineage)" collapsedByDefault />
      </div>
    </>
  );
}
