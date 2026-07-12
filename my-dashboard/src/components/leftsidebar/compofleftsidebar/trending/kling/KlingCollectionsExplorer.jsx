import React, { useCallback, useEffect, useState } from 'react';
import { generationCollectionsAPI } from '../../../../../services/api';
import { UserAvatar } from '../../../../common/UserAvatar';
import { formatGenerationDate } from './klingMedia';

const PAGE_SIZE = 24;

export default function KlingCollectionsExplorer({ onSelectCollection }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [collections, setCollections] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createDescription, setCreateDescription] = useState('');
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setOffset(0);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await generationCollectionsAPI.listDirectory({
          q: search || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (cancelled) return;
        setCollections(Array.isArray(response?.data) ? response.data : []);
        setTotal(Number.isFinite(response?.pagination?.total) ? response.pagination.total : 0);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load Kling collections:', fetchError);
          setError('Could not load collections right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search, offset, refreshKey]);

  const handlePrevious = useCallback(() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE)), []);
  const handleNext = useCallback(() => setOffset((prev) => prev + PAGE_SIZE), []);

  const handleCreateSubmit = useCallback(
    async (event) => {
      event.preventDefault();
      const trimmedName = createName.trim();
      if (!trimmedName) {
        setCreateError('Collection name is required.');
        return;
      }
      setCreateSubmitting(true);
      setCreateError('');
      try {
        await generationCollectionsAPI.createCollection({
          name: trimmedName,
          description: createDescription.trim() || undefined,
        });
        setCreateName('');
        setCreateDescription('');
        setIsCreateOpen(false);
        setOffset(0);
        setRefreshKey((prev) => prev + 1);
      } catch (createErr) {
        setCreateError(createErr?.response?.data?.detail || 'Could not create collection.');
      } finally {
        setCreateSubmitting(false);
      }
    },
    [createName, createDescription]
  );

  return (
    <div className="kling-projects-explorer">
      <div className="kling-projects-toolbar">
        <input
          className="trendings-search kling-search"
          placeholder="Search collections..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <button type="button" className="kling-subnav-tab" onClick={() => setIsCreateOpen((prev) => !prev)}>
          {isCreateOpen ? 'Cancel' : '+ New Collection'}
        </button>
      </div>

      {isCreateOpen && (
        <form className="kling-collection-create-form" onSubmit={handleCreateSubmit}>
          <input
            type="text"
            placeholder="Collection name (e.g. Client Approval)"
            value={createName}
            onChange={(event) => setCreateName(event.target.value)}
            className="trendings-search"
          />
          <input
            type="text"
            placeholder="Description (optional)"
            value={createDescription}
            onChange={(event) => setCreateDescription(event.target.value)}
            className="trendings-search"
          />
          {createError && <div className="kling-state-error">{createError}</div>}
          <button type="submit" className="kling-subnav-tab active" disabled={createSubmitting}>
            {createSubmitting ? 'Creating...' : 'Create Collection'}
          </button>
        </form>
      )}

      {error && <div className="kling-state kling-state-error">{error}</div>}
      {!error && loading && <div className="kling-state">Loading collections...</div>}
      {!error && !loading && collections.length === 0 && <div className="kling-state">No collections found.</div>}

      {!error && !loading && collections.length > 0 && (
        <>
          <div className="kling-projects-grid">
            {collections.map((collection) => (
              <button
                type="button"
                key={collection.id}
                className="kling-project-card"
                onClick={() => onSelectCollection(collection)}
              >
                <div className="kling-project-card-cover kling-collection-card-cover">
                  {collection.name ? collection.name.slice(0, 1).toUpperCase() : '#'}
                </div>
                <div className="kling-project-card-body">
                  <h4 className="kling-project-card-title">{collection.name}</h4>
                  {collection.description && <p className="kling-project-card-description">{collection.description}</p>}
                  <div className="kling-project-card-owner">
                    <UserAvatar avatar={collection.ownerAvatar} name={collection.ownerName || 'Unknown owner'} size={20} />
                    <span>{collection.ownerName || 'Unknown owner'}</span>
                  </div>
                  <div className="kling-project-card-stats">
                    <span>{collection.memberCount} generations</span>
                    <span>Updated {formatGenerationDate(collection.updatedAt)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="kling-projects-pagination">
            <button type="button" onClick={handlePrevious} disabled={offset === 0}>
              Previous
            </button>
            <span>
              {total === 0 ? 0 : offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button type="button" onClick={handleNext} disabled={offset + PAGE_SIZE >= total}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
