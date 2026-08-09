import React, { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, getGenerationStatusMeta, getOwnershipStatusMeta, truncate } from './higgsfieldCaptureUtils';

// Visual twin of trending/kling/KlingGenerationCard.jsx and
// freepik-capture/FreepikGenerationCard.jsx - same CSS classes (.kling-card*,
// .type-badge/.stage-badge from KlingTab.css/TrendingsPanel.css) so a
// Higgsfield generation reads as the same "kind of card".
//
// Higgsfield is NOT video-only - confirmed 2026-08-05 from real traffic (a
// "nano_banana_2" job set produces images; only "seedance_2_0"-family job
// sets produce video, see providers/higgsfield/normalization.py's module
// docstring) - so, unlike this card's first draft, .type-badge here shows
// the real output type (outputType), same convention FreepikGenerationCard's
// isVideoAssetUrl branching already uses, not a status label.
// generation.outputType is only known once a network snapshot of the
// confirmed job-set detail response has been captured - defaults to
// treating it as a video when still null (a DOM-scraped submit-time
// snapshot has no output yet either way).
//
// No mirroredThumbnailUrl candidate here (unlike HeyGen's/Freepik's own
// cards) - asset mirroring is explicitly deferred for Higgsfield until real
// CDN-URL-expiry behavior is confirmed (see providers/higgsfield/registry.py's
// notes), so only Higgsfield's own thumbnailUrl/previewUrl exist yet.
const HiggsfieldCardPreview = React.memo(function HiggsfieldCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const candidates = useMemo(
    () => [generation.thumbnailUrl, generation.previewUrl].filter(Boolean),
    [generation.thumbnailUrl, generation.previewUrl]
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
          alt={truncate(generation.promptText, 60) || 'Higgsfield generation'}
          className="kling-card-image"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setCandidateIndex((index) => index + 1)}
        />
      ) : (
        <div className="kling-card-fallback">Preview</div>
      )}
    </div>
  );
});

export const HiggsfieldGenerationCard = React.memo(function HiggsfieldGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);
  const statusMeta = getGenerationStatusMeta(generation.status);
  const isVideo = generation.outputType !== 'image';

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        <HiggsfieldCardPreview generation={generation} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className={`type-badge ${isVideo ? 'video' : 'image'}`}>{isVideo ? 'Video' : 'Image'}</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={generation.promptText || ''} onClick={() => onOpen(generation)}>
        {truncate(generation.promptText, 90) || 'No prompt captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={generation.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {statusMeta.label}
        {' · '}
        {generation.creditsUsed != null ? `💳 ${generation.creditsUsed} credits` : 'Credits not captured'}
        {' · '}
        {/* providerCreatedAt = when Higgsfield actually generated this.
            createdAt is our own DB row's insert time - the two can differ
            for recovered history, so the provider timestamp always belongs
            on the card; createdAt only appears, explicitly labeled, in the
            detail drawer. */}
        {formatRelativeTime(generation.providerCreatedAt || generation.createdAt)}
      </p>

      {generation.presetName && (
        <div className="kling-card-tags">
          <span className="kling-card-tag-chip" title="Preset">🎛 {generation.presetName}</span>
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

export default HiggsfieldGenerationCard;
