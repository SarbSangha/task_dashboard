// src/components/leftsidebar/Leftside.jsx (FunctionalMenu)
import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import './Leftside.css';
import TrackingButton from './compofleftsidebar/tracking/TrackingButton';
import AssignTaskButton from './compofleftsidebar/AssignTaskButton';
import InboxButton from './compofleftsidebar/InboxButton';
import OutboxButton from './compofleftsidebar/OutboxButton';
import MessageSystemButton from './compofleftsidebar/messagesystem/MessageSystemButton';
import GroupMessagePanel from './compofleftsidebar/messagesystem/GroupMessagePanel';
import WorkSpaceButton from './compofleftsidebar/WorkSpaceButton';
import AdminQueueButton from './compofleftsidebar/adminqueue/AdminQueueButton';
import TrendingsButton from './compofleftsidebar/trending/TrendingsButton';
import ReportsButton from './compofleftsidebar/ReportsButton';
import AssignTaskModal from './compofleftsidebar/asigntask/AssignTaskModal';
import OutboxModal from './compofleftsidebar/outbox/OutboxModal';
import WorkSpaceModal from './compofleftsidebar/workspace/WorkSpaceModal';
import InboxPanel from './compofleftsidebar/inbox/InboxPanel';
import TrackingPanel from './compofleftsidebar/tracking/TrackingPanel';
import AdminRequestPanel from './compofleftsidebar/adminqueue/AdminRequestPanel';
import TrendingsPanel from './compofleftsidebar/trending/TrendingsPanel';
import ReportsPanel from '../reports/ReportsPanel';
import { usePermissions } from '../../hooks/usePermissions';

const PANEL_TO_ACTIVE = {
  inbox: 'inbox',
  outbox: 'outbox',
  workspace: 'workspace',
  tracking: 'tracking',
  messages: 'message-system',
  'admin-queue': 'admin-queue',
  trendings: 'trendings',
  reports: 'reports',
  'create-task': 'create-task',
};

const getPanelFromPath = (pathname = '') =>
  pathname.replace(/^\/dashboard\/?/, '').split('/')[0] || '';

const FunctionalMenu = ({ isMobileOpen = false, onMobileClose }) => {
  const { can, isAdmin } = usePermissions();
  const navigate = useNavigate();
  const location = useLocation();
  const { pathname, search } = location;
  const [searchParams] = useSearchParams();

  const panel = getPanelFromPath(pathname);

  const isOutboxModalOpen = panel === 'outbox';
  const isMessageSystemOpen = panel === 'messages';

  const activeItem = PANEL_TO_ACTIVE[panel] || 'tracking-alt';
  const [isCollapsed, setIsCollapsed] = useState(false);
  const workspaceInitialTab = searchParams.get('tab') || 'overview';
  const [editingTask, setEditingTask] = useState(null);
  const [persistedMinimizedPanels, setPersistedMinimizedPanels] = useState({});
  const assignModalRef = useRef(null);
  const previousRouteRef = useRef({ pathname, search });
  const routeInterceptionRef = useRef(false);

  const toggleCollapse = () => setIsCollapsed((v) => !v);

  /* ---- Mobile drawer: body scroll lock + ESC to close ---- */
  useEffect(() => {
    if (!isMobileOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleEsc = (e) => { if (e.key === 'Escape') onMobileClose?.(); };
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.body.style.overflow = prevOverflow;
      document.removeEventListener('keydown', handleEsc);
    };
  }, [isMobileOpen, onMobileClose]);

  /* ---- Close drawer when route changes on mobile ---- */
  const closeMobileOnNav = useCallback(() => {
    if (window.matchMedia('(max-width: 640px)').matches) onMobileClose?.();
  }, [onMobileClose]);

  /* Collapse btn: close drawer on mobile, collapse on desktop */
  const handleCollapseOrClose = () => {
    if (window.matchMedia('(max-width: 640px)').matches) onMobileClose?.();
    else toggleCollapse();
  };

  const confirmLeaveCreateTask = async () => {
    if (panel !== 'create-task') return true;
    if (assignModalRef.current?.consumeNavigationAllowance?.()) return true;
    const canLeaveCreateTask = await assignModalRef.current?.confirmBeforeExit?.();
    if (!canLeaveCreateTask) return false;
    return true;
  };

  const goTo = async (segment) => {
    if (segment !== 'create-task') {
      const canLeave = await confirmLeaveCreateTask();
      if (!canLeave) return;
    }
    closeMobileOnNav();
    navigate(`/dashboard/${segment}`);
  };

  const goHome = async () => {
    const canLeave = await confirmLeaveCreateTask();
    if (!canLeave) return;
    closeMobileOnNav();
    navigate('/dashboard');
  };

  const isPanelVisible = (panelKey) =>
    panel === panelKey || !!persistedMinimizedPanels[panelKey];

  const setPanelMinimized = (panelKey, isMinimized) => {
    setPersistedMinimizedPanels((prev) => {
      if (!!prev[panelKey] === isMinimized) return prev;
      if (!isMinimized && !prev[panelKey]) return prev;
      return { ...prev, [panelKey]: isMinimized };
    });
  };

  const activatePanel = async (segment, search = '') => {
    if (segment !== 'create-task') {
      const canLeave = await confirmLeaveCreateTask();
      if (!canLeave) return;
    }
    navigate(`/dashboard/${segment}${search}`);
  };

  const closePanel = (panelKey) => {
    setPanelMinimized(panelKey, false);
    if (panel === panelKey) void goHome();
  };

  const isCreateTaskVisible = isPanelVisible('create-task');

  const openAssignModal = () => { setEditingTask(null); goTo('create-task'); };
  const closeAssignModal = () => {
    setPanelMinimized('create-task', false);
    if (panel === 'create-task') navigate('/dashboard');
  };

  const openInboxPanel = () => goTo('inbox');
  const closeInboxPanel = () => closePanel('inbox');

  const openOutboxModal = () => goTo('outbox');
  const closeOutboxModal = () => closePanel('outbox');

  const handleEditTaskFromOutbox = (task) => { setEditingTask(task); goTo('create-task'); };
  const handleEditTaskFromTracking = (task) => { setEditingTask(task); goTo('create-task'); };

  const openWorkSpace = async () => {
    const canLeave = await confirmLeaveCreateTask();
    if (!canLeave) return;
    navigate('/dashboard/workspace?tab=overview');
  };
  const closeWorkSpace = () => closePanel('workspace');

  const handleStartTaskFromInbox = () => navigate('/dashboard/workspace?tab=Tools');

  const openTrackingPanel = () => goTo('tracking');
  const closeTrackingPanel = () => closePanel('tracking');

  const openMessageSystem = () => goTo('messages');
  const closeMessageSystem = () => closePanel('messages');

  const openTrendingsPanel = () => goTo('trendings');
  const closeTrendingsPanel = () => closePanel('trendings');

  const openAdminQueue = () => goTo('admin-queue');
  const closeAdminQueue = () => closePanel('admin-queue');

  const openReports = () => goTo('reports');
  const closeReports = () => closePanel('reports');

  useEffect(() => {
    if (isCreateTaskVisible) return;
    setEditingTask(null);
  }, [isCreateTaskVisible]);

  useEffect(() => {
    const previousRoute = previousRouteRef.current;
    const currentRoute = { pathname, search };

    if (routeInterceptionRef.current) {
      previousRouteRef.current = currentRoute;
      return;
    }

    const previousPanel = getPanelFromPath(previousRoute?.pathname || '');
    const currentPanel = getPanelFromPath(pathname);

    if (previousPanel === 'create-task' && currentPanel !== 'create-task') {
      const modalApi = assignModalRef.current;
      if (!modalApi) { previousRouteRef.current = currentRoute; return; }
      if (modalApi.consumeNavigationAllowance?.()) { previousRouteRef.current = currentRoute; return; }
      if (!modalApi.hasUnsavedChanges?.()) { previousRouteRef.current = currentRoute; return; }

      routeInterceptionRef.current = true;
      navigate(`${previousRoute.pathname}${previousRoute.search || ''}`, { replace: true });

      Promise.resolve().then(async () => {
        const canLeave = await modalApi.confirmBeforeExit?.();
        if (canLeave) {
          navigate(`${currentRoute.pathname}${currentRoute.search || ''}`, { replace: true });
          previousRouteRef.current = currentRoute;
        } else {
          previousRouteRef.current = previousRoute;
        }
        routeInterceptionRef.current = false;
      });
      return;
    }

    previousRouteRef.current = currentRoute;
  }, [navigate, pathname, search]);

  return (
    <>
      {/* Mobile overlay backdrop */}
      {isMobileOpen && (
        <div
          className="mobile-menu-overlay"
          onClick={onMobileClose}
          aria-hidden="true"
        />
      )}

      <aside
        id="functional-menu"
        className={`functional-menu${isCollapsed ? ' collapsed' : ''}${isMobileOpen ? ' mobile-open' : ''}`}
        aria-label="Main navigation"
      >
        {/* ── Sidebar Header ── */}
        <div className="sidebar-header">
          <div className="sidebar-brand">
            <span className="sidebar-brand-name">MENU BAR</span>
          </div>

          <button
            className="sidebar-toggle-btn"
            onClick={handleCollapseOrClose}
            aria-label={isMobileOpen ? 'Close navigation' : isCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {isMobileOpen ? (
              /* X icon — close drawer on mobile */
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              /* Chevron left — collapses; rotates 180° when already collapsed */
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
            )}
          </button>
        </div>

        {/* ── Navigation ── */}
        <nav className="sidebar-nav" role="navigation" aria-label="Sidebar navigation">

          {/* ── WORK ── */}
          <div className="nav-section">
            <div className="nav-section-header">
              <span className="nav-section-label">Work</span>
            </div>

            <TrackingButton
              isActive={activeItem === 'tracking'}
              onClick={openTrackingPanel}
            />
            <AssignTaskButton
              isActive={activeItem === 'create-task'}
              onClick={openAssignModal}
            />
            <InboxButton
              isActive={activeItem === 'inbox'}
              onClick={openInboxPanel}
            />
            <OutboxButton
              isActive={activeItem === 'outbox'}
              isOpen={isOutboxModalOpen}
              onClick={openOutboxModal}
            />
            <WorkSpaceButton
              isActive={activeItem === 'workspace'}
              onClick={openWorkSpace}
            />
          </div>

          {/* ── COMMUNICATION ── */}
          <div className="nav-section">
            <div className="nav-section-header">
              <span className="nav-section-label">Communication</span>
            </div>

            <MessageSystemButton
              isActive={activeItem === 'message-system'}
              isOpen={isMessageSystemOpen}
              onClick={openMessageSystem}
            />
          </div>

          {/* ── INSIGHT ── */}
          <div className="nav-section">
            <div className="nav-section-header">
              <span className="nav-section-label">Insight</span>
            </div>

            <TrendingsButton
              isActive={activeItem === 'trendings'}
              onClick={openTrendingsPanel}
            />
            {can('view_admin_queue') && (
              <AdminQueueButton
                isActive={activeItem === 'admin-queue'}
                onClick={openAdminQueue}
              />
            )}
          </div>

          {/* ── ANALYTICS (admin only) ── */}
          {isAdmin && (
            <div className="nav-section">
              <div className="nav-section-header">
                <span className="nav-section-label">Analytics</span>
              </div>

              <ReportsButton
                isActive={activeItem === 'reports'}
                onClick={openReports}
              />
            </div>
          )}

        </nav>
      </aside>

      {/* ── Panels & Modals (business logic unchanged) ── */}

      <AssignTaskModal
        ref={assignModalRef}
        isOpen={isPanelVisible('create-task')}
        onClose={closeAssignModal}
        editingTask={editingTask}
        onMinimizedChange={(isMinimized) => setPanelMinimized('create-task', isMinimized)}
        onActivate={() => activatePanel('create-task')}
      />

      <InboxPanel
        isOpen={isPanelVisible('inbox')}
        onClose={closeInboxPanel}
        onStartTaskToWorkspace={handleStartTaskFromInbox}
        onMinimizedChange={(isMinimized) => setPanelMinimized('inbox', isMinimized)}
        onActivate={() => activatePanel('inbox')}
      />

      <TrackingPanel
        isOpen={isPanelVisible('tracking')}
        onClose={closeTrackingPanel}
        onEditTask={handleEditTaskFromTracking}
        onMinimizedChange={(isMinimized) => setPanelMinimized('tracking', isMinimized)}
        onActivate={() => activatePanel('tracking')}
      />

      <GroupMessagePanel
        isOpen={isPanelVisible('messages')}
        onClose={closeMessageSystem}
        variant="overlay"
        onMinimizedChange={(isMinimized) => setPanelMinimized('messages', isMinimized)}
        onActivate={() => activatePanel('messages')}
      />

      <TrendingsPanel
        isOpen={isPanelVisible('trendings')}
        onClose={closeTrendingsPanel}
        onMinimizedChange={(isMinimized) => setPanelMinimized('trendings', isMinimized)}
        onActivate={() => activatePanel('trendings')}
      />

      <OutboxModal
        isOpen={isPanelVisible('outbox')}
        onClose={closeOutboxModal}
        onEditTask={handleEditTaskFromOutbox}
        onMinimizedChange={(isMinimized) => setPanelMinimized('outbox', isMinimized)}
        onActivate={() => activatePanel('outbox')}
      />

      <WorkSpaceModal
        isOpen={isPanelVisible('workspace')}
        onClose={closeWorkSpace}
        initialTab={workspaceInitialTab}
        onMinimizedChange={(isMinimized) => setPanelMinimized('workspace', isMinimized)}
        onActivate={() => activatePanel('workspace')}
      />

      <AdminRequestPanel
        isOpen={isPanelVisible('admin-queue')}
        onClose={closeAdminQueue}
        onMinimizedChange={(isMinimized) => setPanelMinimized('admin-queue', isMinimized)}
        onActivate={() => activatePanel('admin-queue')}
      />

      <ReportsPanel
        isOpen={isPanelVisible('reports')}
        onClose={closeReports}
        onMinimizedChange={(isMinimized) => setPanelMinimized('reports', isMinimized)}
        onActivate={() => activatePanel('reports')}
      />
    </>
  );
};

export default FunctionalMenu;
