import React, { useCallback, useEffect, useRef, useState } from 'react';
import { generationProjectsAPI, generationRecordsAPI } from '../../../../../services/api';
import { usePermissions } from '../../../../../hooks/usePermissions';
import { useAuth } from '../../../../../context/AuthContext';
import KlingFilterBar from './KlingFilterBar';
import KlingGenerationGrid from './KlingGenerationGrid';
import KlingGenerationDrawer from './KlingGenerationDrawer';
import KlingClientsExplorer from './KlingClientsExplorer';
import KlingCollectionsExplorer from './KlingCollectionsExplorer';
import KlingUserExplorer from './KlingUserExplorer';
import KlingUserProfile from './KlingUserProfile';
import KlingUnclaimedExplorer from './KlingUnclaimedExplorer';
import KlingAnalyticsPanel from './KlingAnalyticsPanel';
import KlingCardSkeletonGrid from './KlingCardSkeletonGrid';
import { parseKlingQuery } from './klingSearchDsl';
import { KLING_DEFAULT_FILTERS, isFilterInvalid, loadKlingFilterOptions, toKlingQueryParams } from './klingFilters';
import './KlingTab.css';

const PAGE_SIZE = 60;
const REQUEST_TIMEOUT_MS = 60000;
const FILTER_DEBOUNCE_MS = 250;

export default function KlingTab({ isActive, searchInput = '', onFiltersChange }) {
  const { can } = usePermissions();
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const canDownload = can('download_rmw_data');
  const canViewAnalytics = can('view_kling_analytics');

  const [subView, setSubView] = useState('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState(KLING_DEFAULT_FILTERS);
  // What the grid actually queries: `filters` after a short pause, so typing
  // a credit range or date does not fire a request per keystroke.
  const [appliedFilters, setAppliedFilters] = useState(KLING_DEFAULT_FILTERS);
  const [filterOptions, setFilterOptions] = useState({});
  const [sortBy, setSortBy] = useState('latest');
  const [collectionFilter, setCollectionFilter] = useState(null);
  const [summary, setSummary] = useState(null);

  const [generations, setGenerations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loadError, setLoadError] = useState('');

  const [selectedGeneration, setSelectedGeneration] = useState(null);
  const [favoritePendingIds, setFavoritePendingIds] = useState(() => new Set());
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [myProjects, setMyProjects] = useState([]);

  const loadMoreInFlightRef = useRef(false);
  const favoritePendingIdsRef = useRef(favoritePendingIds);
  favoritePendingIdsRef.current = favoritePendingIds;

  const updateFilters = useCallback((patch) => setFilters((prev) => ({ ...prev, ...patch })), []);
  const resetFilters = useCallback(() => {
    setFilters(KLING_DEFAULT_FILTERS);
    setCollectionFilter(null);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setAppliedFilters(filters), FILTER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [filters]);

  // The panel's Excel export starts from whatever the tab is showing.
  useEffect(() => {
    onFiltersChange?.({ filters, q: search, collectionId: collectionFilter?.id ?? null, collectionName: collectionFilter?.name ?? null });
  }, [filters, search, collectionFilter, onFiltersChange]);

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = window.setTimeout(() => {
      const parsed = parseKlingQuery(searchInput);
      const patch = {};
      if (parsed.department) patch.department = parsed.department;
      if (parsed.model) patch.model = parsed.model;
      if (parsed.resolution) patch.resolution = parsed.resolution;
      if (parsed.ownershipStatus) patch.ownership = parsed.ownershipStatus;
      if (parsed.tag) patch.tag = parsed.tag;
      if (parsed.isFavorite) patch.favoritesOnly = true;
      if (parsed.datePreset) patch.datePreset = parsed.datePreset;
      if (Object.keys(patch).length) setFilters((prev) => ({ ...prev, ...patch }));
      setSearch(parsed.freeText);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isActive, searchInput]);

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    loadKlingFilterOptions()
      .then((response) => { if (!cancelled) setFilterOptions(response || {}); })
      .catch((error) => console.warn('Failed to load Kling filter options:', error));
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await generationProjectsAPI.listProjects();
        if (!cancelled) setMyProjects(Array.isArray(response?.data) ? response.data : []);
      } catch (error) {
        console.warn('Failed to load own projects for Kling move-to-project menu:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  const filtersInvalid = Boolean(isFilterInvalid(appliedFilters));

  const buildSearchParams = useCallback(
    (offset) => toKlingQueryParams(appliedFilters, {
      q: search || undefined,
      collection_id: collectionFilter?.id ?? undefined,
      sort: sortBy,
      limit: PAGE_SIZE,
      offset,
    }),
    [appliedFilters, search, collectionFilter, sortBy]
  );

  useEffect(() => {
    if (!isActive || subView !== 'all' || filtersInvalid) return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const response = await generationRecordsAPI.search(buildSearchParams(0), { timeout: REQUEST_TIMEOUT_MS });
        if (cancelled) return;
        const rows = Array.isArray(response?.data) ? response.data : [];
        setGenerations(rows);
        setSummary(response?.summary || null);
        setHasMore(Boolean(response?.pagination?.hasMore));
        setNextOffset(Number.isFinite(response?.pagination?.nextOffset) ? response.pagination.nextOffset : 0);
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load Kling generations:', error);
          setLoadError('Could not load Kling generations right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActive, subView, buildSearchParams, filtersInvalid]);

  const loadMoreGenerations = useCallback(async () => {
    if (loadMoreInFlightRef.current || loadingMore || loading || !hasMore) return;
    loadMoreInFlightRef.current = true;
    setLoadingMore(true);
    try {
      const response = await generationRecordsAPI.search(buildSearchParams(nextOffset), { timeout: REQUEST_TIMEOUT_MS });
      const rows = Array.isArray(response?.data) ? response.data : [];
      setGenerations((prev) => Array.from(new Map([...prev, ...rows].map((item) => [item.id, item])).values()));
      setHasMore(Boolean(response?.pagination?.hasMore));
      setNextOffset(Number.isFinite(response?.pagination?.nextOffset) ? response.pagination.nextOffset : nextOffset);
    } catch (error) {
      console.error('Failed to load more Kling generations:', error);
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [loadingMore, loading, hasMore, nextOffset, buildSearchParams]);

  const handleToggleFavorite = useCallback(
    async (generation) => {
      if (!generation || favoritePendingIdsRef.current.has(generation.id)) return;
      const previousFavorite = Boolean(generation.isFavorite);
      const nextFavorite = !previousFavorite;
      setFavoritePendingIds((prev) => new Set(prev).add(generation.id));
      setGenerations((prev) => prev.map((item) => (item.id === generation.id ? { ...item, isFavorite: nextFavorite } : item)));
      setSelectedGeneration((prev) => (prev && prev.id === generation.id ? { ...prev, isFavorite: nextFavorite } : prev));
      try {
        if (nextFavorite) {
          await generationRecordsAPI.addFavorite(generation.id);
        } else {
          await generationRecordsAPI.removeFavorite(generation.id);
        }
      } catch (error) {
        console.error('Failed to toggle Kling favorite:', error);
        setGenerations((prev) =>
          prev.map((item) => (item.id === generation.id ? { ...item, isFavorite: previousFavorite } : item))
        );
        setSelectedGeneration((prev) => (prev && prev.id === generation.id ? { ...prev, isFavorite: previousFavorite } : prev));
      } finally {
        setFavoritePendingIds((prev) => {
          const next = new Set(prev);
          next.delete(generation.id);
          return next;
        });
      }
    },
    // Intentionally stable (no favoritePendingIds dependency): reads the latest
    // pending set via favoritePendingIdsRef instead. Grid cells receive this
    // callback as a prop, and react-window's shared cellProps object means a
    // changing reference here would invalidate every visible card's memoization,
    // not just the one being favorited.
    []
  );

  const handleGenerationUpdated = useCallback((updated) => {
    setGenerations((prev) => prev.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
  }, []);

  const handleGenerationDeleted = useCallback((generationId) => {
    setGenerations((prev) => prev.filter((item) => item.id !== generationId));
  }, []);

  const handleMoveToProject = useCallback(async (generation, project) => {
    const previousProjectId = generation.projectId;
    const previousProjectName = generation.projectName;
    setGenerations((prev) =>
      prev.map((item) => (item.id === generation.id ? { ...item, projectId: project.id, projectName: project.name } : item))
    );
    try {
      await generationProjectsAPI.assignGeneration(project.id, generation.id);
    } catch (error) {
      console.error('Failed to move Kling generation to project:', error);
      setGenerations((prev) =>
        prev.map((item) =>
          item.id === generation.id ? { ...item, projectId: previousProjectId, projectName: previousProjectName } : item
        )
      );
    }
  }, []);

  const handleRemoveFromProject = useCallback(async (generation) => {
    const previousProjectId = generation.projectId;
    const previousProjectName = generation.projectName;
    if (!previousProjectId) return;
    setGenerations((prev) =>
      prev.map((item) => (item.id === generation.id ? { ...item, projectId: null, projectName: null } : item))
    );
    try {
      await generationProjectsAPI.removeGeneration(previousProjectId, generation.id);
    } catch (error) {
      console.error('Failed to remove Kling generation from project:', error);
      setGenerations((prev) =>
        prev.map((item) =>
          item.id === generation.id ? { ...item, projectId: previousProjectId, projectName: previousProjectName } : item
        )
      );
    }
  }, []);

  const handleSelectCollection = useCallback((collection) => {
    setCollectionFilter({ id: collection.id, name: collection.name });
    setFilters((prev) => ({ ...prev, clientId: '' }));
    setSubView('all');
  }, []);

  const handleSelectClient = useCallback((client) => {
    setFilters((prev) => ({ ...prev, clientId: String(client.id) }));
    setCollectionFilter(null);
    setSubView('all');
  }, []);

  const clearCollectionFilter = useCallback(() => setCollectionFilter(null), []);

  const handleSelectUser = useCallback((user) => {
    setSelectedUserId(user.userId);
  }, []);

  const handleOpenGenerationFromProfile = useCallback((generation) => {
    setSelectedUserId(null);
    setSelectedGeneration(generation);
  }, []);

  return (
    <div className="kling-tab">
      <div className="kling-tab-subnav" role="tablist" aria-label="Kling Views">
        <button
          type="button"
          role="tab"
          aria-selected={subView === 'all'}
          className={`kling-subnav-tab ${subView === 'all' ? 'active' : ''}`}
          onClick={() => setSubView('all')}
        >
          All Generations
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subView === 'clients'}
          className={`kling-subnav-tab ${subView === 'clients' ? 'active' : ''}`}
          onClick={() => setSubView('clients')}
        >
          Clients
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subView === 'collections'}
          className={`kling-subnav-tab ${subView === 'collections' ? 'active' : ''}`}
          onClick={() => setSubView('collections')}
        >
          Collections
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subView === 'users'}
          className={`kling-subnav-tab ${subView === 'users' ? 'active' : ''}`}
          onClick={() => setSubView('users')}
        >
          Users
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={subView === 'unclaimed'}
          className={`kling-subnav-tab ${subView === 'unclaimed' ? 'active' : ''}`}
          onClick={() => setSubView('unclaimed')}
        >
          Unclaimed
        </button>
        {canViewAnalytics && (
          <button
            type="button"
            role="tab"
            aria-selected={subView === 'analytics'}
            className={`kling-subnav-tab ${subView === 'analytics' ? 'active' : ''}`}
            onClick={() => setSubView('analytics')}
          >
            Analytics
          </button>
        )}
      </div>

      {subView === 'all' && (
        <>
          <KlingFilterBar
            filters={filters}
            onChange={updateFilters}
            onReset={resetFilters}
            options={filterOptions}
            sortBy={sortBy}
            onSortChange={setSortBy}
            summary={summary}
            loading={loading}
            collectionFilter={collectionFilter}
            onClearCollectionFilter={clearCollectionFilter}
          />

          <div className="kling-results-area">
            {loadError && <div className="kling-state kling-state-error">{loadError}</div>}
            {!loadError && filtersInvalid && <div className="kling-state">{isFilterInvalid(appliedFilters)}</div>}
            {!loadError && !filtersInvalid && loading && <KlingCardSkeletonGrid count={12} />}
            {!loadError && !filtersInvalid && !loading && generations.length === 0 && (
              <div className="kling-state">
                No Kling generations match these filters.
                <button type="button" className="kfb-clear" onClick={resetFilters}>Clear all filters</button>
              </div>
            )}
            {!loadError && !filtersInvalid && !loading && generations.length > 0 && (
              <KlingGenerationGrid
                generations={generations}
                hasMore={hasMore}
                loadingMore={loadingMore}
                onLoadMore={loadMoreGenerations}
                onOpenDrawer={setSelectedGeneration}
                onToggleFavorite={handleToggleFavorite}
                favoritePendingIds={favoritePendingIds}
                canDownload={canDownload}
                currentUserId={currentUserId}
                myProjects={myProjects}
                onMoveToProject={handleMoveToProject}
                onRemoveFromProject={handleRemoveFromProject}
              />
            )}
          </div>
        </>
      )}

      {subView === 'clients' && <KlingClientsExplorer onSelectClient={handleSelectClient} />}

      {subView === 'collections' && <KlingCollectionsExplorer onSelectCollection={handleSelectCollection} />}

      {subView === 'users' && <KlingUserExplorer onSelectUser={handleSelectUser} />}

      {subView === 'unclaimed' && <KlingUnclaimedExplorer onOpenGeneration={setSelectedGeneration} />}

      {subView === 'analytics' && canViewAnalytics && <KlingAnalyticsPanel />}

      {selectedUserId && (
        <KlingUserProfile
          userId={selectedUserId}
          onClose={() => setSelectedUserId(null)}
          onOpenGeneration={handleOpenGenerationFromProfile}
        />
      )}

      {selectedGeneration && (
        <KlingGenerationDrawer
          generation={selectedGeneration}
          onClose={() => setSelectedGeneration(null)}
          onToggleFavorite={handleToggleFavorite}
          isFavoritePending={favoritePendingIds.has(selectedGeneration.id)}
          canDownload={canDownload}
          onGenerationUpdated={handleGenerationUpdated}
          onGenerationDeleted={handleGenerationDeleted}
        />
      )}

    </div>
  );
}
