// src/components/leftsidebar/Leftside.jsx (FunctionalMenu)
import { useState } from 'react';
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
import AssignTaskModal from './compofleftsidebar/asigntask/AssignTaskModal';
import OutboxModal from './compofleftsidebar/outbox/OutboxModal';
import WorkSpaceModal from './compofleftsidebar/workspace/WorkSpaceModal';
import InboxPanel from './compofleftsidebar/inbox/InboxPanel';
import TrackingPanel from './compofleftsidebar/tracking/TrackingPanel';
import AdminRequestPanel from './compofleftsidebar/adminqueue/AdminRequestPanel';
import TrendingsPanel from './compofleftsidebar/trending/TrendingsPanel';
import { usePermissions } from '../../hooks/usePermissions';

const PANEL_TO_ACTIVE = {
  inbox: 'inbox',
  outbox: 'outbox',
  workspace: 'workspace',
  tracking: 'tracking',
  messages: 'message-system',
  'admin-queue': 'admin-queue',
  trendings: 'trendings',
  'create-task': 'create-task',
};

const FunctionalMenu = () => {
  const { can } = usePermissions();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  const panel = pathname.replace(/^\/dashboard\/?/, '').split('/')[0] || '';

  const isInboxPanelOpen = panel === 'inbox';
  const isOutboxModalOpen = panel === 'outbox';
  const isWorkSpaceOpen = panel === 'workspace';
  const isTrackingPanelOpen = panel === 'tracking';
  const isMessageSystemOpen = panel === 'messages';
  const isAdminQueueOpen = panel === 'admin-queue';
  const isTrendingsOpen = panel === 'trendings';
  const isAssignModalOpen = panel === 'create-task';

  const activeItem = PANEL_TO_ACTIVE[panel] || 'tracking-alt';
  const [isCollapsed, setIsCollapsed] = useState(false);
  const workspaceInitialTab = searchParams.get('tab') || 'overview';
  const [editingTask, setEditingTask] = useState(null);
  const [persistedMinimizedPanels, setPersistedMinimizedPanels] = useState({});

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  const goTo = (segment) => navigate(`/dashboard/${segment}`);
  const goHome = () => navigate('/dashboard');
  const isPanelVisible = (panelKey) => panel === panelKey || !!persistedMinimizedPanels[panelKey];
  const setPanelMinimized = (panelKey, isMinimized) => {
    setPersistedMinimizedPanels((prev) => {
      if (!!prev[panelKey] === isMinimized) {
        return prev;
      }

      if (!isMinimized && !prev[panelKey]) {
        return prev;
      }

      return {
        ...prev,
        [panelKey]: isMinimized,
      };
    });
  };
  const activatePanel = (segment, search = '') => {
    navigate(`/dashboard/${segment}${search}`);
  };
  const closePanel = (panelKey) => {
    setPanelMinimized(panelKey, false);
    if (panel === panelKey) {
      goHome();
    }
  };

  const openAssignModal = () => {
    setEditingTask(null);
    goTo('create-task');
  };

  const closeAssignModal = () => {
    setEditingTask(null);
    closePanel('create-task');
  };

  const openInboxPanel = () => {
    goTo('inbox');
  };

  const closeInboxPanel = () => {
    closePanel('inbox');
  };

  const openOutboxModal = () => {
    goTo('outbox');
  };
  
  const closeOutboxModal = () => closePanel('outbox');

  const handleEditTaskFromOutbox = (task) => {
    setEditingTask(task);
    goTo('create-task');
  };
  
  const openWorkSpace = () => navigate('/dashboard/workspace?tab=overview');
  
  const closeWorkSpace = () => closePanel('workspace');

  const handleStartTaskFromInbox = () => {
    navigate('/dashboard/workspace?tab=Tools');
  };

  const openTrackingPanel = () => {
    goTo('tracking');
  };

  const closeTrackingPanel = () => closePanel('tracking');
  const openMessageSystem = () => {
    goTo('messages');
  };
  const closeMessageSystem = () => closePanel('messages');
  const openTrendingsPanel = () => {
    goTo('trendings');
  };
  const closeTrendingsPanel = () => closePanel('trendings');
  const openAdminQueue = () => {
    goTo('admin-queue');
  };
  const closeAdminQueue = () => closePanel('admin-queue');

  return (
    <>
      <aside className={`functional-menu ${isCollapsed ? 'collapsed' : ''}`}>
        <div className="menu-header">
          <h2 className="menu-title">FUNCTIONAL MENU</h2>
          <button
            className="collapse-btn"
            onClick={toggleCollapse}
            aria-label="Toggle menu"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z" />
            </svg>
          </button>
        </div>

        <nav className="menu-items">
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

          <MessageSystemButton
            isActive={activeItem === 'message-system'}
            isOpen={isMessageSystemOpen}
            onClick={openMessageSystem}
          />
          
          <WorkSpaceButton 
            isActive={activeItem === 'workspace'}
            onClick={openWorkSpace}
          />

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
        </nav>
      </aside>

      {/* Assign Task Modal */}
      <AssignTaskModal
        isOpen={isPanelVisible('create-task')}
        onClose={closeAssignModal}
        editingTask={editingTask}
        onMinimizedChange={(isMinimized) => setPanelMinimized('create-task', isMinimized)}
        onActivate={() => activatePanel('create-task')}
      />

      {/* Inbox Panel */}
      <InboxPanel
        isOpen={isPanelVisible('inbox')}
        onClose={closeInboxPanel}
        onStartTaskToWorkspace={handleStartTaskFromInbox}
        onMinimizedChange={(isMinimized) => setPanelMinimized('inbox', isMinimized)}
        onActivate={() => activatePanel('inbox')}
      />

      {/* Tracking Panel */}
      <TrackingPanel
        isOpen={isPanelVisible('tracking')}
        onClose={closeTrackingPanel}
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

      {/* Outbox Modal */}
      <OutboxModal
        isOpen={isPanelVisible('outbox')}
        onClose={closeOutboxModal}
        onEditTask={handleEditTaskFromOutbox}
        onMinimizedChange={(isMinimized) => setPanelMinimized('outbox', isMinimized)}
        onActivate={() => activatePanel('outbox')}
      />

      {/* WorkSpace Modal */}
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
    </>
  );
};

export default FunctionalMenu;
