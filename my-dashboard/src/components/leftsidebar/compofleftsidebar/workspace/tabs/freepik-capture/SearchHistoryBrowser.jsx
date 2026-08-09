import { useCallback, useEffect, useRef, useState } from 'react';
import { freepikCaptureAPI } from '../../../../../../services/api';
import { formatRelativeTime, normalizeApiError, truncate } from './freepikCaptureUtils';

const SEARCH_PAGE_SIZE = 30;

// Search queries have no visual asset of their own (unlike a generation or a
// download), so this is a row-list like UserListSidebar.jsx's employee list,
// not a card grid - reuses that same "chatgpt-capture-user-card"/
// "chatgpt-capture-conv-list" row styling as-is rather than inventing a new
// list-row visual for what is structurally the same shape (an icon/avatar,
// a title line, a meta row).
function SearchQueryRow({ row }) {
  return (
    <div className="chatgpt-capture-user-card-wrap">
      <div className="chatgpt-capture-user-card" style={{ cursor: 'default' }}>
        <div className="chatgpt-capture-user-card-avatar" aria-hidden="true">
          <span>🔎</span>
        </div>
        <div className="chatgpt-capture-user-card-body">
          <div className="chatgpt-capture-user-card-top">
            <span className="chatgpt-capture-user-card-name">{truncate(row.searchTerm, 90) || 'No search term captured'}</span>
          </div>
          <div className="chatgpt-capture-user-card-meta">
            {row.sourceHost && <span className="chatgpt-capture-chip">{row.sourceHost}</span>}
            {row.resultCountLabel && <span>{row.resultCountLabel}</span>}
            <span>{row.ownerName || (row.ownerUserId ? `User #${row.ownerUserId}` : 'Unclaimed')}</span>
            <span className="chatgpt-capture-conv-card-time">{formatRelativeTime(row.searchedAt || row.createdAt)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * "Search History" view of the Freepik/Magnific Capture Center - see
 * providers/freepik/models.py's FreepikSearchQuery docstring for why this is
 * its own table/endpoint: a stock-library search has no creation.id, and is
 * deliberately never gated behind Task/Client the way a generation or a
 * download is (Sarbjeet's own call - search is free-form browsing, only the
 * eventual download of something found needs project attribution). No
 * task/client filter here for that same reason - only ownership-adjacent
 * (owner) and source-host filtering make sense for this table.
 */
export default function SearchHistoryBrowser({ searchInput, onTotalChange }) {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const requestTokenRef = useRef(0);

  const loadRows = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await freepikCaptureAPI.listSearchQueries({
          q: (searchInput || '').trim() || undefined,
          limit: SEARCH_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setRows((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load search history.'));
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
    const timer = window.setTimeout(() => loadRows(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadRows]);

  useEffect(() => {
    onTotalChange?.(total);
  }, [total, onTotalChange]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || rows.length >= total) return;
    loadRows(rows.length, { append: true });
  }, [rows.length, loadingMore, total, loadRows]);

  return (
    <div className="chatgpt-capture-sidebar-panel">
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && rows.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">🔎</span>
          <strong>No searches captured yet</strong>
          <p>Open Freepik/Magnific through the dashboard launcher with the extension active and search the stock library.</p>
        </div>
      )}

      {loading && rows.length === 0 && (
        <div aria-hidden="true">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="chatgpt-capture-user-card-wrap">
              <div className="chatgpt-capture-user-card loading" />
            </div>
          ))}
        </div>
      )}

      {rows.length > 0 && (
        <div className="chatgpt-capture-conv-list">
          {rows.map((row) => (
            <SearchQueryRow key={row.id} row={row} />
          ))}
          {rows.length < total && (
            <button
              type="button"
              className="chatgpt-capture-secondary-btn"
              style={{ width: '100%', marginTop: 8 }}
              onClick={handleLoadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : `Load more (${total - rows.length} remaining)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
