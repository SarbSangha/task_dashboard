import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Grid } from 'react-window';
import { authAPI, taskAPI } from '../../../../services/api';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { buildFileDownloadUrl, buildFileOpenUrl, buildFileThumbnailUrl } from '../../../../utils/fileLinks';
import './TrendingsPanel.css';

const MEDIA_FILTERS = ['all', 'text', 'image', 'video', 'music', 'link', 'pdf'];
const ALL_DEPARTMENTS = 'all_departments';
const PAGE_SIZE = 60;
const DATABANK_REQUEST_TIMEOUT_MS = 60000;
const DIRECTORY_STRUCTURE_STORAGE_KEY = 'rmw.databank.directory.structure';
const DEFAULT_DIRECTORY_STRUCTURE = ['uploader', 'date', 'project'];
const VIRTUAL_CARD_MIN_WIDTH = 260;
const VIRTUAL_CARD_GAP = 12;
const VIRTUAL_CARD_ROW_HEIGHT = 390;
const DIRECTORY_FILE_ROW_HEIGHT = 168;

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
  } catch {
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

function useNearViewport(rootMargin = '700px') {
  const elementRef = useRef(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const element = elementRef.current;
    if (!element || isNearViewport) return undefined;

    if (typeof IntersectionObserver === 'undefined') {
      setIsNearViewport(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setIsNearViewport(true);
        observer.disconnect();
      },
      { root: null, rootMargin, threshold: 0.01 }
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, [isNearViewport, rootMargin]);

  return [elementRef, isNearViewport];
}

function useElementSize() {
  const elementRef = useRef(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return undefined;

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setSize((current) => {
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);
        if (current.width === width && current.height === height) return current;
        return { width, height };
      });
    };

    updateSize();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateSize);
      return () => window.removeEventListener('resize', updateSize);
    }

    const observer = new ResizeObserver(updateSize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [elementRef, size];
}

const TrendingsCardPreview = React.memo(function TrendingsCardPreview({ asset, openUrl, thumbnailUrl }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    setThumbnailFailed(false);
  }, [thumbnailUrl]);

  if (!openUrl) {
    return <div ref={previewRef} className="trendings-card-fallback">No preview</div>;
  }

  if (asset.mediaType === 'image') {
    return (
      <div ref={previewRef} className="trendings-card-lazy-frame">
        {isNearViewport ? (
          <img
            src={thumbnailUrl || openUrl}
            alt={asset.filename}
            className="trendings-card-image"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            onError={(event) => {
              if (openUrl && event.currentTarget.src !== openUrl) {
                event.currentTarget.src = openUrl;
              }
            }}
          />
        ) : (
          <div className="trendings-card-fallback">Image Preview</div>
        )}
      </div>
    );
  }

  if (asset.mediaType === 'video') {
    return (
      <div ref={previewRef} className="trendings-card-lazy-frame">
        {isNearViewport && thumbnailUrl && !thumbnailFailed ? (
          <img
            src={thumbnailUrl}
            alt={asset.filename}
            className="trendings-card-image"
            loading="lazy"
            decoding="async"
            fetchPriority="low"
            onError={(event) => {
              event.currentTarget.style.display = 'none';
              setThumbnailFailed(true);
            }}
          />
        ) : (
          <div className="trendings-card-fallback">Video Preview</div>
        )}
      </div>
    );
  }

  if (asset.mediaType === 'music') {
    return <div ref={previewRef} className="trendings-card-fallback">Audio Preview</div>;
  }

  return <div ref={previewRef} className="trendings-card-fallback">Text/Document</div>;
});

const TrendingsAssetCard = React.memo(function TrendingsAssetCard({
  asset,
  isMenuOpen,
  onInfo,
  onPreview,
  onToggleMenu,
  openUrl,
  thumbnailUrl,
}) {
  const hasMediaPreview = asset.mediaType === 'image' || asset.mediaType === 'video' || asset.mediaType === 'music';
  const activityTime = getAssetActivityTime(asset);

  return (
    <div className="trendings-card">
      {hasMediaPreview && (
        <div className="trendings-card-preview" onClick={() => onPreview(asset)}>
          <TrendingsCardPreview asset={asset} openUrl={openUrl} thumbnailUrl={thumbnailUrl} />
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
              {activityTime ? new Date(activityTime).toLocaleString() : '-'}
            </span>
          </div>
          <div className="trendings-card-menu-wrap">
            <button
              className="trendings-card-menu-btn"
              onClick={() => onToggleMenu(asset.id)}
              title="More"
            >
              ⋮
            </button>
            {isMenuOpen && (
              <div className="trendings-card-menu">
                <button onClick={() => onInfo(asset)}>
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
      {!hasMediaPreview && (
        openUrl ? (
          <button className="trendings-open-link-btn" onClick={() => onPreview(asset)}>
            Preview
          </button>
        ) : (
          <span className="trendings-no-link">In-app text reference</span>
        )
      )}
    </div>
  );
});

const TrendingsGridCell = React.memo(function TrendingsGridCell({
  ariaAttributes,
  assets,
  buildOpenUrl,
  buildThumbnailUrl,
  columnCount,
  columnIndex,
  openMenuAssetId,
  onInfo,
  onPreview,
  onToggleMenu,
  rowIndex,
  style,
}) {
  const assetIndex = rowIndex * columnCount + columnIndex;
  const asset = assets[assetIndex];
  if (!asset) return null;

  return (
    <div {...ariaAttributes} className="trendings-virtual-cell" style={style}>
      <TrendingsAssetCard
        asset={asset}
        isMenuOpen={openMenuAssetId === asset.id}
        onInfo={onInfo}
        onPreview={onPreview}
        onToggleMenu={onToggleMenu}
        openUrl={buildOpenUrl(asset)}
        thumbnailUrl={buildThumbnailUrl(asset)}
      />
    </div>
  );
});

const TrendingsVirtualGrid = React.memo(function TrendingsVirtualGrid({
  assets,
  buildOpenUrl,
  buildThumbnailUrl,
  canLoadMore,
  loadMoreAssets,
  loadingMore,
  openMenuAssetId,
  onInfo,
  onPreview,
  onToggleMenu,
}) {
  const [gridWrapRef, gridSize] = useElementSize();
  const gridWidth = gridSize.width;
  const gridHeight = gridSize.height;
  const columnCount = Math.max(
    1,
    Math.floor((Math.max(gridWidth, VIRTUAL_CARD_MIN_WIDTH) + VIRTUAL_CARD_GAP) / (VIRTUAL_CARD_MIN_WIDTH + VIRTUAL_CARD_GAP))
  );
  const columnWidth = Math.max(
    VIRTUAL_CARD_MIN_WIDTH,
    Math.floor((Math.max(gridWidth, VIRTUAL_CARD_MIN_WIDTH) - VIRTUAL_CARD_GAP * (columnCount - 1)) / columnCount)
  );
  const rowCount = Math.max(1, Math.ceil(assets.length / columnCount));

  const handleCellsRendered = useCallback(
    ({ rowStopIndex }) => {
      if (!canLoadMore || loadingMore) return;
      if (rowStopIndex >= rowCount - 2) {
        loadMoreAssets();
      }
    },
    [canLoadMore, loadMoreAssets, loadingMore, rowCount]
  );

  return (
    <div className="trendings-virtual-grid-wrap" ref={gridWrapRef}>
      {gridWidth > 0 && gridHeight > 0 && (
        <Grid
          className="trendings-virtual-grid"
          cellComponent={TrendingsGridCell}
          cellProps={{
            assets,
            buildOpenUrl,
            buildThumbnailUrl,
            columnCount,
            openMenuAssetId,
            onInfo,
            onPreview,
            onToggleMenu,
          }}
          columnCount={columnCount}
          columnWidth={columnWidth}
          defaultHeight={620}
          defaultWidth={980}
          onCellsRendered={handleCellsRendered}
          overscanCount={1}
          rowCount={rowCount}
          rowHeight={VIRTUAL_CARD_ROW_HEIGHT}
          style={{ height: gridHeight, width: gridWidth }}
        />
      )}
      {loadingMore && <div className="trendings-virtual-loading">Loading more references...</div>}
    </div>
  );
});

const TrendingsDirectoryFileCard = React.memo(function TrendingsDirectoryFileCard({
  asset,
  buildDownloadUrl,
  buildOpenUrl,
  onDownload,
  onInfo,
  onPreview,
}) {
  const openUrl = buildOpenUrl(asset);
  const downloadUrl = buildDownloadUrl(asset);
  const activityTime = getAssetActivityTime(asset);

  return (
    <div className="trendings-directory-file-card">
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
            {activityTime ? new Date(activityTime).toLocaleString() : '-'}
          </span>
        </div>
      </div>
      <div className="trendings-directory-file-name">{asset.filename}</div>
      <div className="trendings-directory-file-meta">
        <span>{asset.taskTitle}</span>
        <span>{asset.taskNumber}</span>
      </div>
      <div className="trendings-directory-file-actions">
        {(openUrl || asset.stage?.includes('text')) && (
          <button
            className="trendings-open-link-btn"
            onClick={() => onPreview(asset)}
          >
            Preview
          </button>
        )}
        {openUrl && (
          <a
            className="trendings-open-link-btn"
            href={openUrl}
            target="_blank"
            rel="noreferrer"
          >
            Open
          </a>
        )}
        {downloadUrl && (
          <button
            className="trendings-open-link-btn"
            onClick={() => onDownload(asset)}
          >
            Download
          </button>
        )}
        <button
          className="trendings-open-link-btn"
          onClick={() => onInfo(asset)}
        >
          Info
        </button>
      </div>
    </div>
  );
});

const TrendingsDirectoryFileCell = React.memo(function TrendingsDirectoryFileCell({
  ariaAttributes,
  assets,
  buildDownloadUrl,
  buildOpenUrl,
  onDownload,
  onInfo,
  onPreview,
  rowIndex,
  style,
}) {
  const asset = assets[rowIndex];
  if (!asset) return null;

  return (
    <div {...ariaAttributes} className="trendings-directory-file-cell" style={style}>
      <TrendingsDirectoryFileCard
        asset={asset}
        buildDownloadUrl={buildDownloadUrl}
        buildOpenUrl={buildOpenUrl}
        onDownload={onDownload}
        onInfo={onInfo}
        onPreview={onPreview}
      />
    </div>
  );
});

const TrendingsDirectoryFileList = React.memo(function TrendingsDirectoryFileList({
  assets,
  buildDownloadUrl,
  buildOpenUrl,
  canLoadMore,
  loadingMore,
  onDownload,
  onInfo,
  onLoadMore,
  onPreview,
}) {
  const [fileListRef, fileListSize] = useElementSize();
  const listWidth = fileListSize.width;
  const listHeight = fileListSize.height;
  const rowCount = Math.max(1, assets.length);

  const handleCellsRendered = useCallback(
    ({ rowStopIndex }) => {
      if (!canLoadMore || loadingMore) return;
      if (rowStopIndex >= assets.length - 3) {
        onLoadMore();
      }
    },
    [assets.length, canLoadMore, loadingMore, onLoadMore]
  );

  return (
    <div className="trendings-directory-file-virtual-wrap" ref={fileListRef}>
      {listWidth > 0 && listHeight > 0 && (
        <Grid
          className="trendings-directory-file-virtual-grid"
          cellComponent={TrendingsDirectoryFileCell}
          cellProps={{
            assets,
            buildDownloadUrl,
            buildOpenUrl,
            onDownload,
            onInfo,
            onPreview,
          }}
          columnCount={1}
          columnWidth={listWidth}
          defaultHeight={420}
          defaultWidth={360}
          onCellsRendered={handleCellsRendered}
          overscanCount={1}
          rowCount={rowCount}
          rowHeight={DIRECTORY_FILE_ROW_HEIGHT}
          style={{ height: listHeight, width: listWidth }}
        />
      )}
      {loadingMore && <div className="trendings-directory-virtual-loading">Loading more files...</div>}
    </div>
  );
});

const TrendingsPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState(null);
  const [nextOffset, setNextOffset] = useState(null);
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
  const loadMoreInFlightRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(DIRECTORY_STRUCTURE_STORAGE_KEY, JSON.stringify(directoryStructure));
  }, [directoryStructure]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  const buildOpenUrl = useCallback((asset) => {
    return buildFileOpenUrl(asset) || null;
  }, []);

  const buildThumbnailUrl = useCallback((asset) => {
    if (!['image', 'video'].includes(asset?.mediaType)) return null;
    const filename = `${asset?.filename || asset?.originalName || asset?.url || asset?.path || ''}`.toLowerCase();
    const mimetype = `${asset?.mimetype || ''}`.toLowerCase();
    if (mimetype.includes('svg') || filename.endsWith('.svg')) return null;
    return buildFileThumbnailUrl(asset, 360) || null;
  }, []);

  const buildDownloadUrl = useCallback((asset) => {
    return buildFileDownloadUrl(asset, asset?.filename || 'download') || null;
  }, []);

  const downloadAsset = useCallback((asset) => {
    const downloadUrl = buildDownloadUrl(asset);
    if (!downloadUrl) return;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [buildDownloadUrl]);

  const handlePreviewAsset = useCallback((asset) => {
    setPreviewAsset(asset);
  }, []);

  const handleToggleAssetMenu = useCallback((assetId) => {
    setOpenMenuAssetId((prev) => (prev === assetId ? null : assetId));
  }, []);

  const handleInfoAsset = useCallback((asset) => {
    setInfoAsset(asset);
    setOpenMenuAssetId(null);
  }, []);

  useEffect(() => {
    if (!isOpen) return undefined;
    const timer = window.setTimeout(() => {
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [isOpen, searchInput]);

  useEffect(() => {
    setOpenMenuAssetId(null);
  }, [activeView, departmentFilter, filter, search, sortBy]);

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
        setLastLatencyMs(Number.isFinite(res?.latencyMs) ? res.latencyMs : null);
      } catch (error) {
        console.error('Failed to load trendings:', error);
        if (cancelled) return;
        setAssets([]);
        setHasMore(false);
        setNextCursor(null);
        setNextOffset(null);
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
    if (loadMoreInFlightRef.current || loadingMore || loading || !hasMore || (!nextCursor && nextOffset == null)) return;
    loadMoreInFlightRef.current = true;
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
      setLastLatencyMs((current) => (Number.isFinite(res?.latencyMs) ? res.latencyMs : current));
    } catch (error) {
      console.error('Failed to load more trendings assets:', error);
      setLoadError('Could not load more databank assets right now.');
    } finally {
      loadMoreInFlightRef.current = false;
      setLoadingMore(false);
    }
  }, [departmentFilter, filter, hasMore, loading, loadingMore, nextCursor, nextOffset, search, sortBy]);

  const filteredAssets = useMemo(() => assets, [assets]);
  const canLoadMore = hasMore && (Boolean(nextCursor) || nextOffset != null);
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

  const handleLoadMoreDirectoryFiles = useCallback(() => {
    if (!directoryFilesHasMore || directoryFilesLoading || directoryFilesLoadingMore) {
      return;
    }
    const pathFilters = buildDirectoryPathFilters(selectedDirectoryNodes);
    void loadDirectoryFiles({ pathFilters, append: true });
  }, [
    buildDirectoryPathFilters,
    directoryFilesHasMore,
    directoryFilesLoading,
    directoryFilesLoadingMore,
    loadDirectoryFiles,
    selectedDirectoryNodes,
  ]);

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

    if (asset.stage?.includes('link') && asset.url) {
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
          {!isMinimized && (
            <div className="trendings-header-search">
              <input
                className="trendings-search"
                placeholder="Search across all formats..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          )}
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
            <div className="trendings-filter-row">
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
              <div className="trendings-toolbar-status">
                {isDirectoryTab
                  ? 'Browse folders first, then load only the files for the selected path.'
                  : `Fast databank mode is active.${lastLatencyMs != null ? ` Last response: ${Math.round(lastLatencyMs)} ms.` : ''}`}
              </div>
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

            <div className={`trendings-content ${isDirectoryTab ? 'trendings-content--directory' : 'trendings-content--data'}`}>
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
                          {directoryFiles.length > 0 && (
                            <TrendingsDirectoryFileList
                              assets={directoryFiles}
                              buildDownloadUrl={buildDownloadUrl}
                              buildOpenUrl={buildOpenUrl}
                              canLoadMore={directoryFilesHasMore}
                              loadingMore={directoryFilesLoadingMore}
                              onDownload={downloadAsset}
                              onInfo={setInfoAsset}
                              onLoadMore={handleLoadMoreDirectoryFiles}
                              onPreview={setPreviewAsset}
                            />
                          )}
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
                    <TrendingsVirtualGrid
                      assets={filteredAssets}
                      buildOpenUrl={buildOpenUrl}
                      buildThumbnailUrl={buildThumbnailUrl}
                      canLoadMore={canLoadMore}
                      loadMoreAssets={loadMoreAssets}
                      loadingMore={loadingMore}
                      openMenuAssetId={openMenuAssetId}
                      onInfo={handleInfoAsset}
                      onPreview={handlePreviewAsset}
                      onToggleMenu={handleToggleAssetMenu}
                    />
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
