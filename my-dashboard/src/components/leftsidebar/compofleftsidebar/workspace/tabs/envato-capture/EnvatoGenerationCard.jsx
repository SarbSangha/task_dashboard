import React, { useEffect, useMemo, useState } from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, getItemTypeMeta, getOwnershipStatusMeta, isAudioItemType, truncate } from './envatoCaptureUtils';

// Visual twin of freepik-capture/FreepikGenerationCard.jsx - same
// .kling-card* classes, same "reads as one card system" goal, fed from
// EnvatoGeneration instead. Envato has no per-item numeric credit ledger
// (see envatoCaptureUtils' own docstring), so the card shows the item type
// badge in place of Freepik's video/image badge, and skips a credits line
// entirely rather than showing a misleading number.
const EnvatoCardPreview = React.memo(function EnvatoCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const isAudio = isAudioItemType(generation.itemType);
  // Envato's own CDN URLs carry a signed `s=` token (see the confirmed
  // sample response) whose expiry is unconfirmed - advance through
  // candidates on load failure the same defensive way Freepik's card does,
  // rather than assuming any one of these stays valid forever.
  const candidates = useMemo(
    () => [generation.canvasUrl, generation.fallbackUrl, generation.thumbnailUrl].filter(Boolean),
    [generation.canvasUrl, generation.fallbackUrl, generation.thumbnailUrl]
  );
  const [candidateIndex, setCandidateIndex] = useState(0);

  useEffect(() => {
    setCandidateIndex(0);
  }, [candidates]);

  const imageUrl = candidates[candidateIndex];

  if (isAudio) {
    return (
      <div ref={previewRef} className="kling-card-fallback">
        {getItemTypeMeta(generation.itemType).icon} Audio
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
          alt={truncate(generation.prompt || generation.title, 60) || 'Envato generation'}
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

export const EnvatoGenerationCard = React.memo(function EnvatoGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);
  const typeMeta = getItemTypeMeta(generation.itemType);

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        <EnvatoCardPreview generation={generation} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="type-badge image">{typeMeta.icon} {typeMeta.label}</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={generation.prompt || ''} onClick={() => onOpen(generation)}>
        {truncate(generation.prompt || generation.title, 90) || 'No prompt captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={generation.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {generation.creditsBadge != null ? `💳 +${generation.creditsBadge}` : 'Cost not captured'}
        {' · '}
        {/* providerCreatedAt = when Envato actually generated this.
            generation.createdAt is our own DB row's insert time - those two
            can differ a lot for reconciliation-imported history, same
            reasoning as Freepik's card. */}
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
    </div>
  );
});

export default EnvatoGenerationCard;
