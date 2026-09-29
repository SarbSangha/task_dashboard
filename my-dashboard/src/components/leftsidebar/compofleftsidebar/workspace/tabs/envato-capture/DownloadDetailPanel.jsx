import { useCallback } from 'react';
import { UserAvatar } from '../../../../../common/UserAvatar';
import JsonViewer from './JsonViewer';
import {
  copyTextToClipboard,
  formatAbsoluteTime,
  getOwnershipStatusMeta,
} from './envatoCaptureUtils';
// Renders with Kling's drawer classes, same as GenerationDetailPanel.jsx.
import '../../../trending/kling/KlingGenerationDrawer.css';

// Downloads had no detail view at all until now - only GENERATIONS did
// (EnvatoGenerationDrawer/GenerationDetailPanel), so clicking a download card
// did nothing while clicking a generation card opened a drawer. Same gap
// exists in splice-capture and epidemicsound-capture, whose download cards
// are also inert; this is the first download-side detail panel, deliberately
// built to mirror GenerationDetailPanel.jsx's structure so the two read the
// same way.
//
// Unlike GenerationDetailPanel, this takes the already-loaded `download`
// object rather than an id + fetch: EnvatoDownload.to_dict already returns
// every field shown here in the LIST response (see providers/envato/models.py),
// so a per-item endpoint would be a redundant round trip for data the browser
// is holding. If a download ever gains detail-only fields, switch this to a
// fetch the way the generation panel does.

function MetaField({ label, value }) {
  if (value === null || value === undefined || value === '') return null;
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

// Same pageUrl-based classification the card uses (see DownloadCard.jsx's own
// comment for why pageUrl and not a media type: Envato's audio rows carry no
// thumbnail at all, so the URL is the only reliable signal).
function isEnvatoVideoDownload(download) {
  const url = `${download?.pageUrl || ''}`.toLowerCase();
  return url.includes('/video') || url.includes('/stock-video') || url.includes('/motion-graphics');
}

function isEnvatoAudioDownload(download) {
  const url = `${download?.pageUrl || ''}`.toLowerCase();
  return url.includes('/music') || url.includes('/sound-effect');
}

function DownloadPreview({ download }) {
  const mirroredUrl = download.mirroredAssetUrl;
  const imageUrl = download.assetThumbnailUrl;

  // Mirrored bytes are our own permanent R2 copy and are always preferred -
  // no lazy/viewport gating here (unlike the card), since a drawer shows
  // exactly one item and it is on screen by definition.
  if (mirroredUrl) {
    if (isEnvatoVideoDownload(download)) {
      return (
        <video
          src={mirroredUrl}
          poster={imageUrl || undefined}
          className="kling-drawer-preview-media"
          controls
          preload="metadata"
        />
      );
    }
    if (isEnvatoAudioDownload(download)) {
      return <audio src={mirroredUrl} className="kling-drawer-preview-media" controls preload="metadata" />;
    }
    return <img src={mirroredUrl} alt={download.assetTitle || 'Download'} className="kling-drawer-preview-media" />;
  }

  if (imageUrl) {
    return <img src={imageUrl} alt={download.assetTitle || 'Download'} className="kling-drawer-preview-media" />;
  }

  return (
    <div className="kling-drawer-preview-empty">
      {isEnvatoAudioDownload(download) ? '🎵 Audio — not mirrored' : 'No preview captured'}
    </div>
  );
}

export default function DownloadDetailPanel({ download }) {
  const copyTitle = useCallback(() => {
    if (download?.assetTitle) copyTextToClipboard(download.assetTitle);
  }, [download]);

  if (!download) return null;

  const ownershipMeta = getOwnershipStatusMeta(download.ownershipStatus);
  const ownerLabel = download.ownerName
    || (download.ownerUserId ? `User #${download.ownerUserId}` : 'Unclaimed');
  // itemPageUrl (derived server-side from itemUuid) is the only PERMANENT
  // reference to the item - it 302s to the item's real page and needs no
  // auth. Preferred over both assetSourceUrl (a signed CloudFront link that
  // expires in minutes) and pageUrl (whatever page the user happened to be
  // on when they downloaded, which is usually a listing like /music rather
  // than the item itself).
  const originalUrl = download.itemPageUrl || download.assetSourceUrl || download.pageUrl;

  return (
    <>
      <div className="kling-drawer-preview">
        <DownloadPreview download={download} />
      </div>

      <div className="kling-drawer-actions">
        {originalUrl && (
          <a
            className="kling-drawer-action-btn"
            href={originalUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Original
          </a>
        )}
        {download.mirroredAssetUrl && (
          <a
            className="kling-drawer-action-btn"
            href={download.mirroredAssetUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Download
          </a>
        )}
        <button
          type="button"
          className="kling-drawer-action-btn"
          onClick={copyTitle}
          disabled={!download.assetTitle}
        >
          Copy Title
        </button>
      </div>

      <div className="kling-drawer-section">
        <div className="kling-drawer-owner-row">
          <UserAvatar name={ownerLabel} size={36} />
          <div>
            <div className="kling-drawer-owner-name">{ownerLabel}</div>
            <div className="kling-drawer-owner-department">{ownershipMeta.label}</div>
          </div>
        </div>
      </div>

      <div className="kling-drawer-section">
        <h4>Title</h4>
        <p className="kling-drawer-prompt">{download.assetTitle || 'No title captured for this download.'}</p>
      </div>

      <div className="kling-drawer-section kling-drawer-metadata-grid">
        <MetaField label="Linked Task" value={download.linkedTaskName} />
        <MetaField label="Linked Client" value={download.linkedClientName} />
        <MetaField label="Item Type" value={download.itemType} />
        <MetaField label="Source" value={download.sourceHost} />
        <MetaField label="Search Term" value={download.searchTerm} />
        <MetaField label="Ownership" value={ownershipMeta.label} />
        <MetaField label="Downloaded" value={formatAbsoluteTime(download.downloadedAt)} />
        <MetaField label="Captured" value={formatAbsoluteTime(download.createdAt)} />
        <MetaField label="Item UUID" value={download.itemUuid} />
        <MetaField
          label="Item Page"
          value={
            download.itemPageUrl ? (
              <a href={download.itemPageUrl} target="_blank" rel="noopener noreferrer">
                Open on Envato
              </a>
            ) : null
          }
        />
        {/* Mirror status is the difference between "we have the bytes
            forever" and "this row points at a URL that needs Envato's own
            session" - worth surfacing, since the preview silently falls back
            to a thumbnail when mirroring never succeeded. */}
        <MetaField label="Asset Backup" value={download.assetMirrorStatus} />
        <MetaField label="Backup Attempted" value={formatAbsoluteTime(download.assetMirrorAttemptedAt)} />
        <MetaField label="Backup Error" value={download.assetMirrorError} />
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Raw Metadata</h4>
        <JsonViewer data={download.metadata} label="Captured download payload" collapsedByDefault />
      </div>
    </>
  );
}
