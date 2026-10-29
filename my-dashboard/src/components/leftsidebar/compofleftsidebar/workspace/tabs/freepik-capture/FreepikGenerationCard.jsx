import React, { useEffect, useMemo, useState } from 'react';
import { AdminMediaCardPreview } from '../../../../../common/AdminMediaPreview';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatCredits, formatRelativeTime, getOwnershipStatusMeta, isVideoAssetUrl, truncate } from './freepikCaptureUtils';

// Visual twin of trending/kling/KlingGenerationCard.jsx - same CSS classes
// (.kling-card*, .type-badge/.stage-badge from KlingTab.css/TrendingsPanel.css,
// reused as-is rather than duplicated) so a Freepik generation reads as the
// same "kind of card" a Kling generation does, just fed from FreepikGeneration
// instead of GenerationRecord. Freepik has no favorite/tag/collection actions
// built yet (unlike Kling), so the card is the read-only subset: preview,
// tool/ownership badges, prompt, owner, credits, and a compact tag row for
// Freepik's own tags_json (aspect ratio / model family tags Freepik itself
// assigns, e.g. "9:16", "auto").
const FreepikCardPreview = React.memo(function FreepikCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  // mirroredThumbnailUrl is our own permanent R2 copy (see
  // providers/freepik/asset_mirror.py) - preferred once it exists. Freepik's
  // own thumbnailUrl/previewUrl/largePreviewUrl are signed with
  // INDEPENDENTLY expiring tokens (confirmed 2026-08-05 - one variant's
  // token can be dead while another's still has days left), so on a load
  // failure this advances to the next candidate instead of giving up and
  // showing "No preview" when a perfectly working URL was one field over.
  const candidates = useMemo(
    () => [generation.mirroredThumbnailUrl, generation.thumbnailUrl, generation.previewUrl, generation.largePreviewUrl].filter(Boolean),
    [generation.mirroredThumbnailUrl, generation.thumbnailUrl, generation.previewUrl, generation.largePreviewUrl]
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [candidates]);

  const imageUrl = candidates[candidateIndex];
  // A video creation's thumbnail is only its start frame - play the clip
  // itself (our backed-up copy first), with that frame as its poster, the
  // same lazy <video> flow-capture/FlowGenerationCard.jsx uses. Falls back
  // to the still if the clip won't load (e.g. an expired Freepik link).
  const videoUrl = useMemo(
    () => [generation.mirroredAssetUrl, generation.downloadUrl, generation.rawUrl].find(isVideoAssetUrl) || null,
    [generation.mirroredAssetUrl, generation.downloadUrl, generation.rawUrl]
  );
  const [videoFailed, setVideoFailed] = useState(false);

  useEffect(() => {
    setVideoFailed(false);
  }, [videoUrl]);

  if (videoUrl && !videoFailed) {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          <video
            src={videoUrl}
            poster={imageUrl || undefined}
            className="kling-card-image"
            muted
            playsInline
            preload="metadata"
            onError={() => setVideoFailed(true)}
          />
        ) : (
          <div className="kling-card-fallback">Video Preview</div>
        )}
      </div>
    );
  }

  if (!imageUrl) {
    return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        <img
          src={imageUrl}
          alt={truncate(generation.prompt, 60) || 'Freepik generation'}
          className="kling-card-image"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      ) : (
        <div className="kling-card-fallback">Image Preview</div>
      )}
    </div>
  );
});

export const FreepikGenerationCard = React.memo(function FreepikGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);
  const isVideo = isVideoAssetUrl(generation.downloadUrl) || isVideoAssetUrl(generation.rawUrl);

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        {generation.adminMedia ? (
          <AdminMediaCardPreview media={generation.adminMedia} />
        ) : (
          <FreepikCardPreview generation={generation} />
        )}
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className={`type-badge ${isVideo ? 'video' : 'image'}`}>{generation.mode || generation.tool || (isVideo ? 'video' : 'image')}</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={generation.prompt || ''} onClick={() => onOpen(generation)}>
        {truncate(generation.prompt || generation.nameField, 90) || 'No prompt captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={generation.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {/* creditsUsed: what was charged, or Freepik's estimate on the
            unlimited plan (charged 0) - same rule as the credit report. */}
        {generation.creditsUsed != null
          ? `💳 ${formatCredits(generation.creditsUsed)} credits${generation.onUnlimitedPlan ? ' (unlimited)' : ''}`
          : 'Credits not reported'}
        {' · '}
        {/* providerCreatedAt = when Freepik actually generated this (what a
            viewer means by "X ago" on an image card). generation.createdAt
            is our own DB row's insert time (when WE captured it) - those two
            can differ a lot for reconciliation-imported history, so the
            provider timestamp is always what belongs on the card; createdAt
            only appears, explicitly labeled, in the detail drawer. */}
        {formatRelativeTime(generation.providerCreatedAt || generation.createdAt)}
      </p>

      {(generation.linkedTaskName || generation.linkedClientName) && (
        <div className="kling-card-tags">
          {generation.linkedTaskName && (
            <span className="kling-card-tag-chip" title="Linked task">📋 {generation.linkedTaskName}</span>
          )}
          {generation.linkedClientName && (
            <span className="kling-card-tag-chip" title="Linked client">🏢 {generation.linkedClientName}</span>
          )}
        </div>
      )}

      {Array.isArray(generation.tags) && generation.tags.length > 0 && (
        <div className="kling-card-tags">
          {generation.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="kling-card-tag-chip">{tag}</span>
          ))}
          {generation.tags.length > 3 && (
            <span className="kling-card-tag-chip kling-card-tag-chip-overflow">+{generation.tags.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
});

export default FreepikGenerationCard;
