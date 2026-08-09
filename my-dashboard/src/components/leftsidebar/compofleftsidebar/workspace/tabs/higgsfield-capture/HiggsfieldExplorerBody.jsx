import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { higgsfieldCaptureAPI } from '../../../../../../services/api';
import MetricsOverview from './MetricsOverview';
import UserListSidebar from './UserListSidebar';
import GenerationsBrowser from './GenerationsBrowser';
import HiggsfieldGenerationDrawer from './HiggsfieldGenerationDrawer';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
import { normalizeApiError } from './higgsfieldCaptureUtils';
// Reuses the ChatGPT Capture Center's stylesheet as-is (chatgpt-capture-*
// class names) rather than duplicating otherwise provider-agnostic layout/
// design-system CSS a second time - see heygen-capture/HeygenExplorerBody.jsx
// for the same reasoning.
import '../ChatGptCaptureCenterTab.css';
// Kling's own card/grid CSS (.kling-card*, .kling-virtual-grid-wrap,
// .kling-skeleton-grid) reused the same way, so Higgsfield generations look
// like the Kling/Freepik/HeyGen cards.
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';
// .ai-explorer-switcher/.ai-explorer-provider-pill (the "All Generations" /
// "By Employee" mode toggle below) - loaded directly here (not inherited from
// a parent) since this component can be mounted standalone inside
// TrendingsPanel.jsx, same reasoning as heygen-capture's identical import.
import '../ai-explorer/AiExplorerTab.css';

const METRICS_REFRESH_MS = 20000;
const OWNERSHIP_OPTIONS = [
  { key: '', label: 'All ownership' },
  { key: 'resolved', label: 'Attributed only' },
  { key: 'unknown', label: 'Unclaimed only' },
];

/**
 * The Higgsfield Capture Center UI - structural twin of
 * heygen-capture/HeygenExplorerBody.jsx: a full-width card grid (generations
 * are visual, not text transcripts) with a slide-in drawer for detail,
 * admin-gated the same way (no dedicated permission key - see
 * TrendingsPanel.jsx).
 *
 * Two browse modes: "All Generations" (default - includes unclaimed rows,
 * since not every Higgsfield generation has a resolvable owner) and
 * "By Employee".
 */
export default function HiggsfieldExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');

  const [sidebarMode, setSidebarMode] = useState('all'); // 'all' | 'byEmployee'
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [selectedUserName, setSelectedUserName] = useState(null);
  const [openGenerationId, setOpenGenerationId] = useState(null);

  // `searchInput` comes from TrendingsPanel's own header, same as HeyGen's.
  const [ownershipFilter, setOwnershipFilter] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [linkedTasks, setLinkedTasks] = useState([]);
  const [linkedClients, setLinkedClients] = useState([]);
  const [generationsTotal, setGenerationsTotal] = useState(0);
  const showGenerationsFilters = !(sidebarMode === 'byEmployee' && !selectedUserId);

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
      const response = await higgsfieldCaptureAPI.getMetrics();
      setMetrics(response.data);
      setMetricsError('');
      if (announce) setToast({ type: 'success', message: 'Metrics refreshed.' });
    } catch (error) {
      const message = normalizeApiError(error, 'Unable to load Higgsfield Capture Center metrics.');
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

  // Task/Client filter dropdown options - every task/client any Higgsfield
  // generation has ever been linked to, not just whatever's currently active.
  useEffect(() => {
    if (!isAdmin) return;
    higgsfieldCaptureAPI.getLinkedTasks().then((res) => setLinkedTasks(res.tasks || [])).catch(() => {});
    higgsfieldCaptureAPI.getLinkedClients().then((res) => setLinkedClients(res.clients || [])).catch(() => {});
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
          Administrator access is required to use the Higgsfield Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-actions">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginRight: 'auto' }}>
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
          </div>
          {showGenerationsFilters && (
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
          {showGenerationsFilters && linkedTasks.length > 0 && (
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
          {showGenerationsFilters && linkedClients.length > 0 && (
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
          {showGenerationsFilters && (
            <span className="chatgpt-capture-panel-subhead">{generationsTotal} generation(s)</span>
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

      {sidebarMode === 'byEmployee' && !selectedUserId ? (
        <UserListSidebar selectedUserId={selectedUserId} onSelectUser={handleSelectUser} />
      ) : (
        <GenerationsBrowser
          ownerUserId={sidebarMode === 'byEmployee' ? selectedUserId : null}
          ownerName={selectedUserName}
          onBackToUsers={handleBackToUsers}
          onOpenGeneration={setOpenGenerationId}
          searchInput={searchInput}
          ownershipFilter={ownershipFilter}
          taskFilter={taskFilter}
          clientFilter={clientFilter}
          onTotalChange={setGenerationsTotal}
        />
      )}

      <HiggsfieldGenerationDrawer generationId={openGenerationId} onClose={() => setOpenGenerationId(null)} />

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
