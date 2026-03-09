import React, { useEffect, useMemo, useState } from 'react';
import { taskAPI } from '../../../../services/api';
import './TrendingsPanel.css';

const MEDIA_FILTERS = ['all', 'text', 'image', 'video', 'music', 'link', 'pdf'];
const ALL_DEPARTMENTS = 'all_departments';
const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const EXTENSION_MAP = {
  image: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'],
  video: ['mp4', 'mov', 'avi', 'mkv', 'webm'],
  music: ['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac'],
  text: ['txt', 'pdf', 'doc', 'docx', 'csv', 'md', 'json', 'xml'],
};

const detectType = (asset) => {
  const mime = `${asset?.mimetype || ''}`.toLowerCase();
  if (mime === 'text/link') return 'link';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'music';
  if (mime.startsWith('text/')) return 'text';

  const source = `${asset?.url || asset?.filename || asset?.originalName || ''}`.toLowerCase();
  const ext = source.split('.').pop();
  if (ext === 'pdf') return 'pdf';

  if (EXTENSION_MAP.image.includes(ext)) return 'image';
  if (EXTENSION_MAP.video.includes(ext)) return 'video';
  if (EXTENSION_MAP.music.includes(ext)) return 'music';
  return 'text';
};

const getSourceExtension = (asset) => {
  const source = `${asset?.url || asset?.filename || asset?.originalName || ''}`.toLowerCase();
  return source.split('.').pop();
};

const normalizeAssetsFromTask = (task) => {
  const list = [];
  const addAsset = (asset, stage) => {
    if (!asset) return;
    const item = typeof asset === 'string' ? { url: asset } : asset;
    const mediaType = detectType(item);
    list.push({
      id: `${task.id}-${stage}-${item.path || item.url || item.filename || Math.random()}`,
      taskId: task.id,
      taskTitle: task.title || 'Untitled task',
      taskNumber: task.taskNumber || 'N/A',
      taskDescription: task.description || '',
      taskResultText: task.resultText || '',
      taskReference: task.reference || '',
      customerName: task.customerName || '',
      stage,
      mediaType,
      filename: item.filename || item.originalName || item.url || 'Untitled',
      path: item.path || null,
      url: item.url || null,
      createdAt: task.createdAt || null,
      updatedAt: task.updatedAt || null,
      priority: task.priority || 'medium',
      projectName: task.projectName || '',
      createdByName: task.creator?.name || task.createdByName || task.createdBy || null,
      createdByDepartment: task.creator?.department || null,
      fromDepartment: task.fromDepartment || task.from_department || null,
      toDepartment: task.toDepartment || task.to_department || null,
      submittedByName:
        task.submittedByName ||
        task.submitter?.name ||
        (typeof task.submittedBy === 'number' ? `User #${task.submittedBy}` : task.submittedBy || null),
    });
  };

  const inputAttachments = Array.isArray(task.attachments) ? task.attachments : [];
  const resultAttachments = Array.isArray(task.resultAttachments) ? task.resultAttachments : [];
  const links = Array.isArray(task.links) ? task.links : [];
  const resultLinks = Array.isArray(task.resultLinks) ? task.resultLinks : [];

  inputAttachments.forEach((asset) => addAsset(asset, 'input'));
  resultAttachments.forEach((asset) => addAsset(asset, 'result'));
  links.forEach((url) => addAsset({ url, mimetype: 'text/link' }, 'input-link'));
  resultLinks.forEach((url) => addAsset({ url, mimetype: 'text/link' }, 'result-link'));

  if (task.description) {
    addAsset({ filename: 'Task description', mimetype: 'text/plain' }, 'input-text');
  }
  if (task.resultText) {
    addAsset({ filename: 'Result text', mimetype: 'text/plain' }, 'result-text');
  }

  return list;
};

const TrendingsPanel = ({ isOpen, onClose }) => {
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [departmentFilter, setDepartmentFilter] = useState(ALL_DEPARTMENTS);
  const [sortBy, setSortBy] = useState('latest');
  const [previewAsset, setPreviewAsset] = useState(null);
  const [infoAsset, setInfoAsset] = useState(null);
  const [openMenuAssetId, setOpenMenuAssetId] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const buildOpenUrl = (asset) => {
    if (asset?.path) {
      return `${API_BASE}/api/files/open?path=${encodeURIComponent(asset.path)}`;
    }
    if (asset?.url) {
      return `${API_BASE}/api/files/open?url=${encodeURIComponent(asset.url)}`;
    }
    return null;
  };

  useEffect(() => {
    if (!isOpen) return;
    const load = async () => {
      setLoading(true);
      try {
        const res = await taskAPI.getAllTasks();
        const tasks = Array.isArray(res?.tasks) ? res.tasks : [];
        const normalized = tasks.flatMap((task) => normalizeAssetsFromTask(task));
        setAssets(normalized);
      } catch (error) {
        console.error('Failed to load trendings:', error);
        setAssets([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [isOpen]);

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

  const departmentOptions = useMemo(() => {
    const unique = new Set();
    assets.forEach((item) => {
      [item.createdByDepartment, item.fromDepartment, item.toDepartment].forEach((dep) => {
        const value = `${dep || ''}`.trim();
        if (value) unique.add(value);
      });
    });
    return [ALL_DEPARTMENTS, ...Array.from(unique).sort((a, b) => a.localeCompare(b))];
  }, [assets]);

  const filteredAssets = useMemo(() => {
    const q = search.trim().toLowerCase();
    let rows = assets.filter((item) => (filter === 'all' ? true : item.mediaType === filter));

    if (departmentFilter !== ALL_DEPARTMENTS) {
      const target = departmentFilter.toLowerCase();
      rows = rows.filter((item) =>
        [item.createdByDepartment, item.fromDepartment, item.toDepartment].some(
          (dep) => `${dep || ''}`.trim().toLowerCase() === target
        )
      );
    }

    if (q) {
      rows = rows.filter(
        (item) =>
          item.filename.toLowerCase().includes(q) ||
          item.taskTitle.toLowerCase().includes(q) ||
          item.taskNumber.toLowerCase().includes(q) ||
          item.projectName.toLowerCase().includes(q) ||
          (item.taskDescription || '').toLowerCase().includes(q) ||
          (item.taskResultText || '').toLowerCase().includes(q) ||
          (item.taskReference || '').toLowerCase().includes(q) ||
          (item.customerName || '').toLowerCase().includes(q) ||
          (item.createdByName || '').toLowerCase().includes(q) ||
          (item.submittedByName || '').toLowerCase().includes(q)
      );
    }
    if (sortBy === 'top') {
      rows = [...rows].sort((a, b) => (a.priority > b.priority ? -1 : 1));
    } else {
      rows = [...rows].sort(
        (a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
      );
    }
    return rows;
  }, [assets, filter, departmentFilter, search, sortBy]);

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
        <a href={previewUrl} target="_blank" rel="noreferrer">Open in new tab</a>
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
        <video className="trendings-card-video" preload="metadata" muted controls>
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

  if (!isOpen) return null;

  return (
    <>
      <div
        className={`trendings-overlay ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      />
      <div className={`trendings-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}>
        <div className="trendings-header">
          <h2>Trendings Databank</h2>
          <div className="trendings-controls">
            <button
              className="trendings-control-btn"
              onClick={() => setIsMinimized((prev) => !prev)}
              title={isMinimized ? 'Restore' : 'Minimize'}
            >
              {isMinimized ? '▢' : '—'}
            </button>
            <button
              className="trendings-control-btn"
              onClick={() => {
                setIsMaximized((prev) => !prev);
                setIsMinimized(false);
              }}
              title={isMaximized ? 'Restore Size' : 'Maximize'}
            >
              {isMaximized ? '❐' : '□'}
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
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            <div className="trendings-metrics">
              <div className="metric-card">
                <div className="metric-title">Total References</div>
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
              </div>
            </div>

            <div className="trendings-content">
              {loading ? (
                <div className="trendings-state">Loading references...</div>
              ) : filteredAssets.length === 0 ? (
                <div className="trendings-state">No references found for this filter.</div>
              ) : (
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
