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

export function InboxSkeleton() {
  return (
    <div className="inbox-task-list" aria-hidden="true">
      {Array.from({ length: CARD_COUNT }).map((_, index) => (
        <div key={index} style={CARD_STYLE}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: 1, display: 'grid', gap: 8 }}>
              <SkeletonBlock width={index % 2 === 0 ? '70%' : '58%'} height={18} />
              <SkeletonBlock width="38%" height={12} />
            </div>
            <SkeletonBlock width={72} height={24} rounded />
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <SkeletonBlock width="100%" height={12} />
            <SkeletonBlock width="84%" height={12} />
            <SkeletonBlock width="62%" height={12} />
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <SkeletonBlock width={88} height={22} rounded />
            <SkeletonBlock width={108} height={22} rounded />
            <SkeletonBlock width={76} height={22} rounded />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              <SkeletonBlock width={34} height={34} rounded />
              <SkeletonBlock width={34} height={34} rounded />
            </div>
            <SkeletonBlock width={104} height={34} rounded />
          </div>
        </div>
      ))}
    </div>
  );
}
