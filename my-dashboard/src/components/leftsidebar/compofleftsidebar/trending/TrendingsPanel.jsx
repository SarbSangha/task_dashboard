import React, { useEffect, useMemo, useState } from 'react';
import { authAPI, taskAPI } from '../../../../services/api';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { buildFileDownloadUrl, buildFileOpenUrl } from '../../../../utils/fileLinks';
import './TrendingsPanel.css';

const MEDIA_FILTERS = ['all', 'text', 'image', 'video', 'music', 'link', 'pdf'];
const ALL_DEPARTMENTS = 'all_departments';
const PAGE_SIZE = 60;

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

const buildDirectoryTree = (rows = []) => {
  const uploaderMap = new Map();

  rows.forEach((asset) => {
    const uploaderName = (asset.createdByName || asset.submittedByName || 'Unknown uploader').trim() || 'Unknown uploader';
    const uploaderKey = uploaderName.toLowerCase();
    const dateKey = getDateFolderKey(asset);
    const projectName = (asset.projectName || 'Unassigned Project').trim() || 'Unassigned Project';
    const projectKey = projectName.toLowerCase();

    let uploaderNode = uploaderMap.get(uploaderKey);
    if (!uploaderNode) {
      uploaderNode = {
        key: uploaderKey,
        name: uploaderName,
        assetCount: 0,
        dates: new Map(),
      };
      uploaderMap.set(uploaderKey, uploaderNode);
    }
    uploaderNode.assetCount += 1;

    let dateNode = uploaderNode.dates.get(dateKey);
    if (!dateNode) {
      dateNode = {
        key: dateKey,
        label: formatDateFolderLabel(dateKey),
        assetCount: 0,
        projects: new Map(),
      };
      uploaderNode.dates.set(dateKey, dateNode);
    }
    dateNode.assetCount += 1;

    let projectNode = dateNode.projects.get(projectKey);
    if (!projectNode) {
      projectNode = {
        key: projectKey,
        name: projectName,
        assetCount: 0,
        assets: [],
      };
      dateNode.projects.set(projectKey, projectNode);
    }
    projectNode.assetCount += 1;
    projectNode.assets.push(asset);
  });

  return Array.from(uploaderMap.values())
    .map((uploader) => ({
      ...uploader,
      dates: Array.from(uploader.dates.values())
        .map((dateNode) => ({
          ...dateNode,
          projects: Array.from(dateNode.projects.values())
            .map((projectNode) => ({
              ...projectNode,
              assets: [...projectNode.assets].sort(
                (a, b) => new Date(getAssetActivityTime(b) || 0) - new Date(getAssetActivityTime(a) || 0)
              ),
            }))
            .sort((a, b) => a.name.localeCompare(b.name)),
        }))
        .sort((a, b) => b.key.localeCompare(a.key)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
};

const TrendingsPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
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
  const [showDirectoryWindow, setShowDirectoryWindow] = useState(false);
  const [selectedUploaderKey, setSelectedUploaderKey] = useState('');
  const [selectedDateKey, setSelectedDateKey] = useState('');
  const [selectedProjectKey, setSelectedProjectKey] = useState('');

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
    if (!isOpen) return;
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setLoadError('');
      try {
        const res = await taskAPI.getTaskAssets({
          offset: 0,
          limit: PAGE_SIZE,
          media_type: filter,
          department: departmentFilter === ALL_DEPARTMENTS ? undefined : departmentFilter,
          q: search || undefined,
          sort: sortBy,
        });
        if (cancelled) return;
        setAssets(Array.isArray(res?.data) ? res.data : []);
        setHasMore(Boolean(res?.hasMore));
      } catch (error) {
        console.error('Failed to load trendings:', error);
        if (cancelled) return;
        setAssets([]);
        setHasMore(false);
        setLoadError('Could not load databank assets right now.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [isOpen, filter, departmentFilter, search, sortBy]);

  const loadMoreAssets = async () => {
    if (loadingMore || loading || !hasMore) return;
    setLoadingMore(true);
    setLoadError('');
    try {
      const res = await taskAPI.getTaskAssets({
        offset: assets.length,
        limit: PAGE_SIZE,
        media_type: filter,
        department: departmentFilter === ALL_DEPARTMENTS ? undefined : departmentFilter,
        q: search || undefined,
        sort: sortBy,
      });
      const nextRows = Array.isArray(res?.data) ? res.data : [];
      setAssets((prev) =>
        Array.from(new Map([...prev, ...nextRows].map((asset) => [asset.id, asset])).values())
      );
      setHasMore(Boolean(res?.hasMore));
    } catch (error) {
      console.error('Failed to load more trendings assets:', error);
      setLoadError('Could not load more databank assets right now.');
    } finally {
      setLoadingMore(false);
    }
  };

  const metrics = useMemo(() => {
    const now = new Date();
    const weekAgo = new Date(now);
    weekAgo.setDate(weekAgo.getDate() - 7);
    const twoWeeksAgo = new Date(now);
    twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

    const thisWeek = assets.filter((x) => x.updatedAt && new Date(x.updatedAt) >= weekAgo).length;
    const prevWeek = assets.filter(
      (x) => x.updatedAt && new Date(x.updatedAt) >= twoWeeksAgo && new Date(x.updatedAt) < weekAgo
    ).length;
    const growth = prevWeek > 0 ? Math.round(((thisWeek - prevWeek) / prevWeek) * 100) : (thisWeek > 0 ? 100 : 0);

    const groupedByTask = assets.reduce((acc, item) => {
      acc[item.taskId] = (acc[item.taskId] || 0) + 1;
      return acc;
    }, {});
    const bestInClass = Object.keys(groupedByTask).length
      ? Object.values(groupedByTask).filter((count) => count >= 3).length
      : 0;

    return {
      totalReferences: assets.length,
      bestInClass,
      weeklyGrowth: growth,
    };
  }, [assets]);

  const filteredAssets = useMemo(() => assets, [assets]);

  const directoryTree = useMemo(() => buildDirectoryTree(filteredAssets), [filteredAssets]);

  useEffect(() => {
    const firstUploader = directoryTree[0] || null;
    const chosenUploader =
      directoryTree.find((item) => item.key === selectedUploaderKey) || firstUploader || null;

    if (!chosenUploader) {
      setSelectedUploaderKey('');
      setSelectedDateKey('');
      setSelectedProjectKey('');
      return;
    }

    if (chosenUploader.key !== selectedUploaderKey) {
      setSelectedUploaderKey(chosenUploader.key);
    }

    const firstDate = chosenUploader.dates[0] || null;
    const chosenDate =
      chosenUploader.dates.find((item) => item.key === selectedDateKey) || firstDate || null;

    if (!chosenDate) {
      setSelectedDateKey('');
      setSelectedProjectKey('');
      return;
    }

    if (chosenDate.key !== selectedDateKey) {
      setSelectedDateKey(chosenDate.key);
    }

    const firstProject = chosenDate.projects[0] || null;
    const chosenProject =
      chosenDate.projects.find((item) => item.key === selectedProjectKey) || firstProject || null;

    if (!chosenProject) {
      setSelectedProjectKey('');
      return;
    }

    if (chosenProject.key !== selectedProjectKey) {
      setSelectedProjectKey(chosenProject.key);
    }
  }, [directoryTree, selectedUploaderKey, selectedDateKey, selectedProjectKey]);

  const selectedUploader = useMemo(
    () => directoryTree.find((item) => item.key === selectedUploaderKey) || null,
    [directoryTree, selectedUploaderKey]
  );

  const selectedDateFolder = useMemo(
    () => selectedUploader?.dates.find((item) => item.key === selectedDateKey) || null,
    [selectedUploader, selectedDateKey]
  );

  const selectedProjectFolder = useMemo(
    () => selectedDateFolder?.projects.find((item) => item.key === selectedProjectKey) || null,
    [selectedDateFolder, selectedProjectKey]
  );

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
      return (
        <video className="trendings-card-video"  muted controls>
          <source src={previewUrl} />
        </video>
      );
    }

    if (asset.mediaType === 'music') {
      return (
        <div className="trendings-card-audio-wrap">
          <div className="trendings-card-audio-label">Audio Preview</div>
          <audio className="trendings-card-audio" controls preload="metadata">
            <source src={previewUrl} />
          </audio>
        </div>
      );
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

            <div className="trendings-metrics">
              <div className="metric-card">
                <div className="metric-title">Loaded References</div>
                <div className="metric-value">{metrics.totalReferences}</div>
              </div>
              <div className="metric-card">
                <div className="metric-title">Best in Class</div>
                <div className="metric-value">{metrics.bestInClass}</div>
              </div>
              <div className="metric-card">
                <div className="metric-title">Weekly Growth</div>
                <div className="metric-value">
                  {metrics.weeklyGrowth >= 0 ? `+${metrics.weeklyGrowth}%` : `${metrics.weeklyGrowth}%`}
                </div>
              </div>
            </div>

            <div className="trendings-footnote">
              Fast databank mode is active. The latest matching assets load first, and you can load more without blocking the panel.
            </div>

            <div className="trendings-filter-row">
              <div className="trendings-filter-group">
                {MEDIA_FILTERS.map((item) => (
                  <button
                    key={item}
                    className={`trendings-chip ${filter === item ? 'active' : ''}`}
                    onClick={() => setFilter(item)}
                  >
                    {item.toUpperCase()}
                  </button>
                ))}
              </div>
              <div className="trendings-filter-group">
                {departmentOptions.map((department) => (
                  <button
                    key={department}
                    className={`trendings-chip ${departmentFilter === department ? 'active' : ''}`}
                    onClick={() => setDepartmentFilter(department)}
                    title={department === ALL_DEPARTMENTS ? 'All departments' : department}
                  >
                    {department === ALL_DEPARTMENTS ? 'ALL DEPTS' : department}
                  </button>
                ))}
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
                <button
                  className={`trendings-sort-btn ${showDirectoryWindow ? 'active' : ''}`}
                  onClick={() => setShowDirectoryWindow((prev) => !prev)}
                >
                  Directory View
                </button>
              </div>
            </div>

            <div className="trendings-content">
              {loadError && <div className="trendings-state trendings-state-error">{loadError}</div>}
              {showDirectoryWindow && (
                <div className="trendings-directory-window">
                  <div className="trendings-directory-header">
                    <div>
                      <h3>Databank Directory</h3>
                      <p>Uploader folder → date folder → project folder → files</p>
                    </div>
                    <button
                      className="trendings-directory-close"
                      onClick={() => setShowDirectoryWindow(false)}
                    >
                      Close
                    </button>
                  </div>

                  {directoryTree.length === 0 ? (
                    <div className="trendings-directory-empty">
                      No databank folders match the current search and filters.
                    </div>
                  ) : (
                    <div className="trendings-directory-grid">
                      <div className="trendings-directory-column">
                        <div className="trendings-directory-column-title">Uploader</div>
                        <div className="trendings-directory-list">
                          {directoryTree.map((uploader) => (
                            <button
                              key={uploader.key}
                              className={`trendings-directory-item ${selectedUploaderKey === uploader.key ? 'active' : ''}`}
                              onClick={() => {
                                setSelectedUploaderKey(uploader.key);
                                setSelectedDateKey('');
                                setSelectedProjectKey('');
                              }}
                            >
                              <span className="trendings-directory-icon">👤</span>
                              <span className="trendings-directory-name">{uploader.name}</span>
                              <span className="trendings-directory-count">{uploader.assetCount}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="trendings-directory-column">
                        <div className="trendings-directory-column-title">Date</div>
                        <div className="trendings-directory-list">
                          {(selectedUploader?.dates || []).map((dateNode) => (
                            <button
                              key={dateNode.key}
                              className={`trendings-directory-item ${selectedDateKey === dateNode.key ? 'active' : ''}`}
                              onClick={() => {
                                setSelectedDateKey(dateNode.key);
                                setSelectedProjectKey('');
                              }}
                            >
                              <span className="trendings-directory-icon">📅</span>
                              <span className="trendings-directory-name">{dateNode.label}</span>
                              <span className="trendings-directory-count">{dateNode.assetCount}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="trendings-directory-column">
                        <div className="trendings-directory-column-title">Project</div>
                        <div className="trendings-directory-list">
                          {(selectedDateFolder?.projects || []).map((projectNode) => (
                            <button
                              key={projectNode.key}
                              className={`trendings-directory-item ${selectedProjectKey === projectNode.key ? 'active' : ''}`}
                              onClick={() => setSelectedProjectKey(projectNode.key)}
                            >
                              <span className="trendings-directory-icon">📁</span>
                              <span className="trendings-directory-name">{projectNode.name}</span>
                              <span className="trendings-directory-count">{projectNode.assetCount}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      <div className="trendings-directory-column trendings-directory-files">
                        <div className="trendings-directory-column-title">Files Of That Day</div>
                        <div className="trendings-directory-path">
                          <button
                            type="button"
                            className="trendings-directory-breadcrumb"
                            onClick={() => {
                              setSelectedUploaderKey('');
                              setSelectedDateKey('');
                              setSelectedProjectKey('');
                            }}
                          >
                            Databank
                          </button>
                          <span>/</span>
                          <button
                            type="button"
                            className="trendings-directory-breadcrumb"
                            onClick={() => {
                              if (!selectedUploader) return;
                              setSelectedUploaderKey(selectedUploader.key);
                              setSelectedDateKey('');
                              setSelectedProjectKey('');
                            }}
                          >
                            {selectedUploader?.name || 'Uploader'}
                          </button>
                          <span>/</span>
                          <button
                            type="button"
                            className="trendings-directory-breadcrumb"
                            onClick={() => {
                              if (!selectedDateFolder) return;
                              setSelectedDateKey(selectedDateFolder.key);
                              setSelectedProjectKey('');
                            }}
                          >
                            {selectedDateFolder?.label || 'Date'}
                          </button>
                          <span>/</span>
                          <button
                            type="button"
                            className="trendings-directory-breadcrumb active"
                            onClick={() => {
                              if (!selectedProjectFolder) return;
                              setSelectedProjectKey(selectedProjectFolder.key);
                            }}
                          >
                            {selectedProjectFolder?.name || 'Project'}
                          </button>
                        </div>
                        <div className="trendings-directory-file-list">
                          {(selectedProjectFolder?.assets || []).map((asset) => (
                            <div key={asset.id} className="trendings-directory-file-card">
                              <div className="trendings-directory-file-top">
                                <div className="trendings-directory-file-badges">
                                  <span className={`type-badge ${asset.mediaType}`}>{asset.mediaType}</span>
                                  <span className="stage-badge">{asset.stage}</span>
                                </div>
                                <span className="trendings-directory-file-time">
                                  {getAssetActivityTime(asset) ? new Date(getAssetActivityTime(asset)).toLocaleString() : '-'}
                                </span>
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
                          {(!selectedProjectFolder || (selectedProjectFolder.assets || []).length === 0) && (
                            <div className="trendings-directory-empty">
                              Select a project folder to see the files inside it.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {loading ? (
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
                  {hasMore && (
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
