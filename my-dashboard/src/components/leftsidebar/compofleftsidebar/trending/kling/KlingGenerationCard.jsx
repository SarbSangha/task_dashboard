import React, { useEffect, useState } from 'react';
import { UserAvatar } from '../../../../common/UserAvatar';
import { useNearViewport } from '../../../../../hooks/useNearViewport';
import { getGenerationMediaKind, truncateText } from './klingMedia';

const KlingCardPreview = React.memo(function KlingCardPreview({ generation, mediaKind }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [generation.canonicalAssetUrl]);

  if (!generation.canonicalAssetUrl || failed) {
    return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
  }

  if (mediaKind === 'image') {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          <img
            src={generation.canonicalAssetUrl}
            alt={truncateText(generation.promptText, 60) || 'Kling generation'}
            className="kling-card-image"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="kling-card-fallback">Image Preview</div>
        )}
      </div>
    );
  }

  if (mediaKind === 'video') {
    return (
      <div ref={previewRef} className="kling-card-lazy-frame">
        {isNearViewport ? (
          <video
            src={generation.canonicalAssetUrl}
            className="kling-card-image"
            muted
            preload="metadata"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="kling-card-fallback">Video Preview</div>
        )}
      </div>
    );
  }

  return <div ref={previewRef} className="kling-card-fallback">No preview</div>;
});

export const KlingGenerationCard = React.memo(function KlingGenerationCard({
  generation,
  isMenuOpen,
  onToggleMenu,
  onOpenDrawer,
  onToggleFavorite,
  isFavoritePending,
}) {
  const mediaKind = getGenerationMediaKind(generation);
  const ownershipLabel = generation.ownershipStatus === 'resolved' ? 'Resolved' : 'Unknown';

  return (
    <div className={`kling-card ${isMenuOpen ? 'menu-open' : ''}`}>
      <div className="kling-card-preview" onClick={() => onOpenDrawer(generation)}>
        <KlingCardPreview generation={generation} mediaKind={mediaKind} />
        <button
          type="button"
          className={`kling-card-favorite ${generation.isFavorite ? 'active' : ''}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggleFavorite(generation);
          }}
          disabled={isFavoritePending}
          aria-label={generation.isFavorite ? 'Remove favorite' : 'Add favorite'}
          title={generation.isFavorite ? 'Remove favorite' : 'Add favorite'}
        >
          {generation.isFavorite ? '★' : '☆'}
        </button>
      </div>

      <div className="kling-card-top">
        <div className="kling-card-top-left">
          <span className={`type-badge ${mediaKind}`}>{mediaKind}</span>
          <span className="stage-badge">{ownershipLabel}</span>
        </div>
        <div className="kling-card-menu-wrap">
          <button
            type="button"
            className="trendings-card-menu-btn kling-card-menu-trigger"
            onClick={(event) => {
              event.stopPropagation();
              onToggleMenu(generation, event.currentTarget.getBoundingClientRect(), event.currentTarget);
            }}
            aria-haspopup="menu"
            aria-expanded={isMenuOpen}
            aria-label="More actions"
            title="More"
          >
            &#8942;
          </button>
        </div>
      </div>

      <h4 className="kling-card-prompt" title={generation.promptText || ''} onClick={() => onOpenDrawer(generation)}>
        {truncateText(generation.promptText, 90) || 'No prompt captured'}
      </h4>

      <div className="kling-card-meta-row">
        <UserAvatar avatar={generation.ownerAvatar} name={generation.ownerName || 'Unknown user'} size={22} />
        <span className="kling-card-owner-name">{generation.ownerName || 'Unknown user'}</span>
      </div>

      <p className="kling-card-meta">
        {generation.projectName || 'Ungrouped'}
      </p>

      {Array.isArray(generation.tags) && generation.tags.length > 0 && (
        <div className="kling-card-tags">
          {generation.tags.slice(0, 2).map((tag) => (
            <span key={tag} className="kling-card-tag-chip">
              {tag}
            </span>
          ))}
          {generation.tags.length > 2 && (
            <span className="kling-card-tag-chip kling-card-tag-chip-overflow">+{generation.tags.length - 2}</span>
          )}
        </div>
      )}
    </div>
  );
});
