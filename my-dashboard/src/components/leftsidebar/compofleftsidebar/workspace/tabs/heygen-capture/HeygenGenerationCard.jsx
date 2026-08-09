import React, { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, getGenerationStatusMeta, getOwnershipStatusMeta, truncate } from './heygenCaptureUtils';

// Visual twin of trending/kling/KlingGenerationCard.jsx and
// freepik-capture/FreepikGenerationCard.jsx - same CSS classes (.kling-card*,
// .type-badge/.stage-badge from KlingTab.css/TrendingsPanel.css) so a HeyGen
// generation reads as the same "kind of card". Every HeyGen generation is a
// video (unlike Freepik's image/video mix), so there's no type-detection
// branching here - the top-left badge shows lifecycle status instead of a
// media-type badge.
const HeygenCardPreview = React.memo(function HeygenCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  // mirroredThumbnailUrl is our own permanent R2 copy (see
  // providers/heygen/asset_mirror.py) - preferred once it exists. HeyGen's
  // own thumbnailUrl/previewUrl are signed with INDEPENDENTLY expiring
  // Expires=/Signature= tokens (confirmed 2026-08-05 on Freepik's identical
  // Pikaso setup - one variant's token can be dead while another's still has
  // days left), so on a load failure this advances to the next candidate
  // instead of giving up and showing "No preview" when a working URL was one
  // field over.
  const candidates = useMemo(
    () => [generation.mirroredThumbnailUrl, generation.thumbnailUrl, generation.previewUrl].filter(Boolean),
    [generation.mirroredThumbnailUrl, generation.thumbnailUrl, generation.previewUrl]
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [candidates]);

  const imageUrl = candidates[candidateIndex];

  if (!imageUrl) {
    return <div ref={previewRef} className="kling-card-fallback">🎬 No preview</div>;
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        <img
          src={imageUrl}
          alt={truncate(generation.scriptText, 60) || 'HeyGen generation'}
          className="kling-card-image"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      ) : (
        <div className="kling-card-fallback">Video Preview</div>
      )}
    </div>
  );
});

export const HeygenGenerationCard = React.memo(function HeygenGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);
  const statusMeta = getGenerationStatusMeta(generation.status);

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        <HeygenCardPreview generation={generation} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className={`type-badge ${statusMeta.tone === 'error' ? 'image' : 'video'}`}>{statusMeta.label}</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={generation.scriptText || ''} onClick={() => onOpen(generation)}>
        {truncate(generation.scriptText, 90) || 'No script captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={generation.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {generation.creditsUsed != null ? `💳 ${generation.creditsUsed} credits` : 'Credits not captured'}
        {' · '}
        {/* providerCreatedAt = when HeyGen actually generated this. createdAt
            is our own DB row's insert time - the two can differ for recovered
            history, so the provider timestamp always belongs on the card;
            createdAt only appears, explicitly labeled, in the detail drawer. */}
        {formatRelativeTime(generation.providerCreatedAt || generation.createdAt)}
      </p>

      {generation.avatarName && (
        <div className="kling-card-tags">
          <span className="kling-card-tag-chip" title="Avatar">🧑 {generation.avatarName}</span>
        </div>
      )}

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
    </div>
  );
});

export default HeygenGenerationCard;
