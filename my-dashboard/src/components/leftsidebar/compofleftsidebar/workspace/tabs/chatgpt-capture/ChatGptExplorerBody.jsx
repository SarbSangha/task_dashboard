import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import MetricsOverview from './MetricsOverview';
import UserListSidebar from './UserListSidebar';
import ConversationListSidebar from './ConversationListSidebar';
import ConversationDetailPanel from './ConversationDetailPanel';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
import { normalizeApiError } from './chatgptCaptureUtils';
import '../ChatGptCaptureCenterTab.css';

const METRICS_REFRESH_MS = 20000;

/**
 * The actual ChatGPT Capture Center UI, extracted out of
 * ChatGptCaptureCenterTab.jsx so the same body can be mounted both as its
 * own standalone workspace tab and as the "ChatGPT" panel inside the AI
 * Explorer shell - without duplicating any of this logic. breadcrumbPrefix
 * supplies the leading breadcrumb segment(s) before the User/Conversation
 * segments this component already tracks; only the last prefix segment is
 * clickable (it resets back to the Users list), matching how "ChatGPT" used
 * to behave as the sole leading segment.
 */
export default function ChatGptExplorerBody({ breadcrumbPrefix = ['ChatGPT'] }) {
  const { isAdmin } = usePermissions();
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(true);
  const [metricsError, setMetricsError] = useState('');
  const [selectedUserId, setSelectedUserId] = useState(null);
  const [selectedUserName, setSelectedUserName] = useState(null);
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const [selectedConversationTitle, setSelectedConversationTitle] = useState(null);
  // Developer Tools drawer collapsed by default - this page's job is proving
  // conversations captured correctly, not surfacing internal system metrics
  // as the first thing someone sees.
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

  const handleSelectUser = useCallback((userId, userName) => {
    setSelectedUserId(userId);
    setSelectedUserName(userName || null);
    setSelectedConversationId(null);
    setSelectedConversationTitle(null);
  }, []);

  const handleBackToUsers = useCallback(() => {
    setSelectedUserId(null);
    setSelectedUserName(null);
    setSelectedConversationId(null);
    setSelectedConversationTitle(null);
  }, []);

  const handleSelectConversation = useCallback((conversationId, title) => {
    setSelectedConversationId(conversationId);
    setSelectedConversationTitle(title || null);
  }, []);

  const handleCloseConversation = useCallback(() => {
    setSelectedConversationId(null);
    setSelectedConversationTitle(null);
  }, []);

  // Escape closes the drawer, matching standard overlay/drawer conventions.
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

  const leadingCrumbs = breadcrumbPrefix.slice(0, -1);
  const activeCrumb = breadcrumbPrefix[breadcrumbPrefix.length - 1];

  return (
    <div className="tab-content tab-content-projects chatgpt-capture-tab">
      <div className="chatgpt-capture-breadcrumb">
        {leadingCrumbs.map((segment) => (
          <span key={segment}>{segment}</span>
        ))}
        <span>
          <button type="button" className="chatgpt-capture-breadcrumb-crumb" onClick={handleBackToUsers}>
            {activeCrumb}
          </button>
        </span>
        <span>
          {selectedUserId ? (
            <button
              type="button"
              className="chatgpt-capture-breadcrumb-crumb"
              onClick={() => { setSelectedConversationId(null); setSelectedConversationTitle(null); }}
            >
              {selectedUserName || 'User'}
            </button>
          ) : (
            'Users'
          )}
        </span>
        {selectedConversationId && <span>{selectedConversationTitle || 'Conversation'}</span>}
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

      <div className={`chatgpt-capture-three-col${selectedConversationId ? ' has-selection' : ''}`}>
        <div className="chatgpt-capture-col-sidebar">
          {selectedUserId ? (
            <ConversationListSidebar
              selectedConversationId={selectedConversationId}
              onSelectConversation={handleSelectConversation}
              userId={selectedUserId}
              userName={selectedUserName}
              onBackToUsers={handleBackToUsers}
            />
          ) : (
            <UserListSidebar selectedUserId={selectedUserId} onSelectUser={handleSelectUser} />
          )}
        </div>
        <div className="chatgpt-capture-col-detail">
          <ConversationDetailPanel
            conversationId={selectedConversationId}
            onClose={handleCloseConversation}
            emptyStateMode={selectedUserId ? 'conversation' : 'user'}
          />
        </div>
      </div>

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
