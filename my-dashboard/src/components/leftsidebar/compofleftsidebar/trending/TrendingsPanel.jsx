import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { authAPI, taskAPI } from '../../../../services/api';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { buildFileDownloadUrl, buildFileOpenUrl } from '../../../../utils/fileLinks';
import './TrendingsPanel.css';

const MEDIA_FILTERS = ['all', 'text', 'image', 'video', 'music', 'link', 'pdf'];
const ALL_DEPARTMENTS = 'all_departments';
const PAGE_SIZE = 60;
const DATABANK_REQUEST_TIMEOUT_MS = 60000;
const DIRECTORY_STRUCTURE_STORAGE_KEY = 'rmw.databank.directory.structure';
const DEFAULT_DIRECTORY_STRUCTURE = ['uploader', 'date', 'project'];

const DIRECTORY_CRITERIA = {
  uploader: {
    key: 'uploader',
    label: 'Uploader',
    folderLabel: 'Uploader folder',
    icon: '👤',
    getNode: (asset) => {
      const name = (asset.uploadedByName || asset.createdByName || asset.submittedByName || 'Unknown uploader').trim() || 'Unknown uploader';
      const identity = asset.uploadedById || asset.createdById || asset.submittedById || name.toLowerCase();
      return {
        groupKey: `${identity}`,
        label: name,
      };
    },
    compareNodes: (a, b) => a.label.localeCompare(b.label),
  },
  date: {
    key: 'date',
    label: 'Date',
    folderLabel: 'Date folder',
    icon: '📅',
    getNode: (asset) => {
      const dateKey = getDateFolderKey(asset);
      return {
        groupKey: dateKey,
        label: formatDateFolderLabel(dateKey),
      };
    },
    compareNodes: (a, b) => `${b.groupKey}`.localeCompare(`${a.groupKey}`),
  },
  project: {
    key: 'project',
    label: 'Project',
    folderLabel: 'Project folder',
    icon: '📁',
    getNode: (asset) => {
      const projectName = (asset.projectName || 'Unassigned Project').trim() || 'Unassigned Project';
      return {
        groupKey: projectName.toLowerCase(),
        label: projectName,
      };
    },
    compareNodes: (a, b) => a.label.localeCompare(b.label),
  },
};

const DIRECTORY_STRUCTURE_OPTIONS = [
  { value: 'uploader', label: 'Uploader' },
  { value: 'date', label: 'Date' },
  { value: 'project', label: 'Project' },
  { value: 'none', label: 'None' },
];

const getSourceExtension = (asset) => {
  const source = `${asset?.url || asset?.filename || asset?.originalName || ''}`.toLowerCase();
  return source.split('.').pop();
};

const getAssetActivityTime = (asset) => asset?.updatedAt || asset?.createdAt || null;

const getDateFolderKey = (asset) => {
  const source = getAssetActivityTime(asset);
  if (!source) return 'unknown-date';
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return 'unknown-date';
  return parsed.toISOString().slice(0, 10);
};

const formatDateFolderLabel = (key) => {
  if (!key || key === 'unknown-date') return 'Unknown Date';
  const parsed = new Date(`${key}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return key;
  return parsed.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
};

const normalizeDirectoryStructure = (value) => {
  const slots = Array.isArray(value) ? value.slice(0, 3) : [];
  const sanitized = ['none', 'none', 'none'];
  const seen = new Set();

  for (let index = 0; index < 3; index += 1) {
    const rawValue = `${slots[index] || ''}`.trim().toLowerCase();
    if (!DIRECTORY_CRITERIA[rawValue] || seen.has(rawValue)) {
      continue;
    }
    sanitized[index] = rawValue;
    seen.add(rawValue);
  }

  if (sanitized.every((item) => item === 'none')) {
    return [...DEFAULT_DIRECTORY_STRUCTURE];
  }

  return sanitized;
};

const loadDirectoryStructurePreference = () => {
  if (typeof window === 'undefined') {
    return [...DEFAULT_DIRECTORY_STRUCTURE];
  }
  try {
    const rawValue = window.localStorage.getItem(DIRECTORY_STRUCTURE_STORAGE_KEY);
    if (!rawValue) {
      return [...DEFAULT_DIRECTORY_STRUCTURE];
    }
    return normalizeDirectoryStructure(JSON.parse(rawValue));
  } catch (error) {
    return [...DEFAULT_DIRECTORY_STRUCTURE];
  }
};

const buildDirectoryStructureSummary = (criteriaKeys = []) => {
  if (!criteriaKeys.length) return 'Files';
  return [
    ...criteriaKeys.map((criterionKey) => DIRECTORY_CRITERIA[criterionKey]?.folderLabel || criterionKey),
    'files',
  ].join(' → ');
};

const getDirectoryFilterParamName = (criterionKey) => {
  if (criterionKey === 'uploader') return 'uploader_key';
  if (criterionKey === 'date') return 'date_key';
  if (criterionKey === 'project') return 'project_key';
  return '';
};

const buildDirectoryGroupCacheKey = (groupBy, pathFilters = {}) => {
  const uploaderKey = `${pathFilters.uploader_key || ''}`.trim();
  const dateKey = `${pathFilters.date_key || ''}`.trim();
  const projectKey = `${pathFilters.project_key || ''}`.trim();
  return `${groupBy}|u=${uploaderKey}|d=${dateKey}|p=${projectKey}`;
};

const buildDirectoryFilePathKey = (pathFilters = {}, criteriaKeys = []) => {
  const uploaderKey = `${pathFilters.uploader_key || ''}`.trim();
  const dateKey = `${pathFilters.date_key || ''}`.trim();
  const projectKey = `${pathFilters.project_key || ''}`.trim();
  return `${criteriaKeys.join('>')}|u=${uploaderKey}|d=${dateKey}|p=${projectKey}`;
};

const getMediaFilterLabel = (value) => {
  if (value === 'all') return 'All Formats';
  return `${value || ''}`.toUpperCase();
};

const TrendingsPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [nextOffset, setNextOffset] = useState(null);
  const [totalMatchingReferences, setTotalMatchingReferences] = useState(null);
  const [lastLatencyMs, setLastLatencyMs] = useState(null);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [departmentFilter, setDepartmentFilter] = useState(ALL_DEPARTMENTS);
  const [departmentOptions, setDepartmentOptions] = useState([ALL_DEPARTMENTS]);
  const [sortBy, setSortBy] = useState('latest');
  const [loadError, setLoadError] = useState('');
  const [previewAsset, setPreviewAsset] = useState(null);
  const [infoAsset, setInfoAsset] = useState(null);
  const [openMenuAssetId, setOpenMenuAssetId] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const minimizedWindowStyle = useMinimizedWindowStack('trendings-panel', isOpen && isMinimized);
  const [activeView, setActiveView] = useState('data');
  const [directoryStructure, setDirectoryStructure] = useState(() => loadDirectoryStructurePreference());
  const [selectedDirectoryNodes, setSelectedDirectoryNodes] = useState({});
  const [directoryGroupsByKey, setDirectoryGroupsByKey] = useState({});
  const [directoryGroupLoadingKeys, setDirectoryGroupLoadingKeys] = useState({});
  const [directoryFiles, setDirectoryFiles] = useState([]);
  const [directoryFilesLoading, setDirectoryFilesLoading] = useState(false);
  const [directoryFilesLoadingMore, setDirectoryFilesLoadingMore] = useState(false);
  const [directoryFilesHasMore, setDirectoryFilesHasMore] = useState(false);
  const [directoryFilesNextOffset, setDirectoryFilesNextOffset] = useState(0);
  const [directoryFilesPathKey, setDirectoryFilesPathKey] = useState('');

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DIRECTORY_STRUCTURE_STORAGE_KEY, JSON.stringify(directoryStructure));
  }, [directoryStructure]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  const buildOpenUrl = (asset) => {
    return buildFileOpenUrl(asset) || null;
  };

  const buildDownloadUrl = (asset) => {
    return buildFileDownloadUrl(asset, asset?.filename || 'download') || null;
  };

  const openAssetInNewTab = (asset) => {
    const openUrl = buildOpenUrl(asset);
    if (!openUrl) {
      setPreviewAsset(asset);
      return;
    }
    setPreviewAsset(asset);
  };

  const downloadAsset = (asset) => {
    const downloadUrl = buildDownloadUrl(asset);
    if (!downloadUrl) return;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isOpen, searchInput]);

  useEffect(() => {
    if (!isOpen) return;
    const loadDepartments = async () => {
      try {
        const response = await authAPI.getDepartments();
        const departments = Array.isArray(response?.departments) ? response.departments : [];
        setDepartmentOptions([ALL_DEPARTMENTS, ...departments]);
      } catch (error) {
        console.warn('Failed to load department options for trendings:', error);
        setDepartmentOptions([ALL_DEPARTMENTS]);
      }
    };
    loadDepartments();
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeView === 'directory') return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const res = await taskAPI.getTaskAssets(
          {
            offset: 0,
            limit: PAGE_SIZE,
            media_type: filter,
            department: departmentFilter === ALL_DEPARTMENTS ? undefined : departmentFilter,
            q: search || undefined,
            sort: sortBy,
          },
          { timeout: DATABANK_REQUEST_TIMEOUT_MS }
        );
        if (cancelled) return;
        setAssets(Array.isArray(res?.data) ? res.data : []);
        setHasMore(Boolean(res?.hasMore));
        setNextCursor(res?.nextCursor || null);
        setNextOffset(Number.isFinite(res?.nextOffset) ? res.nextOffset : null);
        setTotalMatchingReferences(null);
        setLastLatencyMs(Number.isFinite(res?.latencyMs) ? res.latencyMs : null);
      } catch (error) {
        console.error('Failed to load trendings:', error);
        if (cancelled) return;
        setAssets([]);
        setHasMore(false);
        setNextCursor(null);
        setNextOffset(null);
        setTotalMatchingReferences(null);
        setLastLatencyMs(null);
        setLoadError('Could not load databank assets right now.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, activeView, filter, departmentFilter, search, sortBy]);

  const loadMoreAssets = useCallback(async () => {
    if (loadingMore || loading || !hasMore || (!nextCursor && nextOffset == null)) return;
    setLoadingMore(true);
    setLoadError('');
    try {
      const res = await taskAPI.getTaskAssets(
        {
          offset: nextCursor ? undefined : nextOffset ?? undefined,
          limit: PAGE_SIZE,
          media_type: filter,
          department: departmentFilter === ALL_DEPARTMENTS ? undefined : departmentFilter,
          q: search || undefined,
          sort: sortBy,
          cursor: nextCursor || undefined,
        },
        { timeout: DATABANK_REQUEST_TIMEOUT_MS }
      );
      const nextRows = Array.isArray(res?.data) ? res.data : [];
      setAssets((prev) =>
        Array.from(new Map([...prev, ...nextRows].map((asset) => [asset.id, asset])).values())
      );
      setHasMore(Boolean(res?.hasMore));
      setNextCursor(res?.nextCursor || null);
      setNextOffset(Number.isFinite(res?.nextOffset) ? res.nextOffset : null);
      setTotalMatchingReferences((current) => (
        Number.isFinite(res?.totalMatchingReferences) ? res.totalMatchingReferences : current
      ));
      setLastLatencyMs((current) => (Number.isFinite(res?.latencyMs) ? res.latencyMs : current));
    } catch (error) {
      console.error('Failed to load more trendings assets:', error);
      setLoadError('Could not load more databank assets right now.');
    } finally {
      setLoadingMore(false);
    }
  }, [departmentFilter, filter, hasMore, loading, loadingMore, nextCursor, nextOffset, search, sortBy]);

  const filteredAssets = useMemo(() => assets, [assets]);
  const canLoadMore = hasMore && (Boolean(nextCursor) || nextOffset != null);
  const metrics = useMemo(() => {
    const groupedByTask = assets.reduce((acc, item) => {
      acc[item.taskId] = (acc[item.taskId] || 0) + 1;
      return acc;
    }, {});
    const uniqueProjectCount = new Set(
      assets
        .map((item) => `${item.projectName || ''}`.trim())
        .filter(Boolean)
    ).size;

    return {
      loadedReferences: assets.length,
      loadedTasks: Object.keys(groupedByTask).length,
      loadedProjects: uniqueProjectCount,
    };
  }, [assets]);

  const loadedSummaryText = totalMatchingReferences != null
    ? `Showing ${filteredAssets.length} of ${totalMatchingReferences} references`
    : `Showing ${filteredAssets.length} references`;
  const isDirectoryTab = activeView === 'directory';
  const activeDirectoryCriteria = useMemo(
    () => directoryStructure.filter((criterionKey) => criterionKey !== 'none'),
    [directoryStructure]
  );
  const directoryStructureSummary = useMemo(
    () => buildDirectoryStructureSummary(activeDirectoryCriteria),
    [activeDirectoryCriteria]
  );
  const directoryBaseFilters = useMemo(
    () => ({
      media_type: filter,
      department: departmentFilter === ALL_DEPARTMENTS ? undefined : departmentFilter,
      q: search || undefined,
      sort: sortBy,
    }),
    [departmentFilter, filter, search, sortBy]
  );

  const buildDirectoryPathFilters = useCallback((nodes = selectedDirectoryNodes, maxLevelIndex = activeDirectoryCriteria.length - 1) => {
    const nextFilters = {};
    activeDirectoryCriteria.forEach((criterionKey, index) => {
      if (index > maxLevelIndex) return;
      const node = nodes[criterionKey];
      const filterName = getDirectoryFilterParamName(criterionKey);
      if (!filterName || !node?.groupKey) return;
      nextFilters[filterName] = node.groupKey;
    });
    return nextFilters;
  }, [activeDirectoryCriteria, selectedDirectoryNodes]);

  const fetchDirectoryGroups = useCallback(async (groupBy, pathFilters = {}) => {
    const cacheKey = buildDirectoryGroupCacheKey(groupBy, pathFilters);
    setDirectoryGroupLoadingKeys((current) => ({ ...current, [cacheKey]: true }));
    try {
      const response = await taskAPI.getTaskAssetDirectoryGroups(
        {
          group_by: groupBy,
          ...directoryBaseFilters,
          ...pathFilters,
        },
        { timeout: DATABANK_REQUEST_TIMEOUT_MS }
      );
      setDirectoryGroupsByKey((current) => ({
        ...current,
        [cacheKey]: Array.isArray(response?.items) ? response.items : [],
      }));
    } catch (error) {
      console.error('Failed to load databank directory groups:', error);
      setLoadError('Could not load databank folders right now.');
    } finally {
      setDirectoryGroupLoadingKeys((current) => {
        const next = { ...current };
        delete next[cacheKey];
        return next;
      });
    }
  }, [directoryBaseFilters]);

  const loadDirectoryFiles = useCallback(async ({ pathFilters, append = false }) => {
    const pathKey = buildDirectoryFilePathKey(pathFilters, activeDirectoryCriteria);
    const requestOffset = append ? directoryFilesNextOffset : 0;

    if (append) {
      if (directoryFilesLoading || directoryFilesLoadingMore || !directoryFilesHasMore) {
        return;
      }
      setDirectoryFilesLoadingMore(true);
    } else {
      setDirectoryFilesLoading(true);
      setDirectoryFiles([]);
      setDirectoryFilesHasMore(false);
      setDirectoryFilesNextOffset(0);
      setDirectoryFilesPathKey(pathKey);
    }

    try {
      const response = await taskAPI.getTaskAssetDirectoryFiles(
        {
          offset: requestOffset,
          limit: PAGE_SIZE,
          ...directoryBaseFilters,
          ...pathFilters,
        },
        { timeout: DATABANK_REQUEST_TIMEOUT_MS }
      );
      const rows = Array.isArray(response?.data) ? response.data : [];
      setDirectoryFiles((current) => (
        append
          ? Array.from(new Map([...current, ...rows].map((asset) => [asset.id, asset])).values())
          : rows
      ));
      setDirectoryFilesHasMore(Boolean(response?.hasMore));
      setDirectoryFilesNextOffset(Number.isFinite(response?.nextOffset) ? response.nextOffset : 0);
      setDirectoryFilesPathKey(pathKey);
    } catch (error) {
      console.error('Failed to load databank directory files:', error);
      setLoadError('Could not load databank files right now.');
    } finally {
      if (append) setDirectoryFilesLoadingMore(false);
      else setDirectoryFilesLoading(false);
    }
  }, [activeDirectoryCriteria, directoryBaseFilters, directoryFilesHasMore, directoryFilesLoading, directoryFilesLoadingMore, directoryFilesNextOffset]);

  useEffect(() => {
    if (activeView !== 'directory') {
      return;
    }

    setSelectedDirectoryNodes({});
    setDirectoryGroupsByKey({});
    setDirectoryGroupLoadingKeys({});
    setDirectoryFiles([]);
    setDirectoryFilesLoading(false);
    setDirectoryFilesLoadingMore(false);
    setDirectoryFilesHasMore(false);
    setDirectoryFilesNextOffset(0);
    setDirectoryFilesPathKey('');

    const topLevelCriterion = activeDirectoryCriteria[0];
    if (topLevelCriterion) {
      void fetchDirectoryGroups(topLevelCriterion, {});
    }
  }, [activeView, activeDirectoryCriteria, directoryBaseFilters, fetchDirectoryGroups]);

  useEffect(() => {
    if (activeView !== 'directory') return;

    for (let index = 1; index < activeDirectoryCriteria.length; index += 1) {
      const parentSelected = activeDirectoryCriteria.slice(0, index).every((criterionKey) => selectedDirectoryNodes[criterionKey]);
      if (!parentSelected) {
        break;
      }

      const criterionKey = activeDirectoryCriteria[index];
      const pathFilters = buildDirectoryPathFilters(selectedDirectoryNodes, index - 1);
      const cacheKey = buildDirectoryGroupCacheKey(criterionKey, pathFilters);
      if (!directoryGroupsByKey[cacheKey] && !directoryGroupLoadingKeys[cacheKey]) {
        void fetchDirectoryGroups(criterionKey, pathFilters);
      }

      if (!selectedDirectoryNodes[criterionKey]) {
        break;
      }
    }
  }, [
    activeView,
    activeDirectoryCriteria,
    selectedDirectoryNodes,
    buildDirectoryPathFilters,
    directoryGroupsByKey,
    directoryGroupLoadingKeys,
    fetchDirectoryGroups,
  ]);

  useEffect(() => {
    if (activeView !== 'directory') return;

    const hasFullPath = activeDirectoryCriteria.length > 0
      && activeDirectoryCriteria.every((criterionKey) => selectedDirectoryNodes[criterionKey]);

    if (!hasFullPath) {
      setDirectoryFiles([]);
      setDirectoryFilesHasMore(false);
      setDirectoryFilesNextOffset(0);
      setDirectoryFilesPathKey('');
      setDirectoryFilesLoading(false);
      setDirectoryFilesLoadingMore(false);
      return;
    }

    const pathFilters = buildDirectoryPathFilters(selectedDirectoryNodes);
    const pathKey = buildDirectoryFilePathKey(pathFilters, activeDirectoryCriteria);
    if (directoryFilesLoading || directoryFilesLoadingMore) {
      return;
    }
    if (
      directoryFilesPathKey === pathKey
      && (directoryFiles.length > 0 || !directoryFilesHasMore)
    ) {
      return;
    }

    void loadDirectoryFiles({ pathFilters, append: false });
  }, [
    activeView,
    activeDirectoryCriteria,
    selectedDirectoryNodes,
    buildDirectoryPathFilters,
    directoryFilesPathKey,
    directoryFilesLoading,
    directoryFilesLoadingMore,
    directoryFilesHasMore,
    directoryFiles.length,
    loadDirectoryFiles,
  ]);

  const directoryLevels = useMemo(() => (
    activeDirectoryCriteria.map((criterionKey, index) => {
      const parentSelected = index === 0
        ? true
        : activeDirectoryCriteria.slice(0, index).every((activeKey) => selectedDirectoryNodes[activeKey]);
      const pathFilters = parentSelected && index > 0
        ? buildDirectoryPathFilters(selectedDirectoryNodes, index - 1)
        : {};
      const cacheKey = buildDirectoryGroupCacheKey(criterionKey, pathFilters);
      return {
        criterionKey,
        nodes: parentSelected ? (directoryGroupsByKey[cacheKey] || []) : [],
        selectedNode: selectedDirectoryNodes[criterionKey] || null,
        isEnabled: parentSelected,
        isLoading: !!directoryGroupLoadingKeys[cacheKey],
      };
    })
  ), [
    activeDirectoryCriteria,
    buildDirectoryPathFilters,
    directoryGroupsByKey,
    directoryGroupLoadingKeys,
    selectedDirectoryNodes,
  ]);

  const selectedDirectoryPath = useMemo(
    () => activeDirectoryCriteria.map((criterionKey) => selectedDirectoryNodes[criterionKey]).filter(Boolean),
    [activeDirectoryCriteria, selectedDirectoryNodes]
  );

  const directoryGridTemplate = useMemo(() => {
    const folderColumns = activeDirectoryCriteria.map((criterionKey, index) => (
      criterionKey === 'project' || index === activeDirectoryCriteria.length - 1
        ? 'minmax(220px, 1fr)'
        : 'minmax(180px, 0.85fr)'
    ));
    return [...folderColumns, 'minmax(320px, 1.45fr)'].join(' ');
  }, [activeDirectoryCriteria]);

  const handleDirectoryLevelChange = (slotIndex, nextValue) => {
    setDirectoryStructure((current) => {
      const normalizedValue = `${nextValue || 'none'}`.trim().toLowerCase();
      const next = [...current];
      const currentValue = next[slotIndex];

      if (normalizedValue === currentValue) {
        return current;
      }

      if (normalizedValue === 'none') {
        const activeCount = next.filter((value) => value !== 'none').length;
        if (currentValue === 'none' || activeCount <= 1) {
          return current;
        }
        next[slotIndex] = 'none';
        return normalizeDirectoryStructure(next);
      }

      const duplicateIndex = next.findIndex((value, index) => index !== slotIndex && value === normalizedValue);
      next[slotIndex] = normalizedValue;
      if (duplicateIndex !== -1) {
        next[duplicateIndex] = currentValue || 'none';
      }
      return normalizeDirectoryStructure(next);
    });
    setSelectedDirectoryNodes({});
    setDirectoryGroupsByKey({});
    setDirectoryGroupLoadingKeys({});
    setDirectoryFiles([]);
    setDirectoryFilesLoading(false);
    setDirectoryFilesLoadingMore(false);
    setDirectoryFilesHasMore(false);
    setDirectoryFilesNextOffset(0);
    setDirectoryFilesPathKey('');
  };

  const handleDirectoryNodeSelect = (criterionKey, node) => {
    const criterionIndex = activeDirectoryCriteria.indexOf(criterionKey);
    setSelectedDirectoryNodes((current) => {
      const next = {};
      activeDirectoryCriteria.forEach((activeKey, index) => {
        if (index < criterionIndex) {
          if (current[activeKey]) {
            next[activeKey] = current[activeKey];
          }
          return;
        }
        if (index === criterionIndex) {
          next[activeKey] = node;
        }
      });
      return next;
    });
  };

  const resetDirectoryToLevel = (criterionIndex) => {
    setSelectedDirectoryNodes((current) => {
      const next = {};
      activeDirectoryCriteria.forEach((criterionKey, index) => {
        if (index <= criterionIndex && current[criterionKey]) {
          next[criterionKey] = current[criterionKey];
        }
      });
      return next;
    });
  };

  const handleLoadMoreDirectoryFiles = () => {
    if (!directoryFilesHasMore || directoryFilesLoading || directoryFilesLoadingMore) {
      return;
    }
    const pathFilters = buildDirectoryPathFilters(selectedDirectoryNodes);
    void loadDirectoryFiles({ pathFilters, append: true });
  };

  const renderPreviewContent = (asset) => {
    if (!asset) return null;
    const previewUrl = buildOpenUrl(asset);
    if (!previewUrl) return <div className="trendings-preview-empty">Preview not available</div>;

    const ext = getSourceExtension(asset);

    if (asset.mediaType === 'image') {
      return <img src={previewUrl} alt={asset.filename} className="trendings-preview-image" />;
    }

    if (asset.mediaType === 'video') {
      return <video src={previewUrl} className="trendings-preview-video" controls preload="metadata" />;
    }

    if (asset.mediaType === 'music') {
      return (
        <div className="trendings-preview-audio-wrap">
          <audio src={previewUrl} className="trendings-preview-audio" controls preload="metadata" />
        </div>
      );
    }

    if (ext === 'pdf') {
      return <iframe src={previewUrl} title={asset.filename} className="trendings-preview-frame" />;
    }

    if (asset.stage.includes('link') && asset.url) {
      return (
        <div className="trendings-preview-link">
          <p>External link preview may be restricted by the target site.</p>
          <a href={asset.url} target="_blank" rel="noreferrer">Open Link</a>
        </div>
      );
    }

    return (
      <div className="trendings-preview-link">
        <p>This file type is not embeddable.</p>
        {buildDownloadUrl(asset) ? (
          <button type="button" className="trendings-open-link-btn" onClick={() => downloadAsset(asset)}>
            Download
          </button>
        ) : null}
      </div>
    );
  };

  const renderCardPreview = (asset) => {
    const previewUrl = buildOpenUrl(asset);
    if (!previewUrl) {
      return <div className="trendings-card-fallback">No preview</div>;
    }

    if (asset.mediaType === 'image') {
      return <img src={previewUrl} alt={asset.filename} className="trendings-card-image" loading="lazy" />;
    }

    if (asset.mediaType === 'video') {
      return <div className="trendings-card-fallback">Video Preview</div>;
    }

    if (asset.mediaType === 'music') {
      return <div className="trendings-card-fallback">Audio Preview</div>;
    }

    return <div className="trendings-card-fallback">Text/Document</div>;
  };

  const handleToggleMinimize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }

    setIsMaximized((prev) => !prev);
  };

  if (!isOpen) return null;

  return (
    <>
      <div
        className={`trendings-overlay ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      />
      <div
        className={`trendings-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
      >
        <div className="trendings-header">
          <h2>RMW Data</h2>
          <div className="trendings-controls">
            {!isMinimized && (
              <button
                className="trendings-control-btn"
                onClick={handleToggleMinimize}
                title="Minimize"
              >
                —
              </button>
            )}
            <button
              className="trendings-control-btn"
              onClick={handleToggleMaximize}
              title={isMinimized ? 'Restore' : isMaximized ? 'Restore Size' : 'Maximize'}
            >
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
            </button>
            <button className="trendings-close-btn" onClick={onClose}>×</button>
          </div>
        </div>

        {!isMinimized && (
          <>
            <div className="trendings-search-row">
              <input
                className="trendings-search"
                placeholder="Search across all formats..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>

            <div className="trendings-view-tabs" role="tablist" aria-label="RMW Data Views">
              <button
                type="button"
                role="tab"
                aria-selected={!isDirectoryTab}
                className={`trendings-view-tab ${!isDirectoryTab ? 'active' : ''}`}
                onClick={() => setActiveView('data')}
              >
                Data
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={isDirectoryTab}
                className={`trendings-view-tab ${isDirectoryTab ? 'active' : ''}`}
                onClick={() => setActiveView('directory')}
              >
                Directory
              </button>
            </div>

            {!isDirectoryTab ? (
              <div className="trendings-metrics">
                <div className="metric-card">
                  <div className="metric-title">Loaded References</div>
                  <div className="metric-value">{metrics.loadedReferences}</div>
                  <div className="metric-subvalue">{loadedSummaryText}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-title">Loaded Tasks</div>
                  <div className="metric-value">{metrics.loadedTasks}</div>
                </div>
                <div className="metric-card">
                  <div className="metric-title">Loaded Projects</div>
                  <div className="metric-value">{metrics.loadedProjects}</div>
                </div>
              </div>
            ) : (
              <div className="trendings-footnote trendings-directory-footnote">
                Browse folders first, then load only the files for the selected path. Folder order stays customizable for each user.
              </div>
            )}

            {!isDirectoryTab && (
              <div className="trendings-footnote">
                Fast databank mode is active. These counts reflect the currently loaded matching assets, and load more continues from the last cursor instead of restarting from the beginning.
                {lastLatencyMs != null ? ` Last response: ${Math.round(lastLatencyMs)} ms.` : ''}
              </div>
            )}

            <div className="trendings-filter-row">
              <div className="trendings-select-filters">
                <label className="trendings-filter-select-wrap">
                  <span className="trendings-filter-select-label">Format</span>
                  <select
                    className="trendings-filter-select"
                    value={filter}
                    onChange={(event) => setFilter(event.target.value)}
                  >
                    {MEDIA_FILTERS.map((item) => (
                      <option key={item} value={item}>
                        {getMediaFilterLabel(item)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="trendings-filter-select-wrap">
                  <span className="trendings-filter-select-label">Department</span>
                  <select
                    className="trendings-filter-select"
                    value={departmentFilter}
                    onChange={(event) => setDepartmentFilter(event.target.value)}
                  >
                    {departmentOptions.map((department) => (
                      <option key={department} value={department}>
                        {department === ALL_DEPARTMENTS ? 'All Departments' : department}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <div className="trendings-sort-group">
                <button
                  className={`trendings-sort-btn ${sortBy === 'latest' ? 'active' : ''}`}
                  onClick={() => setSortBy('latest')}
                >
                  Latest
                </button>
                <button
                  className={`trendings-sort-btn ${sortBy === 'top' ? 'active' : ''}`}
                  onClick={() => setSortBy('top')}
                >
                  Best Format
                </button>
              </div>
            </div>

            <div className="trendings-content">
              {loadError && <div className="trendings-state trendings-state-error">{loadError}</div>}
              {isDirectoryTab && (
                <div className="trendings-directory-window">
                  <div className="trendings-directory-header">
                    <div className="trendings-directory-header-copy">
                      <h3>Databank Directory</h3>
                      <p>{directoryStructureSummary}</p>
                    </div>
                    <div className="trendings-directory-structure">
                      <div className="trendings-directory-structure-title">Folder Order</div>
                      <div className="trendings-directory-structure-controls">
                        {directoryStructure.map((criterionKey, index) => (
                          <label key={`directory-level-${index}`} className="trendings-directory-structure-field">
                            <span>Level {index + 1}</span>
                            <select
                              value={criterionKey}
                              onChange={(event) => handleDirectoryLevelChange(index, event.target.value)}
                            >
                              {DIRECTORY_STRUCTURE_OPTIONS.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                        ))}
                      </div>
                      <small>Set a level to None to remove it from the folder path. At least one folder level stays active.</small>
                    </div>
                  </div>

                  {!directoryLevels[0]?.nodes?.length && !directoryLevels[0]?.isLoading ? (
                    <div className="trendings-directory-empty">
                      No databank folders match the current search and filters.
                    </div>
                  ) : (
                    <div
                      className="trendings-directory-grid"
                      style={{ '--trendings-directory-columns': directoryGridTemplate }}
                    >
                      {directoryLevels.map((level, levelIndex) => {
                        const criterion = DIRECTORY_CRITERIA[level.criterionKey];
                        const selectedKey = level.selectedNode?.key || '';
                        return (
                          <div className="trendings-directory-column" key={level.criterionKey}>
                            <div className="trendings-directory-column-title">{criterion?.label || level.criterionKey}</div>
                            <div className="trendings-directory-list">
                              {level.nodes.map((node) => (
                                <button
                                  key={node.key}
                                  className={`trendings-directory-item ${selectedKey === node.key ? 'active' : ''}`}
                                  onClick={() => handleDirectoryNodeSelect(level.criterionKey, node)}
                                >
                                  <span className="trendings-directory-icon">{criterion?.icon || '📁'}</span>
                                  <span className="trendings-directory-name">{node.label}</span>
                                  <span className="trendings-directory-count">{node.assetCount}</span>
                                </button>
                              ))}
                              {level.isLoading && (
                                <div className="trendings-directory-load-state">
                                  Loading {criterion?.label?.toLowerCase() || 'folder'} items...
                                </div>
                              )}
                              {level.nodes.length === 0 && (
                                <div className="trendings-directory-empty">
                                  {level.isEnabled
                                    ? levelIndex === 0
                                      ? `No ${criterion?.label?.toLowerCase() || 'items'} found for the current filters.`
                                      : `Select a ${activeDirectoryCriteria[levelIndex - 1] || 'folder'} to load ${criterion?.label?.toLowerCase() || 'items'}.`
                                    : `Select the previous folder to load ${criterion?.label?.toLowerCase() || 'items'}.`}
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}

                      <div className="trendings-directory-column trendings-directory-files">
                        <div className="trendings-directory-column-title">Files In Selected Folder</div>
                        <div className="trendings-directory-path">
                          <button
                            type="button"
                            className="trendings-directory-breadcrumb"
                            onClick={() => setSelectedDirectoryNodes({})}
                          >
                            Databank
                          </button>
                          {selectedDirectoryPath.map((node, index) => (
                            <React.Fragment key={node.key}>
                              <span>/</span>
                              <button
                                type="button"
                                className={`trendings-directory-breadcrumb ${index === selectedDirectoryPath.length - 1 ? 'active' : ''}`}
                                onClick={() => resetDirectoryToLevel(index)}
                              >
                                {node.label}
                              </button>
                            </React.Fragment>
                          ))}
                        </div>
                        <div className="trendings-directory-file-list">
                          {directoryFiles.map((asset) => (
                            <div key={asset.id} className="trendings-directory-file-card">
                              <div className="trendings-directory-file-top">
                                <div className="trendings-directory-file-badges">
                                  <span className={`type-badge ${asset.mediaType}`}>{asset.mediaType}</span>
                                  <span className="stage-badge">{asset.stage}</span>
                                </div>
                                <div className="trendings-directory-file-upload-meta">
                                  <span className="trendings-directory-file-uploader">
                                    {asset.uploadedByName || asset.createdByName || asset.submittedByName || 'Unknown uploader'}
                                  </span>
                                  <span className="trendings-directory-file-time">
                                    {getAssetActivityTime(asset) ? new Date(getAssetActivityTime(asset)).toLocaleString() : '-'}
                                  </span>
                                </div>
                              </div>
                              <div className="trendings-directory-file-name">{asset.filename}</div>
                              <div className="trendings-directory-file-meta">
                                <span>{asset.taskTitle}</span>
                                <span>{asset.taskNumber}</span>
                              </div>
                              <div className="trendings-directory-file-actions">
                                {(buildOpenUrl(asset) || asset.stage.includes('text')) && (
                                  <button
                                    className="trendings-open-link-btn"
                                    onClick={() => setPreviewAsset(asset)}
                                  >
                                    Preview
                                  </button>
                                )}
                                {buildOpenUrl(asset) && (
                                  <button
                                    className="trendings-open-link-btn"
                                    onClick={() => openAssetInNewTab(asset)}
                                  >
                                    Open
                                  </button>
                                )}
                                {buildDownloadUrl(asset) && (
                                  <button
                                    className="trendings-open-link-btn"
                                    onClick={() => downloadAsset(asset)}
                                  >
                                    Download
                                  </button>
                                )}
                                <button
                                  className="trendings-open-link-btn"
                                  onClick={() => setInfoAsset(asset)}
                                >
                                  Info
                                </button>
                              </div>
                            </div>
                          ))}
                          {directoryFilesLoading && (
                            <div className="trendings-directory-load-state">
                              Loading files for the selected folder...
                            </div>
                          )}
                          {!directoryFilesLoading && directoryFiles.length === 0 && (
                            <div className="trendings-directory-empty">
                              {selectedDirectoryPath.length === activeDirectoryCriteria.length
                                ? 'No files found in this folder.'
                                : 'Select a full folder path to load files here.'}
                            </div>
                          )}
                          {directoryFiles.length > 0 && directoryFilesHasMore && (
                            <div className="trendings-directory-load-more-wrap">
                              <button
                                type="button"
                                className="trendings-load-more-btn"
                                onClick={handleLoadMoreDirectoryFiles}
                                disabled={directoryFilesLoadingMore}
                              >
                                {directoryFilesLoadingMore ? 'Loading more...' : 'Load More Files'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {!isDirectoryTab && (
                loading ? (
                  <div className="trendings-state">Loading references...</div>
                ) : filteredAssets.length === 0 ? (
                  <div className="trendings-state">No references found for this filter.</div>
                ) : (
                  <>
                    <div className="trendings-grid">
                      {filteredAssets.map((asset) => (
                        <div key={asset.id} className="trendings-card">
                          {(asset.mediaType === 'image' || asset.mediaType === 'video' || asset.mediaType === 'music') && (
                            <div className="trendings-card-preview" onClick={() => setPreviewAsset(asset)}>
                              {renderCardPreview(asset)}
                            </div>
                          )}
                          <div className="trendings-card-top">
                            <div className="trendings-card-top-left">
                              <span className={`type-badge ${asset.mediaType}`}>{asset.mediaType}</span>
                              <span className="stage-badge">{asset.stage}</span>
                            </div>
                            <div className="trendings-card-top-right">
                              <div className="trendings-card-upload-meta">
                                <span className="trendings-card-uploader">
                                  {asset.uploadedByName || asset.createdByName || asset.submittedByName || 'Unknown uploader'}
                                </span>
                                <span className="trendings-card-upload-time">
                                  {getAssetActivityTime(asset) ? new Date(getAssetActivityTime(asset)).toLocaleString() : '-'}
                                </span>
                              </div>
                              <div className="trendings-card-menu-wrap">
                                <button
                                  className="trendings-card-menu-btn"
                                  onClick={() =>
                                    setOpenMenuAssetId((prev) => (prev === asset.id ? null : asset.id))
                                  }
                                  title="More"
                                >
                                  ⋮
                                </button>
                                {openMenuAssetId === asset.id && (
                                  <div className="trendings-card-menu">
                                    <button
                                      onClick={() => {
                                        setInfoAsset(asset);
                                        setOpenMenuAssetId(null);
                                      }}
                                    >
                                      Info
                                    </button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                          <h4 className="trendings-title">{asset.filename}</h4>
                          <p className="trendings-meta">{asset.taskTitle} • {asset.taskNumber}</p>
                          <p className="trendings-meta">{asset.projectName || 'No project name'}</p>
                          {!(asset.mediaType === 'image' || asset.mediaType === 'video' || asset.mediaType === 'music') &&
                            (buildOpenUrl(asset) ? (
                              <button className="trendings-open-link-btn" onClick={() => setPreviewAsset(asset)}>
                                Preview
                              </button>
                            ) : (
                              <span className="trendings-no-link">In-app text reference</span>
                            ))}
                        </div>
                      ))}
                    </div>
                    {canLoadMore && (
                      <div className="trendings-load-more-wrap">
                        <button
                          type="button"
                          className="trendings-load-more-btn"
                          onClick={loadMoreAssets}
                          disabled={loadingMore}
                        >
                          {loadingMore ? 'Loading more...' : 'Load More'}
                        </button>
                      </div>
                    )}
                  </>
                )
              )}
            </div>
          </>
        )}
      </div>

      {previewAsset && !isMinimized && (
        <div className="trendings-preview-overlay" onClick={() => setPreviewAsset(null)}>
          <div className="trendings-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trendings-preview-header">
              <div>
                <h3>{previewAsset.filename}</h3>
                <p>{previewAsset.taskTitle} • {previewAsset.taskNumber}</p>
              </div>
              <button className="trendings-preview-close" onClick={() => setPreviewAsset(null)}>×</button>
            </div>
            <div className="trendings-preview-body">{renderPreviewContent(previewAsset)}</div>
          </div>
        </div>
      )}

      {infoAsset && !isMinimized && (
        <div className="trendings-preview-overlay" onClick={() => setInfoAsset(null)}>
          <div className="trendings-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="trendings-preview-header">
              <div>
                <h3>Asset Info</h3>
                <p>{infoAsset.filename}</p>
              </div>
              <button className="trendings-preview-close" onClick={() => setInfoAsset(null)}>×</button>
            </div>
            <div className="trendings-info-body">
              <p><strong>Task:</strong> {infoAsset.taskTitle}</p>
              <p><strong>Task ID:</strong> {infoAsset.taskNumber}</p>
              <p><strong>Project:</strong> {infoAsset.projectName || '-'}</p>
              <p><strong>Uploaded By:</strong> {infoAsset.uploadedByName || infoAsset.createdByName || infoAsset.submittedByName || 'Unknown'}</p>
              <p><strong>Uploader Dept:</strong> {infoAsset.uploadedByDepartment || infoAsset.createdByDepartment || infoAsset.submittedByDepartment || '-'}</p>
              <p><strong>Created By:</strong> {infoAsset.createdByName || 'Unknown'}</p>
              <p><strong>Creator Dept:</strong> {infoAsset.createdByDepartment || '-'}</p>
              <p><strong>Submitted Result By:</strong> {infoAsset.submittedByName || 'Not submitted yet'}</p>
              <p><strong>Created At:</strong> {infoAsset.createdAt ? new Date(infoAsset.createdAt).toLocaleString() : '-'}</p>
              <p><strong>Updated At:</strong> {infoAsset.updatedAt ? new Date(infoAsset.updatedAt).toLocaleString() : '-'}</p>
              <p><strong>Description:</strong> {infoAsset.taskDescription || '-'}</p>
              <p><strong>Result Text:</strong> {infoAsset.taskResultText || '-'}</p>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default TrendingsPanel;
