import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { formatCount, formatRelativeTime, getOwnershipStatusMeta, truncate } from './elevenlabsCaptureUtils';

// Visual twin of flow-capture/FlowGenerationCard.jsx's FlowGenerationCard,
// adapted for audio instead of image previews: ElevenLabs generations are
// TTS/Music/Sound-Effects/Dubbing/Voice-Changer audio clips (Speech-to-Text
// rows have no audio output at all), not images. Mounting a real <audio>
// element inside every card in a scrolling grid (dozens mounted at once)
// would be expensive with no precedent anywhere in this codebase - see
// trending/TrendingsPanel.jsx's own `mediaType === 'music'` card fallback,
// which renders a static "Audio Preview" tile rather than an <audio>
// element, for the identical reason. So this card always renders a static
// fallback tile reusing the same .kling-card-fallback class every other
// provider card here already uses for its own no-preview case; the one real
// <audio controls> element lives only in GenerationDetailPanel.jsx.
const ElevenLabsCardPreview = React.memo(function ElevenLabsCardPreview({ generation }) {
  const hasAudio = Boolean(generation.mirroredAssetUrl || generation.mediaUrl);
  return (
    <div className="kling-card-fallback">{hasAudio ? '🔊 Audio' : 'No audio available'}</div>
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
