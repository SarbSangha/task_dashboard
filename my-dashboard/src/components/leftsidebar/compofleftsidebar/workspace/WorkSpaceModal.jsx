import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import './WorkSpaceModal.css';
import './WorkspaceShared.css';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import WindowControls from '../../../common/WindowControls';
import { usePermissions } from '../../../../hooks/usePermissions';
import { WorkspaceSkeleton } from '../../../ui/WorkspaceSkeleton';

const OverviewTab = lazy(() => import('./tabs/OverviewTab'));
const ProjectsTab = lazy(() => import('./tabs/ProjectsTab'));
const GenerationProjectsTab = lazy(() => import('./tabs/GenerationProjectsTab'));
const TasksTab = lazy(() => import('./tabs/TasksTab'));
const TeamTab = lazy(() => import('./tabs/TeamTab'));
const CompanyTab = lazy(() => import('./tabs/CompanyTab'));
const AnalyticsTab = lazy(() => import('./tabs/AnalyticsTab'));
const ToolsTab = lazy(() => import('./tabs/ToolsTab'));
const CreditsTab = lazy(() => import('./tabs/CreditsTab'));
const ChartsTab = lazy(() => import('./tabs/ChartsTab'));
const CaptureCenterTab = lazy(() => import('./tabs/CaptureCenterTab'));
const ChatGptCaptureCenterTab = lazy(() => import('./tabs/ChatGptCaptureCenterTab'));
const AiExplorerTab = lazy(() => import('./tabs/ai-explorer/AiExplorerTab'));

const PRIMARY_TABS = [
  { key: 'overview', label: 'Overview', icon: '📈' },
  { key: 'tasks', label: 'Tasks', icon: '✓' },
  { key: 'projects', label: 'Projects', icon: '📁' },
  { key: 'team', label: 'Team', icon: '👥' },
  { key: 'analytics', label: 'Analytics', icon: '📊' },
];

const SECONDARY_TABS = [
  { key: 'ai-explorer', label: 'AI Explorer', icon: '🧭', adminOnly: true },
  { key: 'generation-projects', label: 'Gen Projects', icon: '🎬' },
  { key: 'capture-center', label: 'Capture Center', icon: '🛟', adminOnly: true },
  { key: 'chatgpt-capture-center', label: 'ChatGPT Capture', icon: '🧠', adminOnly: true },
  { key: 'company', label: 'Company', icon: '🏢' },
  { key: 'Tools', label: 'Tools', icon: '🧰' },
  { key: 'credits', label: 'Credits', icon: '💳' },
  { key: 'charts', label: 'Charts', icon: '📉' },
];

const ALL_TAB_ITEMS = [...PRIMARY_TABS, ...SECONDARY_TABS];

const TAB_COMPONENTS = {
  overview: OverviewTab,
  'ai-explorer': AiExplorerTab,
  projects: ProjectsTab,
  'generation-projects': GenerationProjectsTab,
  'capture-center': CaptureCenterTab,
  'chatgpt-capture-center': ChatGptCaptureCenterTab,
  tasks: TasksTab,
  team: TeamTab,
  company: CompanyTab,
  analytics: AnalyticsTab,
  Tools: ToolsTab,
  credits: CreditsTab,
  charts: ChartsTab,
};

const TAB_SKELETON_VARIANTS = {
  overview: 'overview',
  'ai-explorer': 'projects',
  projects: 'projects',
  'generation-projects': 'projects',
  'capture-center': 'projects',
  'chatgpt-capture-center': 'projects',
  tasks: 'overview',
  team: 'team',
  company: 'company',
  analytics: 'analytics',
  Tools: 'overview',
  credits: 'overview',
  charts: 'overview',
};

function TabSkeleton({ activeTab }) {
  return <WorkspaceSkeleton variant={TAB_SKELETON_VARIANTS[activeTab] || 'overview'} />;
}

export default function WorkSpaceModal({ isOpen, onClose, initialTab = 'overview', onMinimizedChange, onActivate }) {
  const { isAdmin } = usePermissions();
  const [activeTab, setActiveTab] = useState('overview');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('workspace-window', isOpen && isMinimized);

  const visiblePrimaryTabs = useMemo(
    () => PRIMARY_TABS.filter((tab) => !tab.adminOnly || isAdmin),
    [isAdmin]
  );
  const visibleSecondaryTabs = useMemo(
    () => SECONDARY_TABS.filter((tab) => !tab.adminOnly || isAdmin),
    [isAdmin]
  );
  const visibleTabs = useMemo(
    () => ALL_TAB_ITEMS.filter((tab) => !tab.adminOnly || isAdmin),
    [isAdmin]
  );

  useEffect(() => {
    if (!isOpen) return;
    const initialVisibleTab = visibleTabs.some((tab) => tab.key === initialTab) ? initialTab : 'overview';
    setActiveTab(TAB_COMPONENTS[initialVisibleTab] ? initialVisibleTab : 'overview');
  }, [initialTab, isOpen, visibleTabs]);

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.key === activeTab)) {
      setActiveTab('overview');
    }
  }, [activeTab, visibleTabs]);

  useEffect(() => {
    if (!isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
    } else {
      setIsMaximized(isMobileViewport());
    }
  }, [isOpen]);

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  if (!isOpen) return null;

  const ActiveTabComponent = TAB_COMPONENTS[activeTab] || OverviewTab;

  const restoreWindow = () => {
    onActivate?.();
    setIsMinimized(false);
  };

  const handleToggleMinimize = () => {
    if (isMinimized) { restoreWindow(); return; }
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) { restoreWindow(); return; }
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
          onClick={isMinimized ? restoreWindow : undefined}
        >
          <div className="workspace-header-left">
            <div className="workspace-logo-mark" aria-hidden="true">W</div>
            <h2>Workspace</h2>
          </div>

          <div className="workspace-header-right">
            <WindowControls
              isMinimized={isMinimized}
              isMaximized={isMaximized}
              onMinimize={handleToggleMinimize}
              onMaximize={handleToggleMaximize}
              onClose={onClose}
            />
          </div>
        </div>

        {!isMinimized && (
          <nav className="workspace-tabs" role="tablist" aria-label="Workspace sections">
            {visiblePrimaryTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                className={`workspace-tab${activeTab === tab.key ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
                <span className="tab-label">{tab.label}</span>
              </button>
            ))}

            {visibleSecondaryTabs.length > 0 && (
              <div className="workspace-tab-divider" role="separator" aria-hidden="true" />
            )}

            {visibleSecondaryTabs.map((tab) => (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={activeTab === tab.key}
                className={`workspace-tab workspace-tab-secondary${activeTab === tab.key ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.key)}
              >
                <span className="tab-icon" aria-hidden="true">{tab.icon}</span>
                <span className="tab-label">{tab.label}</span>
              </button>
            ))}
          </nav>
        )}

        {!isMinimized && (
          <div
            className={`workspace-content${
              activeTab === 'projects' || activeTab === 'generation-projects' || activeTab === 'capture-center' || activeTab === 'chatgpt-capture-center'
                ? ' workspace-content-projects'
                : ''
            }`}
          >
            <Suspense fallback={<TabSkeleton activeTab={activeTab} />}>
              <ActiveTabComponent onNavigateToTab={setActiveTab} />
            </Suspense>
          </div>
        )}
      </div>
    </>
  );
}
