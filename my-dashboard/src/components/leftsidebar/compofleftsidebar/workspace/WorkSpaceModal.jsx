import React, { Suspense, lazy, useEffect, useState } from 'react';
import './WorkSpaceModal.css';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { WorkspaceSkeleton } from '../../../ui/WorkspaceSkeleton';

const OverviewTab = lazy(() => import('./tabs/OverviewTab'));
const ProjectsTab = lazy(() => import('./tabs/ProjectsTab'));
const TasksTab = lazy(() => import('./tabs/TasksTab'));
const TeamTab = lazy(() => import('./tabs/TeamTab'));
const CompanyTab = lazy(() => import('./tabs/CompanyTab'));
const AnalyticsTab = lazy(() => import('./tabs/AnalyticsTab'));
const ToolsTab = lazy(() => import('./tabs/ToolsTab'));

const TAB_ITEMS = [
  { key: 'overview', label: 'Overview', icon: '📈' },
  { key: 'projects', label: 'Projects', icon: '📁' },
  { key: 'tasks', label: 'Tasks', icon: '✓' },
  { key: 'team', label: 'Team', icon: '👥' },
  { key: 'company', label: 'Company', icon: '🏢' },
  { key: 'analytics', label: 'Analytics', icon: '📊' },
  { key: 'Tools', label: 'Tools', icon: '🧰' },
];

const TAB_COMPONENTS = {
  overview: OverviewTab,
  projects: ProjectsTab,
  tasks: TasksTab,
  team: TeamTab,
  company: CompanyTab,
  analytics: AnalyticsTab,
  Tools: ToolsTab,
};

const TAB_SKELETON_VARIANTS = {
  overview: 'overview',
  projects: 'projects',
  tasks: 'overview',
  team: 'team',
  company: 'company',
  analytics: 'analytics',
  Tools: 'overview',
};

function TabSkeleton({ activeTab }) {
  return <WorkspaceSkeleton variant={TAB_SKELETON_VARIANTS[activeTab] || 'overview'} />;
}

export default function WorkSpaceModal({ isOpen, onClose, initialTab = 'overview' }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const minimizedWindowStyle = useMinimizedWindowStack('workspace-window', isOpen && isMinimized);

  useEffect(() => {
    if (!isOpen) return;
    setActiveTab(TAB_COMPONENTS[initialTab] ? initialTab : 'overview');
  }, [initialTab, isOpen]);

  useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const ActiveTabComponent = TAB_COMPONENTS[activeTab] || OverviewTab;

  const handleToggleMinimize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }
    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      setIsMinimized(false);
      return;
    }
    setIsMaximized((prev) => !prev);
  };

  return (
    <>
      <div
        className={`workspace-backdrop ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? onClose : undefined}
      />

      <div
        className={`workspace-window ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
      >
        <div
          className="workspace-header"
          onClick={isMinimized ? () => setIsMinimized(false) : undefined}
        >
          <div className="workspace-header-left">
            <h2>Workspace</h2>
          </div>

          <div className="workspace-header-right">
            {!isMinimized && (
              <button
                className="workspace-minimize-btn"
                title="Minimize"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleMinimize();
                }}
              >
                ─
              </button>
            )}

            <button
              className="workspace-maximize-btn"
              title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}
              onClick={(event) => {
                event.stopPropagation();
                handleToggleMaximize();
              }}
            >
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
            </button>

            <button
              className="workspace-close-btn"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {!isMinimized && (
          <div className="workspace-tabs">
            {TAB_ITEMS.map((tab) => (
              <button
                key={tab.key}
                className={`workspace-tab ${activeTab === tab.key ? 'active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="tab-icon">{tab.icon}</span>
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {!isMinimized && (
          <div className={`workspace-content ${activeTab === 'projects' ? 'workspace-content-projects' : ''}`}>
            <Suspense fallback={<TabSkeleton activeTab={activeTab} />}>
              <ActiveTabComponent />
            </Suspense>
          </div>
        )}
      </div>
    </>
  );
}
