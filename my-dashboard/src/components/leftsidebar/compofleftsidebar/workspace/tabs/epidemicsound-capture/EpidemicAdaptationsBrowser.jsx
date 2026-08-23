import { useCallback, useEffect, useRef, useState } from 'react';
import { epidemicCaptureAPI } from '../../../../../../services/api';
import KlingCardSkeletonGrid from '../../../trending/kling/KlingCardSkeletonGrid';
import EpidemicAdaptationCard from './EpidemicAdaptationCard';
import { normalizeApiError } from './epidemicCaptureUtils';

const ADAPTATION_PAGE_SIZE = 24;

/**
 * The Adaptations browse mode of the Epidemic Sound Capture Center - mirrors
 * EpidemicDownloadsBrowser.jsx exactly (debounced search, pagination),
 * pointed at the /adaptations route and EpidemicAdaptationCard instead.
 * Adaptations are Epidemic Sound's prompt-based AI regeneration feature
 * (see EpidemicAdaptationCard.jsx's own header comment) - a second, opt-in
 * mode alongside the still-default Downloads mode, switched between in
 * EpidemicExplorerBody.jsx.
 */
export default function EpidemicAdaptationsBrowser({ searchInput, onTotalChange }) {
  const [adaptations, setAdaptations] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const loadAdaptations = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await epidemicCaptureAPI.listAdaptations({
          q: (searchInput || '').trim() || undefined,
          limit: ADAPTATION_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setAdaptations((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load adaptations.'));
      } finally {
        if (token === requestTokenRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [searchInput]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => loadAdaptations(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadAdaptations]);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || adaptations.length >= total) return;
    loadAdaptations(adaptations.length, { append: true });
  }, [adaptations.length, loadingMore, total, loadAdaptations]);

  return (
    <div>
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && adaptations.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">🎚</span>
          <strong>No adaptations captured yet</strong>
          <p>Open Epidemic Sound through the dashboard launcher with the extension active, then generate an adaptation of a track.</p>
        </div>
      )}

      {loading && adaptations.length === 0 ? (
        <KlingCardSkeletonGrid count={8} />
      ) : (
        <div>
          <div className="kling-virtual-grid-wrap kling-plain-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {adaptations.map((adaptation) => (
              <EpidemicAdaptationCard key={adaptation.id} adaptation={adaptation} />
            ))}
          </div>
          {loadingMore && (
            <div className="kling-virtual-loading-more">
              <KlingCardSkeletonGrid count={4} compact />
            </div>
          )}
          {adaptations.length < total && !loadingMore && (
            <button
              type="button"
              className="chatgpt-capture-secondary-btn"
              style={{ width: '100%', marginTop: 12 }}
              onClick={handleLoadMore}
            >
              Load more
            </button>
          )}
        </div>
      )}
    </div>
  );
}
