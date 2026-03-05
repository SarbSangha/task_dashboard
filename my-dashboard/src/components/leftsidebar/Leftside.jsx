// src/components/leftsidebar/Leftside.jsx (FunctionalMenu)
import { useState } from 'react';
import './Leftside.css';
import TrackingButton from './compofleftsidebar/TrackingButton';
import AssignTaskButton from './compofleftsidebar/AssignTaskButton';
import InboxButton from './compofleftsidebar/InboxButton';
import OutboxButton from './compofleftsidebar/OutboxButton';
import MessageSystemButton from './compofleftsidebar/MessageSystemButton';
import WorkSpaceButton from './compofleftsidebar/WorkSpaceButton';
import AdminQueueButton from './compofleftsidebar/AdminQueueButton';
import AssignTaskModal from './compofleftsidebar/asigntask/AssignTaskModal';
import OutboxModal from './compofleftsidebar/outbox/OutboxModal';
import WorkSpaceModal from './compofleftsidebar/workspace/WorkSpaceModal';
import InboxPanel from './compofleftsidebar/inbox/InboxPanel';
import TrackingPanel from './compofleftsidebar/TrackingPanel';
import AdminRequestPanel from './compofleftsidebar/admin/AdminRequestPanel';
import { useAuth } from '../../context/AuthContext';

const FunctionalMenu = () => {
  const { user } = useAuth();
  const isAdmin = user?.isAdmin || (user?.position || '').toLowerCase() === 'admin' || (user?.roles || []).includes('admin');
  const [activeItem, setActiveItem] = useState('tracking-alt');
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isAssignModalOpen, setIsAssignModalOpen] = useState(false);
  const [isInboxPanelOpen, setIsInboxPanelOpen] = useState(false);
  const [isOutboxModalOpen, setIsOutboxModalOpen] = useState(false);
  const [isWorkSpaceOpen, setIsWorkSpaceOpen] = useState(false);
  const [isTrackingPanelOpen, setIsTrackingPanelOpen] = useState(false);
  const [workspaceInitialTab, setWorkspaceInitialTab] = useState('overview');
  const [editingTask, setEditingTask] = useState(null);
  const [isAdminQueueOpen, setIsAdminQueueOpen] = useState(false);

  const handleItemClick = (itemId) => {
    setActiveItem(itemId);
    console.log(`Clicked: ${itemId}`);
  };

  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  const openAssignModal = (taskToEdit = null) => {
    setActiveItem('create-task');
    setEditingTask(taskToEdit);
    setIsAssignModalOpen(true);
  };

  const closeAssignModal = () => {
    setIsAssignModalOpen(false);
    setEditingTask(null);
  };

  const openInboxPanel = () => {
    setActiveItem('inbox');
    setIsInboxPanelOpen(true);
  };

  const closeInboxPanel = () => {
    setIsInboxPanelOpen(false);
  };

  const openOutboxModal = () => {
    setActiveItem('outbox');
    setIsOutboxModalOpen(true);
  };
  
  const closeOutboxModal = () => setIsOutboxModalOpen(false);

  const handleEditTaskFromOutbox = (task) => {
    setIsOutboxModalOpen(false);
    openAssignModal(task);
  };
  
  const openWorkSpace = () => {
    setActiveItem('workspace');
    setWorkspaceInitialTab('overview');
    setIsWorkSpaceOpen(true);
  };
  
  const closeWorkSpace = () => setIsWorkSpaceOpen(false);

  const handleStartTaskFromInbox = () => {
    setIsInboxPanelOpen(false);
    setActiveItem('workspace');
    setWorkspaceInitialTab('Tools');
    setIsWorkSpaceOpen(true);
  };

  const openTrackingPanel = () => {
    setActiveItem('tracking');
    setIsTrackingPanelOpen(true);
  };

  const closeTrackingPanel = () => setIsTrackingPanelOpen(false);
  const openAdminQueue = () => {
    setActiveItem('admin-queue');
    setIsAdminQueueOpen(true);
  };
  const closeAdminQueue = () => setIsAdminQueueOpen(false);

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
            onClick={openOutboxModal}
          />

          <MessageSystemButton
            isActive={activeItem === 'message-system'}
            onClick={() => handleItemClick('message-system')}
          />
          
          <WorkSpaceButton 
            isActive={activeItem === 'workspace'}
            onClick={openWorkSpace}
          />

          {isAdmin && (
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
