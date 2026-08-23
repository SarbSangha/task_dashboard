import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatCount, formatRelativeTime, getOwnershipStatusMeta, getSoundKindMeta, truncate } from './epidemicCaptureUtils';

// mirroredAssetUrl is our own permanent R2 copy of the actual downloaded
// audio bytes (same reasoning as envato-capture/DownloadCard.jsx's own
// comment: Epidemic Sound's real /download/ response requires the browser's
// own authenticated session, so only the browser - which already legitimately
// received the bytes when the Download button was clicked - can ever supply
// this; the backend has no way to pull it independently). Unlike Envato,
// there is no image/video branch to consider at all: every Epidemic Sound
// download is audio (music or a sound effect - see getSoundKindMeta), and
// there is no assetThumbnailUrl field in the captured payload to fall back
// to, so the only two states are "playable" and "not yet mirrored".
const DownloadCardPreview = React.memo(function DownloadCardPreview({ download }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const mirroredUrl = download.mirroredAssetUrl;
  const kindMeta = getSoundKindMeta(download.isSfx);

  if (mirroredUrl) {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          <audio src={mirroredUrl} controls preload="metadata" style={{ width: '100%' }} />
        ) : (
          <div className="kling-card-fallback">{kindMeta.icon} {kindMeta.label}</div>
        )}
      </div>
    );
  }

  // assetMirrorStatus distinguishes "still working on it" from "gave up" so
  // the fallback tile doesn't just say "No preview" for a download that will
  // become playable a moment later.
  const statusLabel = download.assetMirrorStatus === 'pending'
    ? 'Mirroring…'
    : download.assetMirrorStatus === 'failed'
      ? 'Mirror failed'
      : `${kindMeta.label}`;

  return (
    <div ref={previewRef} className="kling-card-fallback">
      {kindMeta.icon} {statusLabel}
    </div>
  );
});

export const EpidemicDownloadCard = React.memo(function EpidemicDownloadCard({ download }) {
  const ownershipMeta = getOwnershipStatusMeta(download.ownershipStatus);
  const kindMeta = getSoundKindMeta(download.isSfx);

  return (
    <div className="kling-card">
      <div className="kling-card-preview">
        <DownloadCardPreview download={download} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="type-badge">{kindMeta.icon} {kindMeta.label}</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
          {download.qualityType && (
            <span className="stage-badge" title="Download quality">{download.qualityType.toUpperCase()}</span>
          )}
          {download.stemType && (
            <span className="stage-badge" title="Stem type">{download.stemType}</span>
          )}
        </div>
      </div>

      <h4 className="kling-card-prompt" title={download.assetTitle || ''}>
        {truncate(download.assetTitle, 90) || 'No title captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar name={download.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {download.ownerName || (download.ownerUserId ? `User #${download.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
        {/* remainingDownloads is an informational quota counter (how many
            downloads are left on the account), NOT a per-item credits cost -
            see epidemicCaptureUtils.js callers/constants.py's own confirmed
            sample response ("remainingDownloads": 1188). Rendered as quota
            context, never framed as what this one download "cost". */}
        {download.remainingDownloads != null ? `📦 ${formatCount(download.remainingDownloads)} downloads left in quota` : 'Quota not captured'}
        {' · '}
        {formatRelativeTime(download.downloadedAt)}
      </p>

      {(download.linkedTaskName || download.linkedClientName) && (
        <div className="kling-card-tags">
          {download.linkedTaskName && (
            <span className="kling-card-tag-chip" title="Linked task">📋 {download.linkedTaskName}</span>
          )}
          {download.linkedClientName && (
            <span className="kling-card-tag-chip" title="Linked client">🏢 {download.linkedClientName}</span>
          )}
        </div>
      )}
    </div>
  );
});

export default EpidemicDownloadCard;
