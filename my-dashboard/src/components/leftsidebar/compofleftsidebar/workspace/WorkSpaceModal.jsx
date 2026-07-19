import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import './WorkSpaceModal.css';
import './WorkspaceShared.css';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import { useElementSize } from '../../../../hooks/useElementSize';
import { isMobileViewport } from '../../../../utils/isMobileViewport';
import WindowControls from '../../../common/WindowControls';
import Menu from '../../../ui/Menu';
import { usePermissions } from '../../../../hooks/usePermissions';
import { WorkspaceSkeleton } from '../../../ui/WorkspaceSkeleton';

// Tab-strip overflow sizing (px). Rough per-tab and trailing-area reserves used
// to decide how many primary tabs fit before the rest fold into the More menu.
const APPROX_TAB_WIDTH = 116;
const MORE_TRIGGER_RESERVE = 104;
const CONTEXT_CHIP_RESERVE = 172;

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

  // Measure the tab strip so primary tabs that don't fit fold into the More
  // menu instead of forcing a horizontal scroll. Secondary tabs always live in
  // More (progressive disclosure); overflowed primary tabs join them there.
  const [tabStripRef, tabStripSize] = useElementSize();

  const activeIsSecondary = useMemo(
    () => visibleSecondaryTabs.some((tab) => tab.key === activeTab),
    [visibleSecondaryTabs, activeTab]
  );

  const primaryCapacity = useMemo(() => {
    const width = tabStripSize.width;
    if (!width) return visiblePrimaryTabs.length; // pre-measure: assume room, avoids a first-paint flash
    const reserve = MORE_TRIGGER_RESERVE + (activeIsSecondary ? CONTEXT_CHIP_RESERVE : 0) + 8;
    const fit = Math.floor((width - reserve) / APPROX_TAB_WIDTH);
    return Math.max(1, Math.min(visiblePrimaryTabs.length, fit));
  }, [tabStripSize.width, visiblePrimaryTabs.length, activeIsSecondary]);

  const shownPrimaryTabs = useMemo(() => {
    const shown = visiblePrimaryTabs.slice(0, primaryCapacity);
    // Keep the active primary tab directly visible: if it overflowed, swap it
    // into the last visible slot so the strip always shows where you are and
    // the context chip is reserved only for secondary sections.
    const activeIdx = visiblePrimaryTabs.findIndex((tab) => tab.key === activeTab);
    if (activeIdx >= primaryCapacity && primaryCapacity > 0) {
      return [...shown.slice(0, primaryCapacity - 1), visiblePrimaryTabs[activeIdx]];
    }
    return shown;
  }, [visiblePrimaryTabs, primaryCapacity, activeTab]);

  const overflowPrimaryTabs = useMemo(
    () => visiblePrimaryTabs.filter((tab) => !shownPrimaryTabs.some((shown) => shown.key === tab.key)),
    [visiblePrimaryTabs, shownPrimaryTabs]
  );

  // The active section is "in the More menu" whenever it isn't one of the tabs
  // currently rendered in the strip — that's what the context chip surfaces so
  // "Where am I?" always has an answer.
  const activeInMore = useMemo(
    () => !shownPrimaryTabs.some((tab) => tab.key === activeTab),
    [shownPrimaryTabs, activeTab]
  );
  const activeMeta = useMemo(
    () => ALL_TAB_ITEMS.find((tab) => tab.key === activeTab),
    [activeTab]
  );

  // Build the More menu: overflowed pages first, then tools, then admin — each
  // under its own section header. Reuses the same setActiveTab used by the strip.
  const moreMenuItems = useMemo(() => {
    const items = [];
    if (overflowPrimaryTabs.length > 0) {
      items.push({ type: 'section', label: 'Pages' });
      overflowPrimaryTabs.forEach((tab) => {
        items.push({ key: tab.key, label: tab.label, icon: tab.icon, active: activeTab === tab.key, onSelect: () => setActiveTab(tab.key) });
      });
    }
    const tools = visibleSecondaryTabs.filter((tab) => !tab.adminOnly);
    const admin = visibleSecondaryTabs.filter((tab) => tab.adminOnly);
    if (tools.length > 0) {
      items.push({ type: 'section', label: 'Workspace tools' });
      tools.forEach((tab) => {
        items.push({ key: tab.key, label: tab.label, icon: tab.icon, active: activeTab === tab.key, onSelect: () => setActiveTab(tab.key) });
      });
    }
    if (admin.length > 0) {
      items.push({ type: 'section', label: 'Admin' });
      admin.forEach((tab) => {
        items.push({ key: tab.key, label: tab.label, icon: tab.icon, active: activeTab === tab.key, onSelect: () => setActiveTab(tab.key) });
      });
    }
    return items;
  }, [overflowPrimaryTabs, visibleSecondaryTabs, activeTab]);

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
          <nav className="workspace-tabs" ref={tabStripRef} role="tablist" aria-label="Workspace sections">
            <div className="workspace-tabs-primary">
              {shownPrimaryTabs.map((tab) => (
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
            </div>

            <div className="workspace-tabs-trailing">
              {activeInMore && activeMeta && (
                <span className="workspace-tab-context" aria-current="page" title={activeMeta.label}>
                  <span className="tab-icon" aria-hidden="true">{activeMeta.icon}</span>
                  <span className="tab-label">{activeMeta.label}</span>
                </span>
              )}

              {moreMenuItems.length > 0 && (
                <Menu
                  align="end"
                  menuLabel="More workspace sections"
                  items={moreMenuItems}
                  renderTrigger={(triggerProps, { open }) => (
                    <button
                      {...triggerProps}
                      className={`workspace-tab-more${activeInMore ? ' has-active' : ''}${open ? ' open' : ''}`}
                    >
                      <span className="tab-label">More</span>
                      <span className="workspace-tab-more-caret" aria-hidden="true">▾</span>
                    </button>
                  )}
                />
              )}
            </div>
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
