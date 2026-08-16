import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { elevenlabsCaptureAPI } from '../../../../../../services/api';
import ElevenLabsGenerationGrid from './ElevenLabsGenerationGrid';
import { normalizeApiError } from './elevenlabsCaptureUtils';

const GENERATION_PAGE_SIZE = 24;

// Mirrors flow-capture/GenerationsBrowser.jsx's fetch/paginate/debounce
// pattern. One real difference from Flow: GET /api/providers/elevenlabs/
// generations does NOT accept a `q` free-text search param (only
// owner_user_id/source/linked_task_id/linked_client_id/limit/offset - see
// providers/elevenlabs/router.py's list_generations signature), so
// `searchInput` is never sent to the server here. Instead it's applied as a
// client-side substring filter over whatever page of generations is already
// loaded (prompt match, case-insensitive) - cheap, no extra endpoint needed,
// and keeps the header search box from being dead weight. The trade-off:
// `total`/"Load more" still reflect the *server's* unfiltered count, so a
// narrow search can show fewer visible cards than the "N generation(s)"
// header while more matches could exist further down un-loaded pages - an
// acceptable v1 limitation given the backend has no server-side search for
// this provider.
export default function GenerationsBrowser({
  searchInput,
  taskFilter,
  clientFilter,
  downloadedOnly,
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
        const response = await elevenlabsCaptureAPI.listGenerations({
          linked_task_id: taskFilter || undefined,
          linked_client_id: clientFilter || undefined,
          downloaded: downloadedOnly || undefined,
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
    [taskFilter, clientFilter, downloadedOnly]
  );

  useEffect(() => {
    loadGenerations(0, { append: false });
  }, [loadGenerations]);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || generations.length >= total) return;
    loadGenerations(generations.length, { append: true });
  }, [generations.length, loadingMore, total, loadGenerations]);

  const trimmedSearch = (searchInput || '').trim().toLowerCase();
  const visibleGenerations = useMemo(() => {
    if (!trimmedSearch) return generations;
    return generations.filter((generation) => (generation.prompt || '').toLowerCase().includes(trimmedSearch));
  }, [generations, trimmedSearch]);

  return (
    <div>
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && generations.length === 0 && downloadedOnly && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">⬇️</span>
          <strong>No downloads captured yet</strong>
          <p>Generations show up here once their Download button is actually clicked in ElevenLabs.</p>
        </div>
      )}

      {!loading && !error && generations.length === 0 && !downloadedOnly && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">✨</span>
          <strong>No generations captured yet</strong>
          <p>Open ElevenLabs through the dashboard launcher with the extension active, or widen your filters.</p>
        </div>
      )}

      {!loading && !error && generations.length > 0 && trimmedSearch && visibleGenerations.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">🔍</span>
          <strong>No prompts match "{searchInput.trim()}" on this page</strong>
          <p>Load more generations or clear the search to see everything already fetched.</p>
        </div>
      )}

      <ElevenLabsGenerationGrid
        generations={visibleGenerations}
        loading={loading}
        loadingMore={loadingMore}
        hasMore={generations.length < total}
        onLoadMore={handleLoadMore}
        onOpenGeneration={(generation) => onOpenGeneration(generation.id)}
      />
    </div>
  );
}
