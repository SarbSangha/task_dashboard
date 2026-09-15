import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import MetricsOverview from './MetricsOverview';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
import ChatGptConversationsByPerson from './ChatGptConversationsByPerson';
import { normalizeApiError } from './chatgptCaptureUtils';
import '../ChatGptCaptureCenterTab.css';

const METRICS_REFRESH_MS = 20000;

/**
 * The ChatGPT Capture Center UI - conversations captured, grouped by person
 * (see ChatGptConversationsByPerson.jsx), each expandable to that person's
 * conversations and openable in a full-width transcript drawer. Adopted from
 * the Claude Capture Center's layout (claude-capture/ClaudeExplorerBody.jsx);
 * the old three-column user/conversation/detail browser and its
 * sort/filter/pin/advanced-search controls were retired in favour of this
 * single reading-focused view.
 *
 * breadcrumbPrefix supplies the leading breadcrumb segment(s); the same body
 * is mounted both as its own workspace tab and as the "ChatGPT" panel inside
 * the AI Explorer shell.
 */
export default function ChatGptExplorerBody({ breadcrumbPrefix = ['ChatGPT'] }) {
  const { isAdmin } = usePermissions();
  const [searchInput, setSearchInput] = useState('');
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');
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
      const response = await chatgptCaptureAPI.getMetrics();
      setMetrics(response.data);
      setMetricsError('');
      if (announce) setToast({ type: 'success', message: 'Metrics refreshed.' });
    } catch (error) {
      const message = normalizeApiError(error, 'Unable to load Capture Center metrics.');
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

  // Escape closes the Developer Tools drawer, matching standard overlay conventions.
  useEffect(() => {
    if (!drawerOpen) return undefined;
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') setDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [drawerOpen]);

  if (!isAdmin) {
    return (
      <div className="tab-content tab-content-projects chatgpt-capture-tab">
        <div className="chatgpt-capture-alert">
          Administrator access is required to use the ChatGPT Capture Center.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-breadcrumb">
        {breadcrumbPrefix.map((segment, index) => (
          <span key={segment} className="chatgpt-capture-breadcrumb-crumb">
            {segment}
            {index < breadcrumbPrefix.length - 1 ? ' / ' : ''}
          </span>
        ))}
        <span> / Conversations</span>
      </div>

      <div className="chatgpt-capture-actions">
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

      <div className="chatgpt-capture-actions">
        <input
          type="search"
          className="chatgpt-capture-search-input"
          placeholder="Search people by name, email, or department..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
          style={{ minWidth: 280 }}
        />
      </div>

      <ChatGptConversationsByPerson searchInput={searchInput} />

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
