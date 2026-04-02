import { SkeletonBlock } from './Skeleton';

const CARD_COUNT = 4;
const CARD_STYLE = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  background: 'rgba(255, 255, 255, 0.05)',
  border: '1px solid rgba(255, 255, 255, 0.1)',
  borderRadius: 12,
  boxSizing: 'border-box',
};

export function OutboxSkeleton({ count = CARD_COUNT }) {
  return (
    <div
      className="outbox-task-grid"
      aria-hidden="true"
      style={{ pointerEvents: 'none' }}
    >
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <SkeletonBlock width={index % 2 === 0 ? '62%' : '54%'} height={18} />
            <SkeletonBlock width={76} height={24} rounded />
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <SkeletonBlock width="78%" height={12} />
            <SkeletonBlock width="52%" height={12} />
          </div>

          <div style={{ height: 1, background: 'rgba(255, 255, 255, 0.08)' }} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <SkeletonBlock width={86} height={30} rounded />
              <SkeletonBlock width={96} height={30} rounded />
            </div>
            <SkeletonBlock width={34} height={34} rounded />
          </div>
        </div>
      ))}
    </div>
  );
}
