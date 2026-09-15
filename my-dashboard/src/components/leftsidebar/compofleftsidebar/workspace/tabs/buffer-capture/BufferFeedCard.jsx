import React, { useState } from 'react';
import { useNearViewport } from '../../../../../../hooks/useNearViewport';
import { buildFileDownloadUrl, buildFileOpenUrl, buildFileThumbnailUrl, openUrlInNewTab } from '../../../../../../utils/fileLinks';
import { formatRelativeTime, getKindMeta, getMediaTypeMeta, providerLabel, truncate } from './bufferCaptureUtils';
import BufferDownloadGateModal from './BufferDownloadGateModal';

// Same line-icon language as common/WindowControls.jsx (16x16 viewBox,
// stroke="currentColor") rather than emoji - keeps the card's action row
// looking like the rest of this app's chrome instead of a mix of glyphs
// that render differently per OS/browser.
const DownloadIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 2v7" />
    <path d="M5 6l3 3 3-3" />
    <path d="M3 11.5v1A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5v-1" />
  </svg>
);

const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 2.5a1.5 1.5 0 0 1 2 2L5.5 12 2.5 13l1-3 7.5-7.5Z" />
  </svg>
);

const DeleteIcon = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 4.5h10" />
    <path d="M6 4.5V3a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
    <path d="M4.5 4.5 5 13a1.5 1.5 0 0 0 1.5 1.4h3A1.5 1.5 0 0 0 11 13l.5-8.5" />
    <path d="M6.7 7v4" />
    <path d="M9.3 7v4" />
  </svg>
);

// Visual twin of envato-capture/EnvatoGenerationCard.jsx - same .kling-card*
// classes so it reads as one card system with every other capture tab, fed
// from the merged BufferFeedItem shape instead of one provider's own model.
//
// Goes through /api/files/thumbnail/open (utils/fileLinks.js) rather than
// item.assetUrl directly - self-upload assets live in a private R2 bucket
// (same as every task attachment in this app), so the raw asset URL 404s/
// 403s without a signed proxy. Every other provider's assetUrl is already a
// public CDN link on their own domain, and that endpoint transparently
// redirects straight through for those (see its own fallback in
// routers/upload.py), so this is safe to do unconditionally.
const BufferCardPreview = React.memo(function BufferCardPreview({ item }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const [isPlaying, setIsPlaying] = useState(false);
  const mediaMeta = getMediaTypeMeta(item.mediaType);

  // Audio/video: play inline before anyone commits to downloading a copy -
  // clicking swaps the fallback tile for a native <audio>/<video> element,
  // streamed straight from the signed /api/files/open URL (which just
  // redirects to R2/the provider's own CDN, both of which serve Range
  // requests natively, so seeking works with no extra backend work).
  //
  // controlsList="nodownload" + blocking the right-click context menu:
  // Chrome's native <audio>/<video> controls have their own "Download" menu
  // item that saves the raw file with zero involvement from this app - that
  // would let anyone sidestep the client/purpose gate below entirely just
  // by playing the clip first. Firefox/Safari don't expose that menu item
  // at all, so this is a no-op there, not a regression.
  if (item.mediaType === 'audio' || item.mediaType === 'video') {
    if (!item.assetUrl) {
      return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
    }

    if (isPlaying) {
      const mediaUrl = buildFileOpenUrl({ url: item.assetUrl, path: item.filePath }) || item.assetUrl;
      return (
        <div ref={previewRef} className="bsu-inline-player" onClick={(event) => event.stopPropagation()}>
          {item.mediaType === 'video' ? (
            <video
              src={mediaUrl}
              controls
              autoPlay
              controlsList="nodownload"
              onContextMenu={(event) => event.preventDefault()}
              className="bsu-inline-video"
            />
          ) : (
            <div className="bsu-inline-audio-wrap">
              <span className="bsu-inline-audio-icon" aria-hidden="true">
                <svg width="24" height="24" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M6 12.5a1.75 1.75 0 1 1-1.75-1.75" />
                  <path d="M6 12.5V4l6.5-1.5v7.25" />
                  <path d="M12.5 11.25a1.75 1.75 0 1 1-1.75-1.75" />
                </svg>
              </span>
              <audio
                src={mediaUrl}
                controls
                autoPlay
                controlsList="nodownload"
                onContextMenu={(event) => event.preventDefault()}
                className="bsu-inline-audio"
              />
            </div>
          )}
        </div>
      );
    }

    return (
      <button
        ref={previewRef}
        type="button"
        className="kling-card-fallback bsu-play-trigger"
        onClick={(event) => {
          event.stopPropagation();
          setIsPlaying(true);
        }}
        aria-label={`Play ${mediaMeta.label.toLowerCase()}`}
      >
        <span className="bsu-play-icon" aria-hidden="true">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.5 3.2c0-.9 1-1.4 1.7-.9l7 4.8a1.1 1.1 0 0 1 0 1.8l-7 4.8c-.7.5-1.7 0-1.7-.9V3.2Z" />
          </svg>
        </span>
        <span>{mediaMeta.icon} {mediaMeta.label}</span>
      </button>
    );
  }

  if (item.mediaType !== 'image') {
    return (
      <div ref={previewRef} className="kling-card-fallback">
        {mediaMeta.icon} {mediaMeta.label}
      </div>
    );
  }

  if (!item.assetUrl) {
    return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
  }

  const thumbUrl = buildFileThumbnailUrl({ url: item.assetUrl, path: item.filePath }, 360) || item.assetUrl;

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {isNearViewport ? (
        <img
          src={thumbUrl}
          alt={truncate(item.title, 60) || 'Buffer asset'}
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

// onDelete/onRename are optional - only the "My uploads" list inside the
// Self Upload tab passes them (managing a captured generation/download
// isn't something this card supports, since those rows belong to the
// provider's own capture flow, not to the person looking at the Buffer
// feed - only a self-upload is something the viewer might own).
export const BufferFeedCard = React.memo(function BufferFeedCard({ item, onDelete, onRename }) {
  const kindMeta = getKindMeta(item.kind);
  const [showDownloadGate, setShowDownloadGate] = useState(false);
  const isSelfUpload = item.provider === 'self-upload' && item.rawId;

  // Looking at something (the thumbnail, playing audio/video, opening an
  // image full-size) is free - no client/purpose needed just to preview.
  // Only an actual download (see handleDownloadClick below) is gated for a
  // self-upload, since that's the point someone actually takes a copy of
  // it for real use.
  const viewAsset = () => {
    if (item.mediaType === 'audio' || item.mediaType === 'video') return; // handled by the inline player itself
    const openUrl = buildFileOpenUrl({ url: item.assetUrl, path: item.filePath }) || item.assetUrl;
    if (openUrl) {
      window.open(openUrl, '_blank', 'noopener,noreferrer');
    }
  };

  const handleDownloadClick = (event) => {
    event.stopPropagation();
    if (isSelfUpload) {
      // A self-upload has no client/purpose of its own (unlike every
      // provider's own captured row, gated behind the Task/Client picker at
      // capture time) - collect both right before the file actually saves.
      setShowDownloadGate(true);
      return;
    }
    const downloadUrl = buildFileDownloadUrl({ url: item.assetUrl, path: item.filePath }, item.title);
    if (downloadUrl) {
      openUrlInNewTab(downloadUrl);
    }
  };

  return (
    <div className="kling-card">
      <div className="kling-card-preview" onClick={viewAsset}>
        <BufferCardPreview item={item} />
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className="stage-badge">{kindMeta.icon} {kindMeta.label}</span>
        </div>
        <div className="bsu-card-actions" role="group" aria-label="File actions">
          <button
            type="button"
            className="bsu-card-action-btn bsu-card-action-btn--download"
            aria-label="Download this file"
            title="Download"
            onClick={handleDownloadClick}
          >
            <DownloadIcon />
          </button>
          {onRename && (
            <button
              type="button"
              className="bsu-card-action-btn bsu-card-action-btn--edit"
              aria-label="Rename or tag this upload"
              title="Rename / tags"
              onClick={(event) => {
                event.stopPropagation();
                onRename(item);
              }}
            >
              <EditIcon />
            </button>
          )}
          {onDelete && (
            <button
              type="button"
              className="bsu-card-action-btn bsu-card-action-btn--delete"
              aria-label="Delete this upload"
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                onDelete(item);
              }}
            >
              <DeleteIcon />
            </button>
          )}
        </div>
      </div>

      <h4 className="kling-card-prompt" title={item.title || ''} onClick={viewAsset}>
        {truncate(item.title, 90) || 'Untitled'}
      </h4>

      {Array.isArray(item.tags) && item.tags.length > 0 && (
        <div className="bsu-card-tags">
          {item.tags.map((tag) => (
            <span key={tag} className="bsu-card-tag">{tag}</span>
          ))}
        </div>
      )}

      <p className="kling-card-meta">
        {providerLabel(item.provider)}
        {' · '}
        {formatRelativeTime(item.createdAt)}
        {/* ownerName is resolved server-side (utils/buffer_feed.py's
            _resolve_owner_names) - falls back to the bare id only if that
            resolution somehow came back empty (e.g. a deleted user). */}
        {item.ownerName ? ` · ${item.ownerName}` : item.ownerUserId ? ` · User #${item.ownerUserId}` : ''}
      </p>

      {showDownloadGate && (
        <BufferDownloadGateModal item={item} onClose={() => setShowDownloadGate(false)} />
      )}
    </div>
  );
});

export default BufferFeedCard;
