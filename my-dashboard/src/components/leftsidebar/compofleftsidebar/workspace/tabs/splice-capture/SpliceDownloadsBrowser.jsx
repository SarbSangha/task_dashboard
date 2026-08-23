import { useCallback, useEffect, useRef, useState } from 'react';
import { spliceCaptureAPI } from '../../../../../../services/api';
import KlingCardSkeletonGrid from '../../../trending/kling/KlingCardSkeletonGrid';
import SpliceDownloadCard from './SpliceDownloadCard';
import { normalizeApiError } from './spliceCaptureUtils';

const DOWNLOAD_PAGE_SIZE = 24;

/**
 * The (only) browse view of the Splice Capture Center - mirrors
 * epidemicsound-capture/EpidemicDownloadsBrowser.jsx exactly. Splice
 * (splice.com) is a sample/loop library, not an AI generator - there is no
 * "generations"/"adaptations" concept at all, so this is the tab's entire
 * content, not one mode among several.
 */
export default function SpliceDownloadsBrowser({ searchInput, onTotalChange }) {
  const [downloads, setDownloads] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const loadDownloads = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await spliceCaptureAPI.listDownloads({
          q: (searchInput || '').trim() || undefined,
          limit: DOWNLOAD_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setDownloads((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load downloads.'));
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
    const timer = window.setTimeout(() => loadDownloads(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadDownloads]);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || downloads.length >= total) return;
    loadDownloads(downloads.length, { append: true });
  }, [downloads.length, loadingMore, total, loadDownloads]);

  return (
    <div>
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && downloads.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">⬇️</span>
          <strong>No downloads captured yet</strong>
          <p>Open Splice through the dashboard launcher with the extension active, then download a sample.</p>
        </div>
      )}

      {loading && downloads.length === 0 ? (
        <KlingCardSkeletonGrid count={8} />
      ) : (
        <div>
          <div className="kling-virtual-grid-wrap kling-plain-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
            {downloads.map((download) => (
              <SpliceDownloadCard key={download.id} download={download} />
            ))}
          </div>
          {loadingMore && (
            <div className="kling-virtual-loading-more">
              <KlingCardSkeletonGrid count={4} compact />
            </div>
          )}
          {downloads.length < total && !loadingMore && (
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
