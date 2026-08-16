import { useCallback, useEffect, useRef, useState } from 'react';
import { flowCaptureAPI } from '../../../../../../services/api';
import FlowGenerationGrid from './FlowGenerationGrid';
import { normalizeApiError } from './flowCaptureUtils';

const GENERATION_PAGE_SIZE = 24;

// Mirrors envato-capture/GenerationsBrowser.jsx's fetch/paginate/debounce
// pattern, trimmed to the filters Flow's backend actually supports
// (owner_user_id, linked_task_id, linked_client_id, q - no ownership_status/
// item_type query params on GET /api/providers/flow/generations).
export default function GenerationsBrowser({
  searchInput,
  taskFilter,
  clientFilter,
  onTotalChange,
  onOpenGeneration,
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
        const response = await flowCaptureAPI.listGenerations({
          linked_task_id: taskFilter || undefined,
          linked_client_id: clientFilter || undefined,
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
    [taskFilter, clientFilter, searchInput]
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
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && generations.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">✨</span>
          <strong>No generations captured yet</strong>
          <p>Open Flow through the dashboard launcher with the extension active, or widen your filters.</p>
        </div>
      )}

      <FlowGenerationGrid
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
