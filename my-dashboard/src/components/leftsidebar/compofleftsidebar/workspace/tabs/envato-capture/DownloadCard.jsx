import React from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { formatRelativeTime, truncate } from './envatoCaptureUtils';

// Confirmed live 2026-08-14: a Music/Sound Effects download's assetThumbnailUrl
// is genuinely always null, not a scraping failure - Envato's own row for an
// audio track shows a waveform/play control in place of the <img> thumbnail
// every Photos/Video/Graphics row has (see content-envato-elements-capture.js's
// findEnvatoElementsDownloadCardContainer comment), so there is nothing to
// scrape. pageUrl (captured alongside every download - see EnvatoDownload.to_dict)
// reliably distinguishes "no thumbnail because it's audio" (expected, still
// worth a distinct icon) from "no thumbnail for some other reason" (the
// plain "No preview" case every other provider card also falls back to).
function isEnvatoAudioDownload(download) {
  const url = `${download.pageUrl || ''}`.toLowerCase();
  return url.includes('/music') || url.includes('/sound-effect');
}

// mirroredAssetUrl is our own permanent R2 copy of the actual downloaded
// audio/video bytes (see providers/envato/router.py's capture_download_media
// and content-envato-elements-network.js) - Envato's real download/stream
// response requires the browser's own authenticated session, so only the
// browser (which already legitimately received the bytes when Play/Download
// was clicked) can ever supply this; the backend has no way to pull it
// independently. Preferred over the static thumbnail/fallback tile whenever
// it exists - a downloaded item is either playable (mirrored) or shows the
// same static tiles as before, never both.
function isEnvatoVideoDownload(download) {
  const url = `${download.pageUrl || ''}`.toLowerCase();
  return url.includes('/video') || url.includes('/stock-video') || url.includes('/motion-graphics');
}

// Visual twin of EnvatoGenerationCard.jsx's own kling-card* styling, fed
// from EnvatoDownload instead - mirrors freepik-capture/DownloadCard.jsx
// exactly. No mirrored/expiring-token fallback chain for assetThumbnailUrl -
// it's a raw scraped stock-image URL, unconfirmed whether/how it expires
// (this capture was built without a confirmed HAR of Envato Elements' own
// Download button - see content-envato-elements-capture.js's own header).
const DownloadCardPreview = React.memo(function DownloadCardPreview({ download }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const imageUrl = download.assetThumbnailUrl;
  const mirroredUrl = download.mirroredAssetUrl;

  if (mirroredUrl) {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          isEnvatoVideoDownload(download) ? (
            <video src={mirroredUrl} poster={imageUrl || undefined} className="kling-card-image" controls preload="metadata" />
          ) : (
            <audio src={mirroredUrl} controls preload="metadata" style={{ width: '100%' }} />
          )
        ) : (
          <div className="kling-card-fallback">{isEnvatoVideoDownload(download) ? '🎬 Video' : '🎵 Audio'}</div>
        )}
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div ref={previewRef} className="kling-card-fallback">
        {isEnvatoAudioDownload(download) ? '🎵 Audio' : 'No preview'}
      </div>
    );
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
          <span className="type-badge">{download.itemType || download.sourceHost || 'stock'}</span>
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
