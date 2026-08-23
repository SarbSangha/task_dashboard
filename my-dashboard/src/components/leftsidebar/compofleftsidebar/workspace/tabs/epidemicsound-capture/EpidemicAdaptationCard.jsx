import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import {
  formatCount,
  formatRelativeTime,
  getAdaptationStatusMeta,
  getOwnershipStatusMeta,
  truncate,
} from './epidemicCaptureUtils';

// Epidemic Sound "Adaptations" are a real prompt-based AI regeneration
// feature (confirmed from real captured traffic, 2026-08-19) - a user picks
// a track they already have and asks for a re-styled version of it (e.g.
// "give this tune a dhol sarangi touch in punjabi style"), which Epidemic
// Sound then generates asynchronously. That makes this card a generation
// card, not a download card: unlike EpidemicDownloadCard.jsx (always
// already-finished audio bytes by the time a download_click event is
// captured), an adaptation can genuinely still be mid-generation for a
// while, so status drives both the preview and the primary badge here -
// see epidemicCaptureUtils.js's own ADAPTATION_STATUS_META comment.
const AdaptationCardPreview = React.memo(function AdaptationCardPreview({ adaptation }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const mirroredUrl = adaptation.mirroredAssetUrl;

  if (mirroredUrl) {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          <audio src={mirroredUrl} controls preload="metadata" style={{ width: '100%' }} />
        ) : (
          <div className="kling-card-fallback">🎚 Adaptation</div>
        )}
      </div>
    );
  }

  // status !== 'completed' means there is no audio to mirror yet at all -
  // that takes priority over the assetMirrorStatus branch below (which only
  // matters once generation has actually finished), so this shows a
  // "still generating" message instead of a generic "no audio" one.
  if (adaptation.status !== 'completed') {
    const statusMeta = getAdaptationStatusMeta(adaptation.status);
    return (
      <div ref={previewRef} className="kling-card-fallback">
        {statusMeta.icon} {adaptation.status === 'draft' ? 'Not generated yet' : 'Still generating…'}
      </div>
    );
  }

  // assetMirrorStatus distinguishes "still working on it" from "gave up",
  // same pattern EpidemicDownloadCard.jsx's own preview uses.
  const statusLabel = adaptation.assetMirrorStatus === 'pending'
    ? 'Mirroring…'
    : adaptation.assetMirrorStatus === 'failed'
      ? 'Mirror failed'
      : 'No audio available';

  return (
    <div ref={previewRef} className="kling-card-fallback">
      🎚 {statusLabel}
    </div>
  );
});

export const EpidemicAdaptationCard = React.memo(function EpidemicAdaptationCard({ adaptation }) {
  const ownershipMeta = getOwnershipStatusMeta(adaptation.ownershipStatus);
  const statusMeta = getAdaptationStatusMeta(adaptation.status);

  return (
    <div className="kling-card">
      <div className="kling-card-preview">
        <AdaptationCardPreview adaptation={adaptation} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className={`chatgpt-capture-badge tone-${statusMeta.tone}`}>{statusMeta.icon} {statusMeta.label}</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      {/* The real text prompt is the primary text here (like a generation
          card, e.g. EnvatoGenerationCard.jsx) - not a title, since an
          adaptation is a request to regenerate, not a pre-made asset. */}
      <h4 className="kling-card-prompt" title={adaptation.prompt || ''}>
        {truncate(adaptation.prompt, 90) || 'No prompt captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={adaptation.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {adaptation.ownerName || (adaptation.ownerUserId ? `User #${adaptation.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {/* creditsUsed is a flat, always-1000 value (see
            epidemicCaptureUtils.js's own ADAPTATION_STATUS_META comment) -
            rendered the same plain way every other provider's credits badge
            is (e.g. higgsfield-capture/HiggsfieldGenerationCard.jsx's own
            credits line); this component doesn't need to know it's flat. */}
        {adaptation.creditsUsed != null ? `💳 ${formatCount(adaptation.creditsUsed)} credits` : 'Credits not captured'}
        {' · '}
        {formatRelativeTime(adaptation.createdAt)}
      </p>

      {(adaptation.originalTrackTitle || adaptation.linkedTaskName || adaptation.linkedClientName) && (
        <div className="kling-card-tags">
          {adaptation.originalTrackTitle && (
            <span className="kling-card-tag-chip" title="Original track">
              🎵 {truncate(adaptation.originalTrackTitle, 40)}
            </span>
          )}
          {adaptation.linkedTaskName && (
            <span className="kling-card-tag-chip" title="Linked task">📋 {adaptation.linkedTaskName}</span>
          )}
          {adaptation.linkedClientName && (
            <span className="kling-card-tag-chip" title="Linked client">🏢 {adaptation.linkedClientName}</span>
          )}
        </div>
      )}
    </div>
  );
});

export default EpidemicAdaptationCard;
