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

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  const goTo = (segment) => navigate(`/dashboard/${segment}`);
  const goHome = () => navigate('/dashboard');

  const openAssignModal = (taskToEdit = null) => {
    setEditingTask(taskToEdit);
    goTo('create-task');
  };

  const closeAssignModal = () => {
    setEditingTask(null);
    goHome();
  };

  const openInboxPanel = () => {
    goTo('inbox');
  };

  const closeInboxPanel = () => {
    goHome();
  };

  const openOutboxModal = () => {
    goTo('outbox');
  };
  
  const closeOutboxModal = () => goHome();

  const handleEditTaskFromOutbox = (task) => {
    setEditingTask(task);
    goTo('create-task');
  };
  
  const openWorkSpace = () => navigate('/dashboard/workspace?tab=overview');
  
  const closeWorkSpace = () => goHome();

  const handleStartTaskFromInbox = () => {
    navigate('/dashboard/workspace?tab=Tools');
  };

  const openTrackingPanel = () => {
    goTo('tracking');
  };

  const closeTrackingPanel = () => goHome();
  const openMessageSystem = () => {
    goTo('messages');
  };
  const closeMessageSystem = () => goHome();
  const openTrendingsPanel = () => {
    goTo('trendings');
  };
  const closeTrendingsPanel = () => goHome();
  const openAdminQueue = () => {
    goTo('admin-queue');
  };
  const closeAdminQueue = () => goHome();

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
        isOpen={isAssignModalOpen}
        onClose={closeAssignModal}
        editingTask={editingTask}
      />

      {/* Inbox Panel */}
      <InboxPanel
        isOpen={isInboxPanelOpen}
        onClose={closeInboxPanel}
        onStartTaskToWorkspace={handleStartTaskFromInbox}
      />

      {/* Tracking Panel */}
      <TrackingPanel isOpen={isTrackingPanelOpen} onClose={closeTrackingPanel} />
      <GroupMessagePanel isOpen={isMessageSystemOpen} onClose={closeMessageSystem} variant="overlay" />
      <TrendingsPanel isOpen={isTrendingsOpen} onClose={closeTrendingsPanel} />

      {/* Outbox Modal */}
      <OutboxModal
        isOpen={isOutboxModalOpen}
        onClose={closeOutboxModal}
        onEditTask={handleEditTaskFromOutbox}
      />

      {/* WorkSpace Modal */}
      <WorkSpaceModal
        isOpen={isWorkSpaceOpen}
        onClose={closeWorkSpace}
        initialTab={workspaceInitialTab}
      />

      <AdminRequestPanel
        isOpen={isAdminQueueOpen}
        onClose={closeAdminQueue}
      />
    </>
  );
};

export default FunctionalMenu;
