import React from 'react';
import { useNearViewport } from '../../hooks/useNearViewport';

// Renders a provider capture card's admin-uploaded media (generation.adminMedia,
// see AdminCardActions.jsx) in place of the captured media. Uses the same
// kling-card-* / kling-drawer-* classes the provider cards and drawers already
// render with, so an edited card looks like any other.

// Card-grid tile. Same lazy-mount pattern as the provider cards' own previews:
// only cards near the viewport mount a media element, with preload="metadata".
export const AdminMediaCardPreview = React.memo(function AdminMediaCardPreview({ media }) {
  const [previewRef, isNearViewport] = useNearViewport();

  if (!isNearViewport) {
    return (
      <div ref={previewRef} className="kling-card-fallback">
        {media.kind === 'audio' ? '🔊 Audio' : media.kind === 'video' ? 'Video Preview' : 'Image Preview'}
      </div>
    );
  }

  return (
    <div ref={previewRef} className="kling-card-lazy-frame">
      {media.kind === 'audio' ? (
        // stopPropagation: the preview area opens the drawer, which would
        // otherwise also fire when using the player (see SunoGenerationCard).
        <audio
          src={media.url}
          controls
          preload="metadata"
          style={{ width: '100%' }}
          onClick={(event) => event.stopPropagation()}
        />
      ) : media.kind === 'video' ? (
        <video src={media.url} className="kling-card-image" muted playsInline preload="metadata" />
      ) : (
        <img src={media.url} alt={media.fileName || 'Uploaded media'} className="kling-card-image" loading="lazy" decoding="async" />
      )}
    </div>
  );
});

// Drawer hero, the kling-drawer-preview content.
export function AdminMediaDrawerPreview({ media }) {
  if (media.kind === 'audio') {
    return <audio src={media.url} className="kling-drawer-preview-media" controls preload="metadata" />;
  }
  if (media.kind === 'video') {
    return <video src={media.url} className="kling-drawer-preview-media" controls playsInline preload="metadata" />;
  }
  return <img src={media.url} alt={media.fileName || 'Uploaded media'} className="kling-drawer-preview-media" />;
}
