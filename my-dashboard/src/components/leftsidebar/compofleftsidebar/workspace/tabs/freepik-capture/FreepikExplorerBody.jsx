import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { freepikCaptureAPI } from '../../../../../../services/api';
import MetricsOverview from './MetricsOverview';
import UserListSidebar from './UserListSidebar';
import GenerationsBrowser from './GenerationsBrowser';
import FreepikGenerationDrawer from './FreepikGenerationDrawer';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
import { normalizeApiError } from './freepikCaptureUtils';
// Reuses the ChatGPT Capture Center's stylesheet as-is (chatgpt-capture-*
// class names) rather than duplicating ~3400 lines of otherwise
// provider-agnostic layout/design-system CSS a second time - see
// ChatGptCaptureCenterTab.css. Nothing in that file is actually
// ChatGPT-branded visually; the prefix is just its first consumer's name.
import '../ChatGptCaptureCenterTab.css';
// Kling's own card/grid CSS (.kling-card*, .kling-virtual-grid-wrap,
// .kling-projects-grid/.kling-skeleton-grid) reused the same way, for the
// "make Freepik generations look like the Kling cards" ask.
import '../../../trending/kling/KlingTab.css';
import '../../../trending/TrendingsPanel.css';
// .ai-explorer-switcher/.ai-explorer-provider-pill (the "All Generations" /
// "By Employee" mode toggle below) were previously styled "for free" because
// this component only ever mounted inside AiExplorerTab.jsx, which imports
// this stylesheet itself as a side effect. Now that Freepik lives in RMW
// Data instead (see TrendingsPanel.jsx), that side-effect import never runs,
// so this component needs to load its own styles for the classes it uses
// rather than depending on a parent that may not be mounted.
import '../ai-explorer/AiExplorerTab.css';

const METRICS_REFRESH_MS = 20000;
const OWNERSHIP_OPTIONS = [
  { key: '', label: 'All ownership' },
  { key: 'resolved', label: 'Attributed only' },
  { key: 'unknown', label: 'Unclaimed only' },
];

/**
 * The Freepik/Magnific Capture Center UI. Structurally different from
 * chatgpt-capture/ChatGptExplorerBody.jsx's fixed sidebar+detail split on
 * purpose: generations are visual (an image gallery, not a text
 * transcript), so the primary surface is a full-width card grid - the same
 * presentation trending/kling's KlingTab.jsx uses for Kling generations -
 * with a slide-in drawer for detail instead of a permanent side column.
 *
 * Two browse modes: "All Generations" (default - includes unclaimed rows,
 * important since not every Freepik generation has a resolvable owner, see
 * CAPTURE_CONTRACT.md's ownership decision table) and "By Employee" (pick an
 * employee first, then see just their generations - mirrors ChatGPT's
 * Users -> Conversations drill-in).
 */
export default function FreepikExplorerBody({ searchInput = '' }) {
  const { isAdmin } = usePermissions();
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');

  const [sidebarMode, setSidebarMode] = useState('all'); // 'all' | 'byEmployee'
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [selectedUserName, setSelectedUserName] = useState(null);
  const [openGenerationId, setOpenGenerationId] = useState(null);

  // `searchInput` comes from TrendingsPanel's own header (the "RMW Data"
  // title row) rather than being owned here - see the "search bar should sit
  // between RMW Data and the window controls" request. Ownership filter
  // stays local, rendered next to the All Generations/By Employee switcher.
  const [ownershipFilter, setOwnershipFilter] = useState('');
  const [taskFilter, setTaskFilter] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [linkedTasks, setLinkedTasks] = useState([]);
  const [linkedClients, setLinkedClients] = useState([]);
  const [generationsTotal, setGenerationsTotal] = useState(0);
  // UserListSidebar (picking an employee) has no search/ownership concept of
  // its own - these filters only apply once GenerationsBrowser is showing.
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
      const response = await freepikCaptureAPI.getMetrics();
      setMetrics(response.data);
      setMetricsError('');
      if (announce) setToast({ type: 'success', message: 'Metrics refreshed.' });
    } catch (error) {
      const message = normalizeApiError(error, 'Unable to load Freepik Capture Center metrics.');
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

  // Task/Client filter dropdown options - every task/client any Freepik
  // generation has ever been linked to (see Task/Client Mapping), not just
  // whatever's currently active - a filter needs the full history, unlike
  // the generation gate's own picker.
  useEffect(() => {
    if (!isAdmin) return;
    freepikCaptureAPI.getLinkedTasks().then((res) => setLinkedTasks(res.tasks || [])).catch(() => {});
    freepikCaptureAPI.getLinkedClients().then((res) => setLinkedClients(res.clients || [])).catch(() => {});
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
          Administrator access is required to use the Freepik Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      {/* No breadcrumb here (unlike ChatGPT's explorer body) - this used to
          show "RMW Data > Freepik" / "By Employee", but that's now redundant
          with the RMW Data panel title and the already-selected "Freepik" tab
          strip directly above this component. Resetting to "all" mode is
          already covered by the "All Generations" pill below, and drilling
          back out of a specific employee's generations is already covered by
          GenerationsBrowser's own "<- All Employees" scoped header. */}
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

      <FreepikGenerationDrawer generationId={openGenerationId} onClose={() => setOpenGenerationId(null)} />

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
