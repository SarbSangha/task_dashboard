import { useCallback, useEffect, useState } from 'react';
import { elevenlabsCaptureAPI } from '../../../../../../services/api';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  formatCount,
  getOwnershipStatusMeta,
  normalizeApiError,
} from './elevenlabsCaptureUtils';
// Renders with Kling's drawer classes - mirrors
// flow-capture/GenerationDetailPanel.jsx, minus a dedicated owner-user
// fetch/panel (GET /api/providers/elevenlabs/users/{id} doesn't exist for
// this provider) - instead the /generations endpoints batch-attach
// ownerName server-side (see router.py's _attach_owner_names), falling back
// to "User #<id>" only if that lookup came back empty (deleted/missing
// user).
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
  failed: 'Failed',
  skipped: 'Skipped (no audio output)',
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
      const response = await elevenlabsCaptureAPI.getGeneration(id);
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
  // mirroredAssetUrl is our own permanent R2 copy of the audio (see
  // providers/elevenlabs/asset_mirror.py) - preferred once it exists, since
  // ElevenLabs' own mediaUrl may be time-limited/expiring. Falls back to
  // mediaUrl for anything not mirrored yet - same "our mirrored copy first,
  // provider's original as fallback" idiom freepik-capture/
  // GenerationDetailPanel.jsx uses for mirroredAssetUrl || downloadUrl.
  // Speech-to-Text rows legitimately have neither (assetMirrorStatus ===
  // 'skipped', no audio output at all).
  const primaryAudioUrl = generation.mirroredAssetUrl || generation.mediaUrl || null;
  const ownerLabel = generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed — not yet attributed');

  const copyPrompt = async () => {
    if (!generation.prompt) return;
    await copyTextToClipboard(generation.prompt);
  };

  return (
    <>
      <div className="kling-drawer-preview">
        {primaryAudioUrl ? (
          <audio
            src={primaryAudioUrl}
            className="kling-drawer-preview-media"
            controls
            preload="metadata"
          />
        ) : (
          <div className="kling-drawer-preview-empty">
            {generation.assetMirrorStatus === 'skipped'
              ? 'This generation has no audio output (e.g. a Speech-to-Text transcript).'
              : "Audio not available yet — ElevenLabs' media URL for this generation hasn't resolved or been mirrored yet."}
          </div>
        )}
      </div>

      <div className="kling-drawer-actions">
        {primaryAudioUrl && (
          <a href={primaryAudioUrl} target="_blank" rel="noreferrer" className="kling-drawer-action-btn">
            Open Original
          </a>
        )}
        {primaryAudioUrl && (
          <a href={primaryAudioUrl} download className="kling-drawer-action-btn">
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
        <MetaField label="Source" value={generation.source} />
        <MetaField label="Voice" value={generation.voiceName || generation.voiceId} />
        <MetaField
          label="Credits Used"
          value={generation.creditsUsed !== null && generation.creditsUsed !== undefined ? formatCount(generation.creditsUsed) : 'Not available'}
        />
        <MetaField label="Ownership" value={ownershipMeta.label} />
        <MetaField label="Attribution Source" value={generation.ownershipSource} />
        <MetaField label="Audio Backup Status" value={ASSET_MIRROR_STATUS_LABEL[generation.assetMirrorStatus] || generation.assetMirrorStatus} />
        <MetaField label="Generated" value={formatAbsoluteTime(generation.providerCreatedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(generation.createdAt)} />
        <MetaField label="Downloaded" value={generation.downloadedAt ? formatAbsoluteTime(generation.downloadedAt) : 'Not downloaded yet'} />
        <MetaField label="Creation ID" value={generation.creationId} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={generation.metadata} label="Decoded history row metadata" collapsedByDefault />
      </div>
    </>
  );
}
