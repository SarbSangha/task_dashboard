import { useCallback, useEffect, useRef, useState } from 'react';
import { freepikCaptureAPI } from '../../../../../../services/api';
import FreepikGenerationGrid from './FreepikGenerationGrid';
import { normalizeApiError } from './freepikCaptureUtils';

const GENERATION_PAGE_SIZE = 24;

/**
 * Replaces the old list-row sidebar with a Kling-style card grid (see
 * FreepikGenerationCard.jsx/FreepikGenerationGrid.jsx) - fetch state lives
 * here, presentation lives in the grid, same split ChatGPT's
 * ConversationListSidebar keeps between itself and ConversationCard.
 * Search/ownership filters are controlled from FreepikExplorerBody (rendered
 * in its header, next to the All Generations/By Employee switcher) rather
 * than owned locally; `total` is reported back up via onTotalChange so that
 * same header can show "N generation(s)".
 */
export default function GenerationsBrowser({
  ownerUserId,
  ownerName,
  onBackToUsers,
  onOpenGeneration,
  searchInput,
  ownershipFilter,
  onTotalChange,
}) {
  const [generations, setGenerations] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const loadGenerations = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await freepikCaptureAPI.listGenerations({
          owner_user_id: ownerUserId || undefined,
          ownership_status: ownershipFilter || undefined,
          q: (searchInput || '').trim() || undefined,
          limit: GENERATION_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setGenerations((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load generations.'));
      } finally {
        if (token === requestTokenRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [ownerUserId, ownershipFilter, searchInput]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => loadGenerations(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadGenerations]);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || generations.length >= total) return;
    loadGenerations(generations.length, { append: true });
  }, [generations.length, loadingMore, total, loadGenerations]);

  return (
    <div>
      {ownerUserId && (
        <div className="chatgpt-capture-scoped-header">
          <button type="button" className="chatgpt-capture-back-btn" onClick={onBackToUsers}>
            ← All Employees
          </button>
          <span className="chatgpt-capture-scoped-header-name">{ownerName ? `${ownerName}'s generations` : 'Generations'}</span>
        </div>
      )}

      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && generations.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">🖼️</span>
          <strong>No generations captured yet</strong>
          <p>Open Freepik/Magnific through the dashboard launcher with the extension active, or widen your filters.</p>
        </div>
      )}

      <FreepikGenerationGrid
        generations={generations}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={generations.length < total}
        onLoadMore={handleLoadMore}
        onOpenGeneration={(generation) => onOpenGeneration(generation.id)}
      />
    </div>
  );
}
