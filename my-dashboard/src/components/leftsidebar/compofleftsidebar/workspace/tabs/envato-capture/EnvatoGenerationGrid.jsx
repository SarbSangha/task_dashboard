import { EnvatoGenerationCard } from './EnvatoGenerationCard';
import KlingCardSkeletonGrid from '../../../trending/kling/KlingCardSkeletonGrid';

// Plain responsive CSS grid, not virtualized - mirrors
// freepik-capture/FreepikGenerationGrid.jsx exactly (see its own comment for
// why virtualization isn't needed at this volume).
export default function EnvatoGenerationGrid({ generations, loading, loadingMore, hasMore, onLoadMore, onOpenGeneration }) {
  if (loading && generations.length === 0) {
    return <KlingCardSkeletonGrid count={8} />;
  }

  return (
    <div>
      <div className="kling-virtual-grid-wrap kling-plain-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
        {generations.map((generation) => (
          <EnvatoGenerationCard key={generation.id} generation={generation} onOpen={onOpenGeneration} />
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
