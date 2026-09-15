import { useCallback, useEffect, useRef, useState } from 'react';
import { bufferAPI } from '../../../../../../services/api';
import BufferFeedGrid from './BufferFeedGrid';
import BufferSelfUploadTab from './BufferSelfUploadTab';
import { MEDIA_TYPE_META, normalizeApiError } from './bufferCaptureUtils';
// Reuses the same card/grid/empty-state CSS every other capture tab already
// shares (see envato-capture/EnvatoExplorerBody.jsx's own comment for why).
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import './BufferExplorerBody.css';

const PAGE_SIZE = 24;
const MEDIA_TYPE_ORDER = ['all', 'image', 'video', 'audio', 'other'];
const SECTIONS = [
  { key: 'feed', label: 'Feed', icon: '📦' },
  { key: 'self-upload', label: 'Self Upload', icon: '📤' },
];

/**
 * The Buffer tab - a cross-tool feed of every generation/download tagged
 * with the "Buffer" GenerationClient (picked from the same Task/Client
 * picker every provider's capture flow gates Generate/Download behind).
 * Unlike every other tab here, this one isn't one provider's own table - it
 * fans out across all of them server-side (see backend/utils/buffer_feed.py)
 * and is filtered here by media type (image/video/audio/other) rather than
 * by provider, since "what kind of asset is this" is the more useful
 * question once you're looking at everything in one place.
 *
 * Sits above two sections: the read-only cross-tool Feed (below), and Self
 * Upload (BufferSelfUploadTab) - a way for a user to add a file into Buffer
 * directly for something no provider's capture flow could tag with the
 * Buffer client. Self-uploads show up back here in Feed too, since
 * buffer_feed.py fans them in like every other source.
 */
export default function BufferExplorerBody({ searchInput = '' }) {
  const [section, setSection] = useState('feed');
  const [items, setItems] = useState([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState({ all: 0, image: 0, video: 0, audio: 0, other: 0 });
  const [mediaTypeFilter, setMediaTypeFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const loadFeed = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await bufferAPI.getFeed({
          media_type: mediaTypeFilter === 'all' ? undefined : mediaTypeFilter,
          q: (searchInput || '').trim() || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setItems((prev) => (append ? [...prev, ...(response.items || [])] : response.items || []));
        setTotal(response.total || 0);
        if (response.counts) setCounts(response.counts);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load the Buffer feed.'));
      } finally {
        if (token === requestTokenRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [mediaTypeFilter, searchInput]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => loadFeed(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadFeed]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || items.length >= total) return;
    loadFeed(items.length, { append: true });
  }, [items.length, loadingMore, total, loadFeed]);

  return (
    <div>
      <div className="buffer-section-row" role="tablist" aria-label="Buffer section">
        {SECTIONS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={section === tab.key}
            className={`buffer-section-tab ${section === tab.key ? 'active' : ''}`}
            onClick={() => setSection(tab.key)}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {section === 'self-upload' ? (
        <BufferSelfUploadTab />
      ) : (
        <>
          <div className="buffer-filter-row" role="tablist" aria-label="Filter Buffer feed by media type">
            {MEDIA_TYPE_ORDER.map((key) => {
              const meta = key === 'all' ? { label: 'All', icon: '📦' } : MEDIA_TYPE_META[key];
              const isActive = mediaTypeFilter === key;
              return (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={`buffer-filter-chip ${isActive ? 'active' : ''}`}
                  onClick={() => setMediaTypeFilter(key)}
                >
                  <span>{meta.icon}</span>
                  <span>{meta.label}</span>
                  <span className="buffer-filter-chip-count">{counts[key] ?? 0}</span>
                </button>
              );
            })}
          </div>

          {error && <div className="chatgpt-capture-alert">{error}</div>}

          {!loading && !error && items.length === 0 && (
            <div className="chatgpt-capture-empty-state">
              <span className="chatgpt-capture-empty-icon" aria-hidden="true">📦</span>
              <strong>Nothing in Buffer yet</strong>
              <p>Generate or download something with any tool and pick "Buffer" as the client, or use the Self Upload tab to add a file directly.</p>
            </div>
          )}

          <BufferFeedGrid
            items={items}
            loading={loading}
            loadingMore={loadingMore}
            hasMore={items.length < total}
            onLoadMore={handleLoadMore}
          />
        </>
      )}
    </div>
  );
}
