import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatCount, formatRelativeTime, getOwnershipStatusMeta, truncate } from './sunoCaptureUtils';

// Every Suno generation is a music clip, so the card plays it inline, the
// same way epidemicsound-capture/EpidemicDownloadCard.jsx, splice-capture/
// SpliceDownloadCard.jsx and envato-capture/DownloadCard.jsx all already do
// for their own audio.
//
// This card used to render a permanently static "🔊 Audio" tile instead,
// on the reasoning that mounting an <audio> element in every card of a
// scrolling grid (dozens at once) was too expensive. That cost is real, but
// the three cards above solve it rather than accept it: useNearViewport
// gates the element on the card actually approaching the viewport, and
// preload="metadata" keeps even a mounted player from pulling whole audio
// files. Off-screen cards still render the cheap static tile, so the grid
// cost is unchanged - only the handful of cards in view mount a player.
const SunoCardPreview = React.memo(function SunoCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  // mirroredAssetUrl (our own stored copy of the captured bytes) is preferred
  // over mediaUrl: for Suno the latter is frequently absent or a non-playable
  // reference, since the real bytes are captured off the page's MSE playback
  // rather than fetched from a URL (see content-suno-network.js).
  const audioUrl = generation.mirroredAssetUrl || generation.mediaUrl;

  if (!audioUrl) {
    return <div className="kling-card-fallback">No audio available</div>;
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        // stopPropagation because - unlike the Epidemic/Splice cards this
        // pattern comes from, which have no detail drawer at all - this
        // card's preview area is itself a click target that opens the
        // drawer. Without it, hitting play or dragging the scrubber would
        // also open the drawer over the player the user just started. The
        // surrounding preview area stays clickable, so opening the drawer by
        // clicking the tile (or the title) still works.
        <audio
          src={audioUrl}
          controls
          preload="metadata"
          style={{ width: '100%' }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : (
        <div className="kling-card-fallback">🔊 Audio</div>
      )}
    </div>
  );
});

export const SunoGenerationCard = React.memo(function SunoGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        <SunoCardPreview generation={generation} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
          {generation.downloadedAt && (
            <span className="stage-badge" title={`Downloaded ${formatRelativeTime(generation.downloadedAt)}`}>
              ⬇️ Downloaded
            </span>
          )}
          {generation.creditsUsed !== null && generation.creditsUsed !== undefined && (
            <span className="stage-badge" title="Credits burned by this generation">
              🔥 {formatCount(generation.creditsUsed)}
            </span>
          )}
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
        {/* providerCreatedAt = when Suno actually generated this. createdAt
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

export default SunoGenerationCard;
