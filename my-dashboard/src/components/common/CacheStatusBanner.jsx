import './CacheStatusBanner.css';

const formatStatusTime = (value) => {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
};

/**
 * Small "Synced 2:44 am" / "Refreshing…" chip. The full sentence (the
 * per-panel labels) stays available as a tooltip and to screen readers.
 */
const CacheStatusBanner = ({
  showingCached = false,
  isRefreshing = false,
  cachedAt = 0,
  liveUpdatedAt = 0,
  refreshingLabel = 'Refreshing latest data...',
  liveLabel = 'Up to date',
  cachedLabel = 'Showing cached data',
  className = '',
}) => {
  const hasAnyStatus = showingCached || isRefreshing || !!liveUpdatedAt;
  if (!hasAnyStatus) return null;

  const state = isRefreshing ? 'refreshing' : showingCached ? 'cached' : 'live';
  const timeLabel = formatStatusTime(showingCached ? cachedAt : liveUpdatedAt);
  const shortLabel = {
    refreshing: 'Refreshing…',
    cached: timeLabel ? `Saved copy · ${timeLabel}` : 'Saved copy',
    live: timeLabel ? `Synced ${timeLabel}` : 'Synced',
  }[state];
  const detail = state === 'refreshing'
    ? refreshingLabel
    : `${showingCached ? cachedLabel : liveLabel}${timeLabel ? ` at ${timeLabel}` : ''}`;

  return (
    <div
      className={`cache-status-banner ${state} ${className}`.trim()}
      role="status"
      aria-live="polite"
      aria-label={detail}
      title={detail}
    >
      <span className="cache-status-dot" aria-hidden="true" />
      <span className="cache-status-text">{shortLabel}</span>
    </div>
  );
};

export default CacheStatusBanner;
