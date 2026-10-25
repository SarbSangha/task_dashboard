// src/components/leftsidebar/Leftside.jsx (FunctionalMenu)
import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
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
import BufferButton from './compofleftsidebar/buffer/BufferButton';
import ReportsButton from './compofleftsidebar/ReportsButton';
import TaskReportButton from './compofleftsidebar/TaskReportButton';
import CreditReportButton from './compofleftsidebar/CreditReportButton';
import SheetActivityButton from './compofleftsidebar/SheetActivityButton';
import SheetsButton from './compofleftsidebar/SheetsButton';
import AiLibraryButton from './compofleftsidebar/AiLibraryButton';
import AssignTaskModal from './compofleftsidebar/asigntask/AssignTaskModal';
import OutboxModal from './compofleftsidebar/outbox/OutboxModal';
import InboxPanel from './compofleftsidebar/inbox/InboxPanel';
import TrackingPanel from './compofleftsidebar/tracking/TrackingPanel';
import { resumePendingOutput } from '../../utils/pendingOutput';
import { usePermissions } from '../../hooks/usePermissions';
import { useAuth } from '../../context/AuthContext';

// Heavy panels that do nothing while closed: their code (charts, report
// builders, the tool explorers) is downloaded the first time one opens
// instead of with the dashboard. See OnceOpened.
const WorkSpaceModal = lazy(() => import('./compofleftsidebar/workspace/WorkSpaceModal'));
const AdminRequestPanel = lazy(() => import('./compofleftsidebar/adminqueue/AdminRequestPanel'));
const TrendingsPanel = lazy(() => import('./compofleftsidebar/trending/TrendingsPanel'));
const BufferPanel = lazy(() => import('./compofleftsidebar/buffer/BufferPanel'));
const ReportsPanel = lazy(() => import('../reports/ReportsPanel'));
const TaskReportPanel = lazy(() => import('../reports/TaskReportPanel'));
const CreditReportPanel = lazy(() => import('../reports/CreditReportPanel'));
const SheetActivityPanel = lazy(() => import('../reports/SheetActivityPanel'));
const SheetsPanel = lazy(() => import('../sheets/SheetsPanel'));
const AiLibraryPanel = lazy(() => import('../aiLibrary/AiLibraryPanel'));

/* Mounts a lazy panel the first time it opens and keeps it mounted after,
   so a closed or minimized panel keeps its state exactly as before. */
const OnceOpened = ({ open, children }) => {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  if (!opened && !open) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
};

const PANEL_TO_ACTIVE = {
  inbox: 'inbox',
  outbox: 'outbox',
  workspace: 'workspace',
  tracking: 'tracking',
  messages: 'message-system',
  'admin-queue': 'admin-queue',
  trendings: 'trendings',
  buffer: 'buffer',
  reports: 'reports',
  'task-report': 'task-report',
  'credit-report': 'credit-report',
  'credit-consumption': 'credit-consumption',
  'sheet-activity': 'sheet-activity',
  sheets: 'sheets',
  'ai-library': 'ai-library',
  'create-task': 'create-task',
};

const getPanelFromPath = (pathname = '') =>
  pathname.replace(/^\/dashboard\/?/, '').split('/')[0] || '';

const FunctionalMenu = ({ isMobileOpen = false, onMobileClose }) => {
  const { can, isAdmin } = usePermissions();
  const { user: authUser, loading: authLoading } = useAuth();

  // Per-user grants an admin hands out in Admin Queue -> Section Access.
  // Used for both the sidebar buttons and the panels themselves: the panels
  // are routed (/dashboard/trendings, /dashboard/buffer), so hiding only the
  // button would still leave them reachable by typing the URL.
  const canViewRmwData = can('view_rmw_data');
  const canViewBuffer = can('view_buffer');
  const canViewAdminQueue = can('view_admin_queue');
  // Testing Report section: granted per user in Admin Queue -> Section Access.
  const canViewCreditReport = can('view_credit_report');
  // Sheets section: granted per user in Admin Queue -> Section Access.
  const canViewSheetActivity = can('view_sheet_activity');
  // AI Library section: granted per user in Admin Queue -> Section Access.
  const canViewAiLibrary = can('view_ai_library');
  const hasAnyInsightItem = canViewRmwData || canViewBuffer || canViewAdminQueue;
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

  const openBufferPanel = () => goTo('buffer');
  const closeBufferPanel = () => closePanel('buffer');

  /* ---- Bounce off a gated route the user cannot open ---- */
  // Without this, typing /dashboard/trendings while ungranted leaves the
  // user parked on a route that renders nothing. Waits for auth to resolve
  // so a page refresh straight onto a granted section does not redirect in
  // the moment before /me comes back.
  useEffect(() => {
    if (authLoading || !authUser) return;
    if (
      (panel === 'trendings' && !canViewRmwData)
      || (panel === 'buffer' && !canViewBuffer)
      || ((panel === 'credit-report' || panel === 'credit-consumption') && !canViewCreditReport)
      || ((panel === 'sheet-activity' || panel === 'sheets') && !canViewSheetActivity)
      || (panel === 'ai-library' && !canViewAiLibrary)
    ) {
      navigate('/dashboard', { replace: true });
    }
  }, [authLoading, authUser, panel, canViewRmwData, canViewBuffer, canViewCreditReport, canViewSheetActivity,
    canViewAiLibrary, navigate]);

  const openAdminQueue = () => goTo('admin-queue');
  const closeAdminQueue = () => closePanel('admin-queue');

  const openReports = () => goTo('reports');
  const closeReports = () => closePanel('reports');

  const openTaskReport = () => goTo('task-report');
  const closeTaskReport = () => closePanel('task-report');

  // A Credit Report "Open output" link clicked while signed out is parked
  // by OpenOutputPage; reopen it once the user is back on the dashboard.
  useEffect(() => {
    if (!authLoading && authUser) resumePendingOutput(navigate);
  }, [authLoading, authUser, navigate]);

  const openCreditReport = () => goTo('credit-report');
  const closeCreditReport = () => closePanel('credit-report');

  // The original Credit Consumption Report, on its own.
  const openCreditConsumption = () => goTo('credit-consumption');
  const closeCreditConsumption = () => closePanel('credit-consumption');

  const openSheets = () => goTo('sheets');
  const closeSheets = () => closePanel('sheets');

  const openSheetActivity = () => goTo('sheet-activity');
  const closeSheetActivity = () => closePanel('sheet-activity');

  const openAiLibrary = () => goTo('ai-library');
  const closeAiLibrary = () => closePanel('ai-library');

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
          {/* Header is conditional too: with RMW Data and Buffer both
              ungranted and no admin queue, the section would otherwise
              render as a bare "Insight" label with nothing under it. */}
          {hasAnyInsightItem && (
          <div className="nav-section">
            <div className="nav-section-header">
              <span className="nav-section-label">Insight</span>
            </div>

            {canViewRmwData && (
              <TrendingsButton
                isActive={activeItem === 'trendings'}
                onClick={openTrendingsPanel}
              />
            )}
            {canViewBuffer && (
              <BufferButton
                isActive={activeItem === 'buffer'}
                onClick={openBufferPanel}
              />
            )}
            {canViewAdminQueue && (
              <AdminQueueButton
                isActive={activeItem === 'admin-queue'}
                onClick={openAdminQueue}
              />
            )}
          </div>
          )}

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
              <TaskReportButton
                isActive={activeItem === 'task-report'}
                onClick={openTaskReport}
              />
            </div>
          )}

          {/* ── TESTING REPORT (Section Access grant) ── */}
          {canViewCreditReport && (
            <div className="nav-section">
              <div className="nav-section-header">
                <span className="nav-section-label">Testing Report</span>
              </div>

              <CreditReportButton
                isActive={activeItem === 'credit-report'}
                onClick={openCreditReport}
              />
              <CreditReportButton
                label="Credit Consumption"
                isActive={activeItem === 'credit-consumption'}
                onClick={openCreditConsumption}
              />
            </div>
          )}

          {/* ── SHEETS (Section Access grant) ── */}
          {canViewSheetActivity && (
            <div className="nav-section">
              <div className="nav-section-header">
                <span className="nav-section-label">Sheets</span>
              </div>

              <SheetsButton
                isActive={activeItem === 'sheets'}
                onClick={openSheets}
              />
              <SheetActivityButton
                isActive={activeItem === 'sheet-activity'}
                onClick={openSheetActivity}
              />
            </div>
          )}

          {/* ── AI LIBRARY (Section Access grant) ── */}
          {canViewAiLibrary && (
            <div className="nav-section">
              <div className="nav-section-header">
                <span className="nav-section-label">AI Library</span>
              </div>

              <AiLibraryButton
                isActive={activeItem === 'ai-library'}
                onClick={openAiLibrary}
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

      <OnceOpened open={canViewRmwData && isPanelVisible('trendings')}>
        <TrendingsPanel
          isOpen={canViewRmwData && isPanelVisible('trendings')}
          onClose={closeTrendingsPanel}
          onMinimizedChange={(isMinimized) => setPanelMinimized('trendings', isMinimized)}
          onActivate={() => activatePanel('trendings')}
        />
      </OnceOpened>

      <OnceOpened open={canViewBuffer && isPanelVisible('buffer')}>
        <BufferPanel
          isOpen={canViewBuffer && isPanelVisible('buffer')}
          onClose={closeBufferPanel}
          onMinimizedChange={(isMinimized) => setPanelMinimized('buffer', isMinimized)}
          onActivate={() => activatePanel('buffer')}
        />
      </OnceOpened>

      <OutboxModal
        isOpen={isPanelVisible('outbox')}
        onClose={closeOutboxModal}
        onEditTask={handleEditTaskFromOutbox}
        onMinimizedChange={(isMinimized) => setPanelMinimized('outbox', isMinimized)}
        onActivate={() => activatePanel('outbox')}
      />

      <OnceOpened open={isPanelVisible('workspace')}>
        <WorkSpaceModal
          isOpen={isPanelVisible('workspace')}
          onClose={closeWorkSpace}
          initialTab={workspaceInitialTab}
          onMinimizedChange={(isMinimized) => setPanelMinimized('workspace', isMinimized)}
          onActivate={() => activatePanel('workspace')}
        />
      </OnceOpened>

      <OnceOpened open={isPanelVisible('admin-queue')}>
        <AdminRequestPanel
          isOpen={isPanelVisible('admin-queue')}
          onClose={closeAdminQueue}
          onMinimizedChange={(isMinimized) => setPanelMinimized('admin-queue', isMinimized)}
          onActivate={() => activatePanel('admin-queue')}
        />
      </OnceOpened>

      <OnceOpened open={isPanelVisible('reports')}>
        <ReportsPanel
          isOpen={isPanelVisible('reports')}
          onClose={closeReports}
          onMinimizedChange={(isMinimized) => setPanelMinimized('reports', isMinimized)}
          onActivate={() => activatePanel('reports')}
        />
      </OnceOpened>

      <OnceOpened open={isPanelVisible('task-report')}>
        <TaskReportPanel
          isOpen={isPanelVisible('task-report')}
          onClose={closeTaskReport}
          onMinimizedChange={(isMinimized) => setPanelMinimized('task-report', isMinimized)}
          onActivate={() => activatePanel('task-report')}
        />
      </OnceOpened>

      <OnceOpened open={canViewCreditReport && isPanelVisible('credit-report')}>
        <CreditReportPanel
          isOpen={canViewCreditReport && isPanelVisible('credit-report')}
          onClose={closeCreditReport}
          onMinimizedChange={(isMinimized) => setPanelMinimized('credit-report', isMinimized)}
          onActivate={() => activatePanel('credit-report')}
        />
      </OnceOpened>

      <OnceOpened open={canViewCreditReport && isPanelVisible('credit-consumption')}>
        <CreditReportPanel
          variant="original"
          isOpen={canViewCreditReport && isPanelVisible('credit-consumption')}
          onClose={closeCreditConsumption}
          onMinimizedChange={(isMinimized) => setPanelMinimized('credit-consumption', isMinimized)}
          onActivate={() => activatePanel('credit-consumption')}
        />
      </OnceOpened>

      <OnceOpened open={canViewSheetActivity && isPanelVisible('sheets')}>
        <SheetsPanel
          isOpen={canViewSheetActivity && isPanelVisible('sheets')}
          onClose={closeSheets}
          onMinimizedChange={(isMinimized) => setPanelMinimized('sheets', isMinimized)}
          onActivate={() => activatePanel('sheets')}
        />
      </OnceOpened>

      <OnceOpened open={canViewSheetActivity && isPanelVisible('sheet-activity')}>
        <SheetActivityPanel
          isOpen={canViewSheetActivity && isPanelVisible('sheet-activity')}
          onClose={closeSheetActivity}
          onMinimizedChange={(isMinimized) => setPanelMinimized('sheet-activity', isMinimized)}
          onActivate={() => activatePanel('sheet-activity')}
        />
      </OnceOpened>

      <OnceOpened open={canViewAiLibrary && isPanelVisible('ai-library')}>
        <AiLibraryPanel
          isOpen={canViewAiLibrary && isPanelVisible('ai-library')}
          onClose={closeAiLibrary}
          onMinimizedChange={(isMinimized) => setPanelMinimized('ai-library', isMinimized)}
          onActivate={() => activatePanel('ai-library')}
        />
      </OnceOpened>
    </>
  );
};

export default FunctionalMenu;
