import { useCallback, useEffect, useState } from 'react';
import { usePermissions } from '../../../../../../hooks/usePermissions';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import MetricsOverview from './MetricsOverview';
import UserListSidebar from './UserListSidebar';
import ConversationListSidebar from './ConversationListSidebar';
import ConversationSearchHeader from './ConversationSearchHeader';
import ConversationDetailPanel from './ConversationDetailPanel';
import DeveloperToolsDrawer from './DeveloperToolsDrawer';
import { useConversationSearch } from './useConversationSearch';
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

      {/* Workspace-level chrome (metrics + their Refresh / Developer Tools
          controls) is admin observability, not reading material — hide the
          whole band once a conversation is open so the transcript gets the
          space, and so "Refresh Metrics" isn't offered while metrics are
          hidden. It all returns on the user / conversation-list views. */}
      {!selectedConversationId && (
        <>
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
        </>
      )}

      {selectedUserId ? (
        <UserConversationsSection
          userId={selectedUserId}
          userName={selectedUserName}
          selectedConversationId={selectedConversationId}
          onSelectConversation={handleSelectConversation}
          onBackToUsers={handleBackToUsers}
        >
          <ConversationDetailPanel
            conversationId={selectedConversationId}
            onClose={handleCloseConversation}
            emptyStateMode="conversation"
          />
        </UserConversationsSection>
      ) : (
        <div className="chatgpt-capture-three-col">
          <div className="chatgpt-capture-col-sidebar">
            <UserListSidebar selectedUserId={selectedUserId} onSelectUser={handleSelectUser} />
          </div>
          <div className="chatgpt-capture-col-detail">
            <ConversationDetailPanel
              conversationId={selectedConversationId}
              onClose={handleCloseConversation}
              emptyStateMode="user"
            />
          </div>
        </div>
      )}

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

/**
 * Owns useConversationSearch for the duration a user's conversation list is
 * being browsed - split out as its own component (rather than called
 * conditionally inside ChatGptExplorerBody) so the hook only runs while this
 * section is actually mounted, same as the fetching it drives only used to
 * happen while ConversationListSidebar itself was mounted.
 */
function UserConversationsSection({ userId, userName, selectedConversationId, onSelectConversation, onBackToUsers, children }) {
  const search = useConversationSearch({ userId, selectedConversationId, onSelectConversation });

  return (
    <>
      <ConversationSearchHeader {...search} />
      <div className={`chatgpt-capture-three-col${selectedConversationId ? ' has-selection' : ''}`}>
        <div className="chatgpt-capture-col-sidebar">
          <ConversationListSidebar
            selectedConversationId={selectedConversationId}
            onSelectConversation={onSelectConversation}
            userId={userId}
            userName={userName}
            onBackToUsers={onBackToUsers}
            search={search}
          />
        </div>
        <div className="chatgpt-capture-col-detail">{children}</div>
      </div>
    </>
  );
}
