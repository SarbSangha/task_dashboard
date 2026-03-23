import React from 'react';
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

  const statusClass = showingCached || isRefreshing ? 'cached' : 'live';
  const stamp = showingCached ? cachedAt : liveUpdatedAt;
  const timeLabel = formatStatusTime(stamp);

  return (
    <div className={`cache-status-banner ${statusClass} ${className}`.trim()}>
      <div className="cache-status-copy">
        <span className="cache-status-badge">
          {showingCached || isRefreshing ? 'Cached Snapshot' : 'Live Data'}
        </span>
        <span className="cache-status-text">
          {showingCached ? cachedLabel : liveLabel}
          {timeLabel ? ` at ${timeLabel}` : ''}
        </span>
      </div>
      <div className="cache-status-side">
        {isRefreshing ? refreshingLabel : 'Latest sync complete'}
      </div>
    </div>
  );
};

export default CacheStatusBanner;
