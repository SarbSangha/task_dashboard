import { useCallback, useEffect, useState } from 'react';
import { flowCaptureAPI } from '../../../../../../services/api';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  getOwnershipStatusMeta,
  normalizeApiError,
} from './flowCaptureUtils';
// Renders with Kling's drawer classes - mirrors
// envato-capture/GenerationDetailPanel.jsx, minus a dedicated owner-user
// fetch/panel (GET /api/providers/flow/users/{id} doesn't exist for this
// provider) - instead the /generations endpoints batch-attach ownerName
// server-side (see router.py's _attach_owner_names), falling back to
// "User #<id>" only if that lookup came back empty (deleted/missing user).
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

const ASSET_MIRROR_STATUS_LABEL = {
  pending: 'Pending',
  mirrored: 'Mirrored',
  failed: 'Failed (original link expired before it could be backed up)',
  skipped: 'Skipped (no media URL captured)',
};

export default function GenerationDetailPanel({ generationId }) {
  const [generation, setGeneration] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const response = await flowCaptureAPI.getGeneration(id);
      setGeneration(response.data);
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
  // mirroredAssetUrl/mirroredThumbnailUrl are our own permanent R2 copies
  // (see providers/flow/asset_mirror.py) - preferred once they exist, since
  // Flow's own mediaUrl/thumbnailUrl are short-lived Google-signed URLs that
  // 403 once their Expires token passes.
  const heroImage = generation.mirroredAssetUrl || generation.mediaUrl
    || generation.mirroredThumbnailUrl || generation.thumbnailUrl;
  const ownerLabel = generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed — not yet attributed');

  const copyPrompt = async () => {
    if (!generation.prompt) return;
    await copyTextToClipboard(generation.prompt);
  };

  return (
    <>
      <div className="kling-drawer-preview">
        {heroImage ? (
          <img src={heroImage} alt={generation.prompt || 'Flow generation'} className="kling-drawer-preview-media" />
        ) : (
          <div className="kling-drawer-preview-empty">
            {generation.assetMirrorStatus === 'failed'
              ? "Preview unavailable — Flow's original link expired before it could be backed up, and no newer link has been captured since."
              : "Preview not available yet — Flow's media URL for this generation hasn't resolved (usually resolves the first time it's viewed in Flow itself with the extension active)."}
          </div>
        )}
      </div>

      <div className="kling-drawer-actions">
        {heroImage && (
          <a href={heroImage} target="_blank" rel="noreferrer" className="kling-drawer-action-btn">
            Open Original
          </a>
        )}
        {heroImage && (
          <a href={heroImage} download className="kling-drawer-action-btn">
            Download
          </a>
        )}
        <button type="button" className="kling-drawer-action-btn" onClick={copyPrompt} disabled={!generation.prompt}>
          Copy Prompt
        </button>
      </div>

      <div className="kling-drawer-section">
        <div className="kling-drawer-owner-row">
          <UserAvatar name={generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')} size={36} />
          <div>
            <div className="kling-drawer-owner-name">{ownerLabel}</div>
          </div>
        </div>
      </div>

      <div className="kling-drawer-section">
        <h4>Prompt</h4>
        <p className="kling-drawer-prompt">{generation.prompt || 'No prompt captured for this generation.'}</p>
      </div>

      <div className="kling-drawer-section kling-drawer-metadata-grid">
        <MetaField label="Linked Task" value={generation.linkedTaskName} />
        <MetaField label="Linked Client" value={generation.linkedClientName} />
        <MetaField label="Project ID" value={generation.projectId} />
        <MetaField label="Batch ID" value={generation.batchId} />
        <MetaField label="Primary Media ID" value={generation.primaryMediaId} />
        <MetaField label="Image Backup Status" value={ASSET_MIRROR_STATUS_LABEL[generation.assetMirrorStatus] || generation.assetMirrorStatus} />
        <MetaField label="Ownership" value={ownershipMeta.label} />
        <MetaField label="Attribution Source" value={generation.ownershipSource} />
        <MetaField label="Generated" value={formatAbsoluteTime(generation.providerCreatedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(generation.createdAt)} />
        <MetaField label="Creation ID" value={generation.creationId} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={generation.metadata} label="Decoded flowWorkflows.metadata" collapsedByDefault />
      </div>
    </>
  );
}
