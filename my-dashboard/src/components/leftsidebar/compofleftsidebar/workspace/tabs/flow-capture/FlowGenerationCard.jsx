import React, { useEffect, useState } from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, getOwnershipStatusMeta, truncate } from './flowCaptureUtils';

// Visual twin of envato-capture/EnvatoGenerationCard.jsx - same .kling-card*
// classes. mediaUrl is only populated once content-flow-network.js has
// separately captured the resolved media.getMediaUrlRedirect response for
// this generation's primaryMediaId (see providers/flow/CAPTURE_CONTRACT.md) -
// a generation whose media hasn't resolved yet (or never will, e.g. an old
// row from before that capture path existed) falls back to a plain "No
// preview" placeholder rather than a broken <img>, same pattern every other
// provider card here already uses for its own no-thumbnail case.
//
// mirroredAssetUrl (our own permanent R2 copy - see providers/flow/
// asset_mirror.py) is preferred once it exists, since Flow's own mediaUrl is
// a short-lived Google-signed URL that 403s once its Expires token passes
// (confirmed live 2026-08-14 - a 2-day-old generation's link had already
// expired). Falls back to mediaUrl for anything not mirrored yet, same
// "our mirrored copy first, provider's original as fallback" idiom every
// other provider's card here already uses for its own mirroredAssetUrl.
const FlowCardPreview = React.memo(function FlowCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const [imageFailed, setImageFailed] = useState(false);
  const primaryImageUrl = generation.mirroredAssetUrl || generation.mediaUrl;

  useEffect(() => {
    setImageFailed(false);
  }, [primaryImageUrl]);

  const imageUrl = !imageFailed ? primaryImageUrl : null;

  if (!imageUrl) {
    return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        <img
          src={imageUrl}
          alt={truncate(generation.prompt, 60) || 'Flow generation'}
          className="kling-card-image"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="kling-card-fallback">Image Preview</div>
      )}
    </div>
  );
});

export const FlowGenerationCard = React.memo(function FlowGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        <FlowCardPreview generation={generation} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={generation.prompt || ''} onClick={() => onOpen(generation)}>
        {truncate(generation.prompt, 90) || 'No prompt captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')} size={22} />
        <span className="kling-card-owner-name">
          {generation.ownerName || (generation.ownerUserId ? `User #${generation.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {/* providerCreatedAt = when Flow actually generated this. createdAt
            is our own DB row's insert time - those two can differ for a
            slower/reconciliation-style capture, same reasoning as every
            other provider's card. */}
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

export default FlowGenerationCard;
