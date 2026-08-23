import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, getOwnershipStatusMeta, truncate } from './spliceCaptureUtils';

// mirroredAssetUrl is our own permanent R2 copy of the actual downloaded
// audio bytes (same reasoning as epidemicsound-capture/EpidemicDownloadCard.jsx's
// own comment: Splice's real download response requires the browser's own
// authenticated session, so only the browser - which already legitimately
// received the bytes when the download happened - can ever supply this; the
// backend has no way to pull it independently). Every Splice download is a
// sample (.wav) - no image/video branch to consider, same as Epidemic
// Sound's card. Unlike Epidemic Sound there's no isSfx/Music-vs-SFX kind
// split to label, so the fallback tile just says "Sample" instead of a
// kind-specific label.
const DownloadCardPreview = React.memo(function DownloadCardPreview({ download }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const mirroredUrl = download.mirroredAssetUrl;

  if (mirroredUrl) {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          <audio src={mirroredUrl} controls preload="metadata" style={{ width: '100%' }} />
        ) : (
          <div className="kling-card-fallback">🎧 Sample</div>
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
      : 'Sample';

  return (
    <div ref={previewRef} className="kling-card-fallback">
      🎧 {statusLabel}
    </div>
  );
});

export const SpliceDownloadCard = React.memo(function SpliceDownloadCard({ download }) {
  const ownershipMeta = getOwnershipStatusMeta(download.ownershipStatus);

  return (
    <div className="kling-card">
      <div className="kling-card-preview">
        <DownloadCardPreview download={download} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="type-badge">🎧 Sample</span>
          <span className="stage-badge">{ownershipMeta.icon} {ownershipMeta.label}</span>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={download.assetTitle || ''}>
        {truncate(download.assetTitle, 90) || 'No title captured'}
      </h4>

      {download.sampleHash && (
        <p className="kling-card-meta" title={download.sampleHash}>
          Hash: {truncate(download.sampleHash, 24)}
        </p>
      )}

      <div className="kling-card-meta-row">
        <UserAvatar name={download.ownerName || 'Unclaimed'} size={22} />
        <span className="kling-card-owner-name">
          {download.ownerName || (download.ownerUserId ? `User #${download.ownerUserId}` : 'Unclaimed')}
        </span>
      </div>

      <p className="kling-card-meta">
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

export default SpliceDownloadCard;
