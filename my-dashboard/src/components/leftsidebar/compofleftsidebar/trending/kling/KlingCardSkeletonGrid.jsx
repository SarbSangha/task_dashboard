import React from 'react';
import { SkeletonBlock } from '../../../../ui/Skeleton';

function KlingCardSkeleton({ compact }) {
  return (
    <div className="kling-card kling-card-skeleton">
      <SkeletonBlock height={compact ? 90 : 160} rounded className="kling-card-skeleton-preview" />
      <div className="kling-card-skeleton-row">
        <SkeletonBlock width={54} height={18} rounded />
        <SkeletonBlock width={64} height={18} rounded />
      </div>
      <SkeletonBlock height={14} width="90%" style={{ marginTop: 10 }} />
      {!compact && <SkeletonBlock height={14} width="70%" style={{ marginTop: 6 }} />}
      <div className="kling-card-skeleton-row" style={{ marginTop: 12 }}>
        <SkeletonBlock width={22} height={22} rounded />
        <SkeletonBlock width={90} height={12} />
      </div>
    </div>
  );
}

export default function KlingCardSkeletonGrid({ count = 12, compact = false }) {
  const items = Array.from({ length: count }, (_, index) => index);
  return (
    <div className={`kling-projects-grid kling-skeleton-grid ${compact ? 'kling-skeleton-grid-compact' : ''}`}>
      {items.map((index) => (
        <KlingCardSkeleton key={index} compact={compact} />
      ))}
    </div>
  );
}
