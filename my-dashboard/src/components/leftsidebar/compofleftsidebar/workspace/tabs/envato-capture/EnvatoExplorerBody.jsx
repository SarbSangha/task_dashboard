import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { envatoCaptureAPI } from '../../../../../../services/api';
import MetricsOverview from './MetricsOverview';
import UserListSidebar from './UserListSidebar';
import GenerationsBrowser from './GenerationsBrowser';
import DownloadsBrowser from './DownloadsBrowser';
import EnvatoGenerationDrawer from './EnvatoGenerationDrawer';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
import { ITEM_TYPE_META, normalizeApiError } from './envatoCaptureUtils';
// Reuses the ChatGPT Capture Center's stylesheet + Kling's card/grid CSS +
// the ai-explorer switcher pills, same as freepik-capture/
// FreepikExplorerBody.jsx - see its own comment for why each import exists.
import '../ChatGptCaptureCenterTab.css';
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';
import '../ai-explorer/AiExplorerTab.css';

const METRICS_REFRESH_MS = 20000;
const OWNERSHIP_OPTIONS = [
  { key: '', label: 'All ownership' },
  { key: 'resolved', label: 'Attributed only' },
  { key: 'unknown', label: 'Unclaimed only' },
];
const ITEM_TYPE_OPTIONS = [
  { key: '', label: 'All Gen AI types' },
  ...Object.entries(ITEM_TYPE_META).map(([key, meta]) => ({ key, label: meta.label })),
];

/**
 * The Envato Capture Center UI - mirrors freepik-capture/FreepikExplorerBody.jsx's
 * structure exactly (full-width card grid + slide-in detail drawer). Three
 * browse modes: "All Generations", "By Employee", and "Downloads" (Envato
 * Elements stock-asset downloads - see providers/envato/models.py's
 * EnvatoDownload docstring for why that's a separate table/endpoint from
 * generations). No separate Search History mode - unlike Freepik, Envato's
 * capture scope doesn't include free-form search.
 */
export default function EnvatoExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');

  const [sidebarMode, setSidebarMode] = useState('all'); // 'all' | 'byEmployee' | 'downloads'
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [selectedUserName, setSelectedUserName] = useState(null);
  const [openGenerationId, setOpenGenerationId] = useState(null);

  const [ownershipFilter, setOwnershipFilter] = useState('');
  const [itemTypeFilter, setItemTypeFilter] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [linkedTasks, setLinkedTasks] = useState([]);
  const [linkedClients, setLinkedClients] = useState([]);
  const [generationsTotal, setGenerationsTotal] = useState(0);
  const [downloadsTotal, setDownloadsTotal] = useState(0);
  const isGenerationsView = sidebarMode === 'all' || (sidebarMode === 'byEmployee' && Boolean(selectedUserId));
  // Task/Client filters also apply to Downloads (gated like a generation -
  // see EnvatoDownload's own docstring), unlike ownership/item-type which
  // are meaningless there (a download is always attributed live, and has
  // no itemType).
  const showTaskClientFilters = isGenerationsView || sidebarMode === 'downloads';

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    if (!toast?.message) return undefined;
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const fetchMetrics = useCallback(async ({ silent = false, announce = false } = {}) => {
    if (!silent) setMetricsLoading(true);
    try {
      const response = await envatoCaptureAPI.getMetrics();
      setMetrics(response.data);
      setMetricsError('');
      if (announce) setToast({ type: 'success', message: 'Metrics refreshed.' });
    } catch (error) {
      const message = normalizeApiError(error, 'Unable to load Envato Capture Center metrics.');
      setMetricsError(message);
      if (announce) setToast({ type: 'error', message });
    } finally {
      setMetricsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) return undefined;
    fetchMetrics();
    const timer = window.setInterval(() => fetchMetrics({ silent: true }), METRICS_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [fetchMetrics, isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    envatoCaptureAPI.getLinkedTasks().then((res) => setLinkedTasks(res.tasks || [])).catch(() => {});
    envatoCaptureAPI.getLinkedClients().then((res) => setLinkedClients(res.clients || [])).catch(() => {});
  }, [isAdmin]);

  const handleSelectUser = useCallback((userId, userName) => {
    setSelectedUserId(userId);
    setSelectedUserName(userName || null);
  }, []);

  const handleBackToUsers = useCallback(() => {
    setSelectedUserId(null);
    setSelectedUserName(null);
  }, []);

  const handleSwitchMode = useCallback((mode) => {
    setSidebarMode(mode);
    setSelectedUserId(null);
    setSelectedUserName(null);
  }, []);

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the Envato Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto', flexWrap: 'wrap' }}>
          <div className="ai-explorer-switcher" role="tablist" aria-label="Browse mode">
            <button
              type="button"
              role="tab"
              aria-selected={sidebarMode === 'all'}
              className={`ai-explorer-provider-pill${sidebarMode === 'all' ? ' active' : ''}`}
              onClick={() => handleSwitchMode('all')}
            >
              All Generations
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarMode === 'byEmployee'}
              className={`ai-explorer-provider-pill${sidebarMode === 'byEmployee' ? ' active' : ''}`}
              onClick={() => handleSwitchMode('byEmployee')}
            >
              By Employee
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={sidebarMode === 'downloads'}
              className={`ai-explorer-provider-pill${sidebarMode === 'downloads' ? ' active' : ''}`}
              onClick={() => handleSwitchMode('downloads')}
            >
              Downloads
            </button>
          </div>
          {isGenerationsView && (
            <select
              className="chatgpt-capture-select"
              aria-label="Filter by ownership"
              value={ownershipFilter}
              onChange={(event) => setOwnershipFilter(event.target.value)}
              style={{ width: 'auto' }}
            >
              {OWNERSHIP_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          )}
          {isGenerationsView && (
            <select
              className="chatgpt-capture-select"
              aria-label="Filter by generation tool"
              value={itemTypeFilter}
              onChange={(event) => setItemTypeFilter(event.target.value)}
              style={{ width: 'auto' }}
            >
              {ITEM_TYPE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
          )}
          {showTaskClientFilters && linkedTasks.length > 0 && (
            <select
              className="chatgpt-capture-select"
              aria-label="Filter by linked task"
              value={taskFilter}
              onChange={(event) => setTaskFilter(event.target.value)}
              style={{ width: 'auto' }}
            >
              <option value="">All tasks</option>
              {linkedTasks.map((task) => (
                <option key={task.id} value={task.id}>{task.name}</option>
              ))}
            </select>
          )}
          {showTaskClientFilters && linkedClients.length > 0 && (
            <select
              className="chatgpt-capture-select"
              aria-label="Filter by linked client"
              value={clientFilter}
              onChange={(event) => setClientFilter(event.target.value)}
              style={{ width: 'auto' }}
            >
              <option value="">All clients</option>
              {linkedClients.map((client) => (
                <option key={client.id} value={client.id}>{client.name}</option>
              ))}
            </select>
          )}
          {isGenerationsView && (
            <span className="chatgpt-capture-panel-subhead">{generationsTotal} generation(s)</span>
          )}
          {sidebarMode === 'downloads' && (
            <span className="chatgpt-capture-panel-subhead">{downloadsTotal} download(s)</span>
          )}
        </div>
        <button
          type="button"
          className="chatgpt-capture-primary-btn"
          onClick={() => fetchMetrics({ announce: true })}
          disabled={metricsLoading}
        >
          {metricsLoading ? 'Refreshing…' : 'Refresh Metrics'}
        </button>
        <button
          type="button"
          className="chatgpt-capture-secondary-btn chatgpt-capture-devtools-toggle"
          onClick={() => setDrawerOpen(true)}
          aria-expanded={drawerOpen}
        >
          🛠 Developer Tools
        </button>
      </div>

      <MetricsOverview metrics={metrics} loading={metricsLoading} error={metricsError} />

      {sidebarMode === 'downloads' ? (
        <DownloadsBrowser
          searchInput={searchInput}
          taskFilter={taskFilter}
          clientFilter={clientFilter}
          onTotalChange={setDownloadsTotal}
        />
      ) : sidebarMode === 'byEmployee' && !selectedUserId ? (
        <UserListSidebar selectedUserId={selectedUserId} onSelectUser={handleSelectUser} />
      ) : (
        <GenerationsBrowser
          ownerUserId={sidebarMode === 'byEmployee' ? selectedUserId : null}
          ownerName={selectedUserName}
          onBackToUsers={handleBackToUsers}
          onOpenGeneration={setOpenGenerationId}
          searchInput={searchInput}
          ownershipFilter={ownershipFilter}
          itemTypeFilter={itemTypeFilter}
          taskFilter={taskFilter}
          clientFilter={clientFilter}
          onTotalChange={setGenerationsTotal}
        />
      )}

      <EnvatoGenerationDrawer generationId={openGenerationId} onClose={() => setOpenGenerationId(null)} />

      <DeveloperToolsDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        metrics={metrics}
        metricsLoading={metricsLoading}
      />

      {toast?.message && (
        <div className={`chatgpt-capture-toast ${toast.type}`} role="status">
          {toast.message}
        </div>
      )}
    </div>
  );
}
