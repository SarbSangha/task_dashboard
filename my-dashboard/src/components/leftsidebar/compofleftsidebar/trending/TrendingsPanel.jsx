import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Grid } from 'react-window';
import { authAPI, taskAPI } from '../../../../services/api';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useNearViewport } from '../../../../hooks/useNearViewport';
import { useElementSize } from '../../../../hooks/useElementSize';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import WindowControls from '../../../common/WindowControls';
import { usePermissions } from '../../../../hooks/usePermissions';
import { buildFileDownloadUrl, buildFileOpenUrl, buildFileThumbnailUrl } from '../../../../utils/fileLinks';
import ToolLogo from '../../../common/ToolLogo';
import RmwExportButton from './RmwExportButton';
import ToolRecordsTab from './ToolRecordsTab';
import { ORIGINAL_SCREEN_TOOLS } from './toolCardRegistry';
import { RMW_TOOL_TABS, RMW_TOOL_TABS_BY_KEY } from './rmwToolTabs';
import './TrendingsPanel.css';
import { formatDateTimeIndia, toIndiaISODate } from '../../../../utils/dateTime';
import { formatShortDateTime, getAvatarHue, getInitials, humanize } from '../../../../utils/taskPresentation';

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

// Text references carry their content on the task rather than in a file.
const getAssetText = (asset) => {
  if (!asset || !['text', 'link'].includes(asset.mediaType)) return '';
  const stage = `${asset.stage || ''}`.toLowerCase();
  if (stage.includes('result')) return `${asset.taskResultText || ''}`.trim();
  if (stage.includes('input')) return `${asset.taskDescription || ''}`.trim();
  return `${asset.taskResultText || asset.taskDescription || ''}`.trim();
};

const getAssetPerson = (asset) =>
  asset?.uploadedByName || asset?.createdByName || asset?.submittedByName || 'Unknown';

const MEDIA_TILE_ICONS = {
  music: <><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>,
  pdf: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1" /><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1" /></>,
  text: <><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13h6M9 17h6" /></>,
};

function MediaTile({ kind, label }) {
  return (
    <div className={`rmw-card-tile rmw-card-tile--${kind}`}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {MEDIA_TILE_ICONS[kind] || MEDIA_TILE_ICONS.text}
      </svg>
      {label && <span>{label}</span>}
    </div>
  );
}

const getAssetActivityTime = (asset) => asset?.updatedAt || asset?.createdAt || null;

const getAssetMenuKey = (asset) =>
  asset?.id ?? asset?.assetId ?? asset?.relativePath ?? asset?.url ?? asset?.filename;

const getDateFolderKey = (asset) => {
  const source = getAssetActivityTime(asset);
  if (!source) return 'unknown-date';
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) return 'unknown-date';
  return toIndiaISODate(parsed);
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

const DATABANK_VIEWS = [
  {
    key: 'data',
    label: 'Data',
    icon: <><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></>,
  },
  {
    key: 'directory',
    label: 'Directory',
    icon: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />,
  },
];

const getMediaFilterLabel = (value) => {
  if (value === 'all') return 'All Formats';
  return `${value || ''}`.toUpperCase();
};


const TrendingsCardPreview = React.memo(function TrendingsCardPreview({ asset, openUrl, thumbnailUrl }) {
  const [previewRef, isNearViewport] = useNearViewport();
  const [thumbnailFailed, setThumbnailFailed] = useState(false);

  useEffect(() => {
    setThumbnailFailed(false);
  }, [thumbnailUrl]);

  if (!openUrl) {
    return <div ref={previewRef} className="trendings-card-lazy-frame"><MediaTile kind={asset.mediaType} label="No file" /></div>;
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
            {...{ fetchpriority: 'low' }}
            onError={(event) => {
              if (openUrl && event.currentTarget.src !== openUrl) {
                event.currentTarget.src = openUrl;
              }
            }}
          />
        ) : (
          <MediaTile kind="text" label="Image" />
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
            {...{ fetchpriority: 'low' }}
            onError={(event) => {
              event.currentTarget.style.display = 'none';
              setThumbnailFailed(true);
            }}
          />
        ) : (
          <MediaTile kind="text" label="Video" />
        )}
      </div>
    );
  }

  if (asset.mediaType === 'music') {
    return <div ref={previewRef} className="trendings-card-lazy-frame"><MediaTile kind="music" label="Audio" /></div>;
  }

  const ext = getSourceExtension(asset);
  return (
    <div ref={previewRef} className="trendings-card-lazy-frame">
      <MediaTile kind={ext === 'pdf' ? 'pdf' : asset.mediaType} label={ext ? ext.toUpperCase() : 'Document'} />
    </div>
  );
});

const TrendingsAssetCard = React.memo(function TrendingsAssetCard({
  asset,
  canDownload,
  isMenuOpen,
  onDownload,
  onInfo,
  onPreview,
  onToggleMenu,
  openUrl,
  thumbnailUrl,
}) {
  const hasMediaPreview = asset.mediaType === 'image' || asset.mediaType === 'video' || asset.mediaType === 'music';
  const text = hasMediaPreview ? '' : getAssetText(asset);
  const canPreview = Boolean(openUrl || text);
  const activityTime = getAssetActivityTime(asset);
  const assetMenuKey = getAssetMenuKey(asset);
  const person = getAssetPerson(asset);
  const taskLine = [asset.taskTitle, asset.taskNumber].filter(Boolean).join(' · ');

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* clipboard blocked; nothing else to do */
    }
    onToggleMenu(assetMenuKey);
  };

  return (
    <div className={`trendings-card rmw-card ${isMenuOpen ? 'menu-open' : ''}`}>
      <div
        className={`rmw-card-preview rmw-card-preview--${asset.mediaType}${canPreview ? ' is-clickable' : ''}`}
        onClick={canPreview ? () => onPreview(asset) : undefined}
        onKeyDown={canPreview ? (event) => { if (event.key === 'Enter') onPreview(asset); } : undefined}
        role={canPreview ? 'button' : undefined}
        tabIndex={canPreview ? 0 : undefined}
        aria-label={canPreview ? `Preview ${asset.filename}` : undefined}
      >
        {hasMediaPreview || !text ? (
          <TrendingsCardPreview asset={asset} openUrl={openUrl} thumbnailUrl={thumbnailUrl} />
        ) : (
          <p className="rmw-card-text">{text}</p>
        )}
        <span className={`type-badge ${asset.mediaType} rmw-card-type`}>{asset.mediaType}</span>
      </div>

      <div className="rmw-card-body">
        <div className="rmw-card-title-row">
          <h4 className="trendings-title" title={asset.filename}>{asset.filename}</h4>
          <div className="trendings-card-menu-wrap">
            <button
              type="button"
              className="trendings-card-menu-btn"
              onClick={(event) => {
                event.stopPropagation();
                onToggleMenu(assetMenuKey);
              }}
              aria-label={`More actions for ${asset.filename}`}
              aria-expanded={isMenuOpen}
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <circle cx="12" cy="5" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="12" cy="19" r="1.7" />
              </svg>
            </button>
            {isMenuOpen && (
              <div className="trendings-card-menu" onClick={(event) => event.stopPropagation()}>
                {canPreview && <button type="button" onClick={() => { onToggleMenu(assetMenuKey); onPreview(asset); }}>Preview</button>}
                <button type="button" onClick={() => onInfo(asset)}>Details</button>
                {text && <button type="button" onClick={copyText}>Copy text</button>}
                {canDownload && openUrl && (
                  <button type="button" onClick={() => onDownload(asset)}>Download</button>
                )}
              </div>
            )}
          </div>
        </div>
        {taskLine && <p className="rmw-card-task" title={taskLine}>{taskLine}</p>}
        <div className="rmw-card-chips">
          {asset.stage && <span className="rmw-card-chip">{humanize(asset.stage)}</span>}
          {asset.projectName && <span className="rmw-card-chip rmw-card-chip--project" title={asset.projectName}>{asset.projectName}</span>}
        </div>
      </div>

      <div className="rmw-card-foot">
        <span className="rmw-card-avatar" style={{ '--hue': getAvatarHue(person) }} aria-hidden="true">{getInitials(person)}</span>
        <span className="rmw-card-person" title={person}>{person}</span>
        <span className="rmw-card-time" title={activityTime ? formatDateTimeIndia(activityTime) : undefined}>
          {activityTime ? formatShortDateTime(activityTime) : '—'}
        </span>
      </div>
    </div>
  );
});

const TrendingsGridCell = React.memo(function TrendingsGridCell({
  ariaAttributes,
  assets,
  buildOpenUrl,
  buildThumbnailUrl,
  canDownload,
  columnCount,
  columnIndex,
  openMenuAssetId,
  onDownload,
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
        canDownload={canDownload}
        isMenuOpen={openMenuAssetId === getAssetMenuKey(asset)}
        onDownload={onDownload}
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
  canDownload,
  canLoadMore,
  loadMoreAssets,
  loadingMore,
  openMenuAssetId,
  onDownload,
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
            canDownload,
            columnCount,
            openMenuAssetId,
            onDownload,
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
  canDownload,
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
        {canDownload && downloadUrl && (
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
  canDownload,
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
        canDownload={canDownload}
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
  canDownload,
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
            canDownload,
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
  const { can, isAdmin } = usePermissions();
  const canDownloadRmwData = can('download_rmw_data');
  const canViewKlingGenerations = can('view_kling_generations');
  // Every tool tab except Kling sits on admin-only capture APIs, so the tab
  // is hidden rather than showing an access-denied body (see rmwToolTabs.js).
  const visibleToolTabs = useMemo(
    () => RMW_TOOL_TABS.filter((tab) => (tab.adminOnly ? isAdmin : canViewKlingGenerations)),
    [isAdmin, canViewKlingGenerations],
  );
  // Each tool tab's search text, keyed by tab. Lifted up here (rather than
  // owned inside each explorer) so the box lives in the panel's own header
  // row, in the slot the Data tab's "Search across all formats..." box uses.
  const [toolSearch, setToolSearch] = useState({});
  // Kling reports its active filters so the export popover can start from them.
  const [klingFilterState, setKlingFilterState] = useState(null);
  // Other tools: the Records view's filters, per tool, for the export popover.
  const [toolFilterState, setToolFilterState] = useState({});
  const handleToolFilters = useCallback((key, value) => {
    setToolFilterState((prev) => (prev[key] === value ? prev : { ...prev, [key]: value }));
  }, []);
  const toolFilterHandlers = useMemo(
    () => Object.fromEntries(RMW_TOOL_TABS.map((tab) => [tab.key, (value) => handleToolFilters(tab.key, value)])),
    [handleToolFilters],
  );
  const tabbarRef = useRef(null);
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
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('trendings-panel', isOpen && isMinimized);
  const [activeView, setActiveView] = useState('data');

  // Freepik's grid isn't virtualized like Kling's (which actively measures
  // its own container and always finds some scrollable area). It used to
  // force the whole panel into maximized mode to work around that, but that
  // fought the user's own window sizing (jumping to full-screen on tab
  // switch and staying there after navigating away). The
  // `.trendings-content--freepik { overflow: auto }` rule below now
  // guarantees the grid is reachable at any panel size, so no forced resize
  // is needed - Freepik behaves like every other tab.
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
    if (!canDownloadRmwData) return null;
    return buildFileDownloadUrl(asset, asset?.filename || 'download') || null;
  }, [canDownloadRmwData]);

  const downloadAsset = useCallback((asset) => {
    if (!canDownloadRmwData) return;
    const downloadUrl = buildDownloadUrl(asset);
    if (!downloadUrl) return;
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [buildDownloadUrl, canDownloadRmwData]);

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
    if (!isOpen || activeView !== 'data') return;
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
  const activeTool = RMW_TOOL_TABS_BY_KEY[activeView] || null;
  const isToolTab = Boolean(activeTool);

  // The tab strip scrolls sideways when it does not fit; keep the active tab visible.
  useEffect(() => {
    tabbarRef.current?.querySelector('.trendings-view-tab.active')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [activeView]);
  const isDataTab = activeView === 'data';
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
    const inAppText = getAssetText(asset);
    if (!previewUrl && inAppText) {
      return (
        <div className="rmw-preview-text">
          <pre>{inAppText}</pre>
          <button type="button" className="trendings-open-link-btn" onClick={() => navigator.clipboard?.writeText(inAppText)}>
            Copy text
          </button>
        </div>
      );
    }
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
        {canDownloadRmwData && buildDownloadUrl(asset) ? (
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
          {!isMinimized && !isToolTab && (
            <div className="trendings-header-search">
              <input
                className="trendings-search"
                placeholder={isDirectoryTab ? 'Search across all formats…' : 'Search files, tasks, projects…'}
                aria-label="Search the databank"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
              />
            </div>
          )}
          {!isMinimized && activeTool && (
            <div className="trendings-header-search">
              <input
                className="trendings-search"
                placeholder={activeTool.searchPlaceholder}
                aria-label={activeTool.searchLabel}
                value={toolSearch[activeTool.key] || ''}
                onChange={(e) => {
                  const { value } = e.target;
                  setToolSearch((prev) => ({ ...prev, [activeTool.key]: value }));
                }}
              />
            </div>
          )}
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <>
            <div className="trendings-tabbar" role="tablist" aria-label="RMW Data views" ref={tabbarRef}>
              <div className="trendings-tab-group">
                <span className="trendings-tab-group-label" aria-hidden="true">Databank</span>
                {DATABANK_VIEWS.map((view) => (
                  <button
                    key={view.key}
                    type="button"
                    role="tab"
                    aria-selected={activeView === view.key}
                    className={`trendings-view-tab ${activeView === view.key ? 'active' : ''}`}
                    onClick={() => setActiveView(view.key)}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      {view.icon}
                    </svg>
                    {view.label}
                  </button>
                ))}
              </div>
              {visibleToolTabs.length > 0 && (
                <div className="trendings-tab-group trendings-tab-group--tools">
                  <span className="trendings-tab-group-label" aria-hidden="true">AI tools</span>
                  {visibleToolTabs.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      role="tab"
                      aria-selected={activeView === tab.key}
                      className={`trendings-view-tab trendings-view-tab--tool ${activeView === tab.key ? 'active' : ''}`}
                      onClick={() => setActiveView(tab.key)}
                    >
                      <ToolLogo name={tab.label} websiteUrl={tab.website} size={16} />
                      {tab.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {activeTool ? (
              <div className="trendings-context-bar">
                <div className="trendings-context-tool">
                  <ToolLogo name={activeTool.label} websiteUrl={activeTool.website} size={30} />
                  <div className="trendings-context-copy">
                    <div className="trendings-context-title">
                      {activeTool.label}
                      <span className="trendings-context-chip">{activeTool.category}</span>
                    </div>
                    <p className="trendings-context-desc">{activeTool.description}</p>
                  </div>
                </div>
                <RmwExportButton
                  tool={activeTool}
                  searchText={toolSearch[activeTool.key] || ''}
                  toolFilters={activeTool.key === 'kling' ? klingFilterState : toolFilterState[activeTool.key] || null}
                />
              </div>
            ) : (
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
                <div className="trendings-toolbar-status">
                  {isDirectoryTab
                    ? 'Pick folders on the left, then load the files in that path.'
                    : loading
                      ? 'Loading…'
                      : `${filteredAssets.length.toLocaleString()}${canLoadMore ? '+' : ''} item${filteredAssets.length === 1 ? '' : 's'}${lastLatencyMs != null ? ` · ${Math.round(lastLatencyMs)} ms` : ''}`}
                </div>
              </div>
            )}

            <div
              className={`trendings-content trendings-content--${isDirectoryTab ? 'directory' : activeTool ? activeTool.key : 'data'}`}
            >
              {!isToolTab && loadError && <div className="trendings-state trendings-state-error">{loadError}</div>}
              {activeTool && (
                activeTool.key === 'kling' || ORIGINAL_SCREEN_TOOLS.has(activeTool.key) ? (
                  // Kling has its own filtered view; Cursor/Claude Code/Figma keep their screens.
                  <activeTool.Body
                    key={activeTool.key}
                    isActive
                    searchInput={toolSearch[activeTool.key] || ''}
                    onFiltersChange={activeTool.key === 'kling' ? setKlingFilterState : undefined}
                  />
                ) : (
                  // Data-driven filters + the tool's own cards and drawers.
                  <ToolRecordsTab
                    key={activeTool.key}
                    tool={activeTool}
                    searchInput={toolSearch[activeTool.key] || ''}
                    onFiltersChange={toolFilterHandlers[activeTool.key]}
                  />
                )
              )}
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
                              canDownload={canDownloadRmwData}
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

              {isDataTab && (
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
                      canDownload={canDownloadRmwData}
                      canLoadMore={canLoadMore}
                      loadMoreAssets={loadMoreAssets}
                      loadingMore={loadingMore}
                      openMenuAssetId={openMenuAssetId}
                      onDownload={downloadAsset}
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
