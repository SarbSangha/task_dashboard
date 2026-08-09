import { useCallback, useEffect, useState } from 'react';
import { envatoCaptureAPI } from '../../../../../../services/api';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatCredits,
  getItemTypeMeta,
  getOwnershipStatusMeta,
  isAudioItemType,
  normalizeApiError,
} from './envatoCaptureUtils';
// Renders with Kling's drawer classes - mirrors
// freepik-capture/GenerationDetailPanel.jsx exactly.
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
      const response = await envatoCaptureAPI.getGeneration(id);
      setGeneration(response.data);
      if (response.data?.ownerUserId) {
        envatoCaptureAPI.getUser(response.data.ownerUserId)
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
  const typeMeta = getItemTypeMeta(generation.itemType);
  const isAudio = isAudioItemType(generation.itemType);
  const primaryAssetUrl = generation.canvasUrl || generation.fallbackUrl;
  const heroImage = !isAudio ? (generation.canvasUrl || generation.fallbackUrl || generation.thumbnailUrl) : null;
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
        {isAudio ? (
          <div className="kling-drawer-preview-empty">{typeMeta.icon} {typeMeta.label} — no visual preview</div>
        ) : heroImage ? (
          <img src={heroImage} alt={generation.prompt || generation.title || 'Envato generation'} className="kling-drawer-preview-media" />
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
        {generation.title && generation.title !== generation.prompt && (
          <p className="kling-drawer-inline-note">
            <strong>Title: </strong>
            {generation.title}
          </p>
        )}
      </div>

      <div className="kling-drawer-section kling-drawer-metadata-grid">
        <MetaField label="Linked Task" value={generation.linkedTaskName} />
        <MetaField label="Linked Client" value={generation.linkedClientName} />
        <MetaField label="Tool" value={typeMeta.label} />
        <MetaField label="Aspect Ratio" value={generation.aspectRatio} />
        <MetaField label="Style" value={generation.style} />
        <MetaField label="Shortcut Preset" value={generation.shortcutSlug} />
        <MetaField label="In Envato Workspace" value={generation.isInWorkspace ? 'Yes' : 'No'} />
        <MetaField label="Downloaded" value={generation.isDownloaded ? 'Yes' : 'No'} />
        <MetaField label="Review Status" value={generation.reviewStatus} />
        <MetaField label="Credit Badge (at click time)" value={generation.creditsBadge != null ? `+${formatCredits(generation.creditsBadge)}` : null} />
        <MetaField
          label="Quota Remaining (before → after)"
          value={
            generation.quotaRemainingBefore != null || generation.quotaRemainingAfter != null
              ? `${generation.quotaRemainingBefore ?? '—'} → ${generation.quotaRemainingAfter ?? '—'}`
              : null
          }
        />
        <MetaField label="Ownership" value={ownershipMeta.label} />
        <MetaField label="Attribution Source" value={generation.ownershipSource} />
        <MetaField label="Generated" value={formatAbsoluteTime(generation.providerCreatedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(generation.createdAt)} />
        <MetaField label="Item UUID" value={generation.itemUuid} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={generation.metadata} label="Decoded generation-history item" collapsedByDefault />
        <JsonViewer data={generation.sourceMetadata} label="actions[] (download/workspace/edit/review)" collapsedByDefault />
      </div>
    </>
  );
}
