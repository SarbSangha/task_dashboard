import { SkeletonBlock } from './Skeleton';

const ROW_COUNT = 6;

export function TrackingPanelSkeleton() {
  return (
    <div className="tasks-grid" aria-hidden="true">
      {Array.from({ length: ROW_COUNT }).map((_, index) => (
        <div key={index} className="tracking-task-card">
          <SkeletonBlock width={4} height={64} rounded />

          <div className="task-info" style={{ display: 'grid', gap: 8 }}>
            <SkeletonBlock width={index % 2 === 0 ? '48%' : '62%'} height={14} />
            <SkeletonBlock width={116} height={11} />
            <div className="task-meta">
              <SkeletonBlock width={132} height={20} rounded />
              <SkeletonBlock width={92} height={20} rounded />
            </div>
          </div>

          <SkeletonBlock width={36} height={36} rounded />
          <SkeletonBlock width={32} height={32} rounded />
        </div>
      ))}
    </div>
  );
}
