import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatCount, formatRelativeTime, getOwnershipStatusMeta, truncate } from './elevenlabsCaptureUtils';

// ElevenLabs generations are TTS/Music/Sound-Effects/Dubbing/Voice-Changer
// audio clips, so the card plays them inline - the same way
// epidemicsound-capture/EpidemicDownloadCard.jsx, splice-capture/
// SpliceDownloadCard.jsx and envato-capture/DownloadCard.jsx already do, and
// matching suno-capture/SunoGenerationCard.jsx.
//
// This card used to render a permanently static "🔊 Audio" tile, on the
// reasoning that mounting an <audio> element in every card of a scrolling
// grid (dozens at once) was too expensive and had no precedent here. The
// cost is real but the precedent does exist: the three cards above solve it
// with useNearViewport, which mounts a player only as a card approaches the
// viewport, plus preload="metadata" so even a mounted player never pulls a
// whole file. Off-screen cards keep rendering the cheap static tile.
//
// Speech-to-Text rows genuinely have no audio output at all, so the
// no-audio branch below is a real state here (unlike Suno, where every row
// is a music clip), not just a not-captured-yet placeholder.
const ElevenLabsCardPreview = React.memo(function ElevenLabsCardPreview({ generation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const audioUrl = generation.mirroredAssetUrl || generation.mediaUrl;

  if (!audioUrl) {
    return <div className="kling-card-fallback">No audio available</div>;
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        // stopPropagation: this card's preview area is itself a click target
        // that opens the detail drawer (the Epidemic/Splice cards this
        // pattern comes from have no drawer, so they never needed this).
        // Without it, hitting play or dragging the scrubber would also open
        // the drawer over the player the user just started. Clicking the
        // surrounding tile, or the title, still opens it.
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

export const ElevenLabsGenerationCard = React.memo(function ElevenLabsGenerationCard({ generation, onOpen }) {
  const ownershipMeta = getOwnershipStatusMeta(generation.ownershipStatus);

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={() => onOpen(generation)}>
        <ElevenLabsCardPreview generation={generation} />
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
            <span className="stage-badge" title="Credits burned by this generation (ElevenLabs' own character-count accounting)">
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
        {/* providerCreatedAt = when ElevenLabs actually generated this.
            createdAt is our own DB row's insert time - those two can differ
            for a slower/reconciliation-style capture, same reasoning as
            every other provider's card. */}
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

export default ElevenLabsGenerationCard;
