import { FreepikGenerationCard } from './FreepikGenerationCard';
import KlingCardSkeletonGrid from '../../../trending/kling/KlingCardSkeletonGrid';

/**
 * Plain responsive CSS grid, not react-window virtualization like Kling's
 * KlingGenerationGrid.jsx - Freepik's expected volume (one shared account,
 * organic + a bounded reconciliation walk) doesn't call for virtualizing
 * thousands of DOM nodes the way Kling's company-wide history does, so this
 * keeps the same "kling-card" visual language without replicating the
 * virtualization machinery. Reuses Kling's own skeleton-grid component for
 * the loading state so the empty/loading feel matches too.
 */
export default function FreepikGenerationGrid({ generations, loading, loadingMore, hasMore, onLoadMore, onOpenGeneration }) {
  if (loading && generations.length === 0) {
    return <KlingCardSkeletonGrid count={8} />;
  }

  return (
    <div>
      <div className="kling-virtual-grid-wrap" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {generations.map((generation) => (
          <FreepikGenerationCard key={generation.id} generation={generation} onOpen={onOpenGeneration} />
        ))}
      </div>
      {loadingMore && (
        <div className="kling-virtual-loading-more">
          <KlingCardSkeletonGrid count={4} compact />
        </div>
      )}
      {hasMore && !loadingMore && (
        <button
          type="button"
          className="chatgpt-capture-secondary-btn"
          style={{ width: '100%', marginTop: 12 }}
          onClick={onLoadMore}
        >
          Load more
        </button>
      )}
    </div>
  );
}
