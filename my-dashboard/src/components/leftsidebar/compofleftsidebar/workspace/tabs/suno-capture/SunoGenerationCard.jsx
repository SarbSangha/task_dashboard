import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { formatCount, formatRelativeTime, getOwnershipStatusMeta, truncate } from './sunoCaptureUtils';

// Visual twin of elevenlabs-capture/ElevenLabsGenerationCard.jsx's
// ElevenLabsGenerationCard, adapted for Suno (suno.com): every Suno
// generation is a music clip (no TTS/SFX/Dubbing surface split, no
// Speech-to-Text-style "no audio output" rows), but the "mount a real
// <audio> element inside every scrolling-grid card" cost is identical, so
// this card still always renders a static fallback tile reusing the same
// .kling-card-fallback class every other provider card here already uses
// for its own no-preview case; the one real <audio controls> element lives
// only in GenerationDetailPanel.jsx.
const SunoCardPreview = React.memo(function SunoCardPreview({ generation }) {
  const hasAudio = Boolean(generation.mirroredAssetUrl || generation.mediaUrl);
  return (
    <div className="kling-card-fallback">{hasAudio ? '🔊 Audio' : 'No audio available'}</div>
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
