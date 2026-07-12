import React, { useCallback, useEffect, useRef, useState } from 'react';
import { authAPI, generationProjectsAPI, generationRecordsAPI } from '../../../../../services/api';
import { usePermissions } from '../../../../../hooks/usePermissions';
import { useAuth } from '../../../../../context/AuthContext';
import KlingFilterBar from './KlingFilterBar';
import KlingGenerationGrid from './KlingGenerationGrid';
import KlingGenerationDrawer from './KlingGenerationDrawer';
import KlingProjectsExplorer from './KlingProjectsExplorer';
import KlingCollectionsExplorer from './KlingCollectionsExplorer';
import KlingProjectTimeline from './KlingProjectTimeline';
import KlingUserExplorer from './KlingUserExplorer';
import KlingUserProfile from './KlingUserProfile';
import KlingAnalyticsPanel from './KlingAnalyticsPanel';
import KlingCardSkeletonGrid from './KlingCardSkeletonGrid';
import { parseKlingQuery } from './klingSearchDsl';
import './KlingTab.css';

const ALL_DEPARTMENTS = 'all_departments';
const ALL_MODELS = 'all_models';
const ALL_RESOLUTIONS = 'all_resolutions';
const ALL_OWNERSHIP = 'all_ownership';
const PAGE_SIZE = 60;
const REQUEST_TIMEOUT_MS = 60000;

const DATE_PRESETS = [
  { value: 'all', label: 'All Time' },
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'week', label: 'This Week' },
  { value: 'month', label: 'This Month' },
];

function toISODate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveDateRange(preset) {
  if (preset === 'all') return { dateFrom: undefined, dateTo: undefined };
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (preset === 'today') {
    return { dateFrom: toISODate(startOfToday), dateTo: toISODate(startOfToday) };
  }
  if (preset === 'yesterday') {
    const yesterday = new Date(startOfToday);
    yesterday.setDate(yesterday.getDate() - 1);
    return { dateFrom: toISODate(yesterday), dateTo: toISODate(yesterday) };
  }
  if (preset === 'week') {
    const start = new Date(startOfToday);
    start.setDate(start.getDate() - start.getDay());
    return { dateFrom: toISODate(start), dateTo: toISODate(startOfToday) };
  }
  if (preset === 'month') {
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return { dateFrom: toISODate(start), dateTo: toISODate(startOfToday) };
  }
  return { dateFrom: undefined, dateTo: undefined };
}

export default function KlingTab({ isActive }) {
  const { can } = usePermissions();
  const { user } = useAuth();
  const currentUserId = user?.id ?? null;
  const canDownload = can('download_rmw_data');
  const canViewAnalytics = can('view_kling_analytics');

  const [subView, setSubView] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState(ALL_DEPARTMENTS);
  const [departmentOptions, setDepartmentOptions] = useState([ALL_DEPARTMENTS]);
  const [modelFilter, setModelFilter] = useState(ALL_MODELS);
  const [modelOptions, setModelOptions] = useState([]);
  const [resolutionFilter, setResolutionFilter] = useState(ALL_RESOLUTIONS);
  const [resolutionOptions, setResolutionOptions] = useState([]);
  const [ownershipFilter, setOwnershipFilter] = useState(ALL_OWNERSHIP);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [datePreset, setDatePreset] = useState('all');
  const [sortBy, setSortBy] = useState('latest');
  const [projectFilter, setProjectFilter] = useState(null);
  const [collectionFilter, setCollectionFilter] = useState(null);
  const [tagFilter, setTagFilter] = useState('');
  const [tagOptions, setTagOptions] = useState([]);
  const [isTimelineOpen, setIsTimelineOpen] = useState(false);

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

  useEffect(() => {
    if (!isActive) return undefined;
    const timer = window.setTimeout(() => {
      const parsed = parseKlingQuery(searchInput);
      if (parsed.department) setDepartmentFilter(parsed.department);
      if (parsed.model) setModelFilter(parsed.model);
      if (parsed.resolution) setResolutionFilter(parsed.resolution);
      if (parsed.ownershipStatus) setOwnershipFilter(parsed.ownershipStatus);
      if (parsed.tag) setTagFilter(parsed.tag);
      if (parsed.isFavorite) setFavoritesOnly(true);
      if (parsed.datePreset) setDatePreset(parsed.datePreset);
      setSearch(parsed.freeText);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isActive, searchInput]);

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await authAPI.getDepartments();
        const departments = Array.isArray(response?.departments) ? response.departments : [];
        if (!cancelled) setDepartmentOptions([ALL_DEPARTMENTS, ...departments]);
      } catch (error) {
        console.warn('Failed to load department options for Kling tab:', error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isActive]);

  useEffect(() => {
    if (!isActive) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await generationRecordsAPI.getFilters();
        if (cancelled) return;
        setModelOptions(Array.isArray(response?.models) ? response.models : []);
        setResolutionOptions(Array.isArray(response?.resolutions) ? response.resolutions : []);
        setTagOptions(Array.isArray(response?.tags) ? response.tags : []);
      } catch (error) {
        console.warn('Failed to load Kling filter options:', error);
      }
    })();
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

  const buildSearchParams = useCallback(
    (offset) => {
      const { dateFrom, dateTo } = resolveDateRange(datePreset);
      return {
        q: search || undefined,
        department: departmentFilter === ALL_DEPARTMENTS ? undefined : departmentFilter,
        model: modelFilter === ALL_MODELS ? undefined : modelFilter,
        resolution: resolutionFilter === ALL_RESOLUTIONS ? undefined : resolutionFilter,
        ownership_status: ownershipFilter === ALL_OWNERSHIP ? undefined : ownershipFilter,
        is_favorite: favoritesOnly ? true : undefined,
        tag: tagFilter || undefined,
        project_id: projectFilter?.id ?? undefined,
        collection_id: collectionFilter?.id ?? undefined,
        date_from: dateFrom,
        date_to: dateTo,
        sort: sortBy,
        limit: PAGE_SIZE,
        offset,
      };
    },
    [
      search,
      departmentFilter,
      modelFilter,
      resolutionFilter,
      ownershipFilter,
      favoritesOnly,
      tagFilter,
      projectFilter,
      collectionFilter,
      datePreset,
      sortBy,
    ]
  );

  useEffect(() => {
    if (!isActive || subView !== 'all') return undefined;
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const response = await generationRecordsAPI.search(buildSearchParams(0), { timeout: REQUEST_TIMEOUT_MS });
        if (cancelled) return;
        const rows = Array.isArray(response?.data) ? response.data : [];
        setGenerations(rows);
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
  }, [isActive, subView, buildSearchParams]);

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

  const handleSelectProject = useCallback((project) => {
    setProjectFilter({ id: project.id, name: project.name });
    setCollectionFilter(null);
    setSubView('all');
  }, []);

  const clearProjectFilter = useCallback(() => setProjectFilter(null), []);

  const handleSelectCollection = useCallback((collection) => {
    setCollectionFilter({ id: collection.id, name: collection.name });
    setProjectFilter(null);
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
          aria-selected={subView === 'projects'}
          className={`kling-subnav-tab ${subView === 'projects' ? 'active' : ''}`}
          onClick={() => setSubView('projects')}
        >
          Projects
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
            searchInput={searchInput}
            onSearchInputChange={setSearchInput}
            departmentFilter={departmentFilter}
            departmentOptions={departmentOptions}
            onDepartmentChange={setDepartmentFilter}
            modelFilter={modelFilter}
            modelOptions={modelOptions}
            onModelChange={setModelFilter}
            resolutionFilter={resolutionFilter}
            resolutionOptions={resolutionOptions}
            onResolutionChange={setResolutionFilter}
            ownershipFilter={ownershipFilter}
            onOwnershipChange={setOwnershipFilter}
            favoritesOnly={favoritesOnly}
            onToggleFavoritesOnly={() => setFavoritesOnly((prev) => !prev)}
            tagFilter={tagFilter}
            tagOptions={tagOptions}
            onTagFilterChange={setTagFilter}
            datePreset={datePreset}
            datePresets={DATE_PRESETS}
            onDatePresetChange={setDatePreset}
            sortBy={sortBy}
            onSortChange={setSortBy}
            projectFilter={projectFilter}
            onClearProjectFilter={clearProjectFilter}
            collectionFilter={collectionFilter}
            onClearCollectionFilter={clearCollectionFilter}
            onViewTimeline={() => setIsTimelineOpen(true)}
            allDepartmentsValue={ALL_DEPARTMENTS}
            allModelsValue={ALL_MODELS}
            allResolutionsValue={ALL_RESOLUTIONS}
            allOwnershipValue={ALL_OWNERSHIP}
          />

          <div className="kling-results-area">
            {loadError && <div className="kling-state kling-state-error">{loadError}</div>}
            {!loadError && loading && <KlingCardSkeletonGrid count={12} />}
            {!loadError && !loading && generations.length === 0 && (
              <div className="kling-state">No Kling generations match these filters.</div>
            )}
            {!loadError && !loading && generations.length > 0 && (
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

      {subView === 'projects' && <KlingProjectsExplorer onSelectProject={handleSelectProject} />}

      {subView === 'collections' && <KlingCollectionsExplorer onSelectCollection={handleSelectCollection} />}

      {subView === 'users' && <KlingUserExplorer onSelectUser={handleSelectUser} />}

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
        />
      )}

      {isTimelineOpen && projectFilter && (
        <KlingProjectTimeline
          projectId={projectFilter.id}
          projectName={projectFilter.name}
          onClose={() => setIsTimelineOpen(false)}
        />
      )}
    </div>
  );
}
