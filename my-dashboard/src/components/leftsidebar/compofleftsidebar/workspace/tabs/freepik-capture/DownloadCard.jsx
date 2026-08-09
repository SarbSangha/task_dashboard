import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, truncate } from './freepikCaptureUtils';

// Visual twin of FreepikGenerationCard.jsx's own kling-card* styling, fed
// from FreepikDownload instead of FreepikGeneration - see
// providers/freepik/models.py's FreepikDownload docstring for why this is a
// separate table. No mirrored/expiring-token fallback chain the way
// FreepikCardPreview has (see FreepikGenerationCard.jsx) - assetThumbnailUrl
// is a raw scraped stock-image URL, unconfirmed whether it expires the same
// way a generated asset's signed URL does; not addressed yet (see this
// feature's own memory note on the gap).
const DownloadCardPreview = React.memo(function DownloadCardPreview({ download }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const imageUrl = download.assetThumbnailUrl;

  if (!imageUrl) {
    return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        <img
          src={imageUrl}
          alt={truncate(download.assetTitle, 60) || 'Downloaded stock asset'}
          className="kling-card-image"
          loading="lazy"
          decoding="async"
          fetchPriority="low"
        />
      ) : (
        <div className="kling-card-fallback">Image Preview</div>
      )}
    </div>
  );
});

export const DownloadCard = React.memo(function DownloadCard({ download }) {
  return (
    <div className="kling-card">
      <div className="kling-card-preview">
        <DownloadCardPreview download={download} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="type-badge">{download.sourceHost || 'stock'}</span>
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
        {download.searchTerm ? `🔎 ${truncate(download.searchTerm, 40)}` : 'No search term recorded'}
        {' · '}
        {formatRelativeTime(download.downloadedAt || download.createdAt)}
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

export default DownloadCard;
