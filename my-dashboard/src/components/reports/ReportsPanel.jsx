import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { reportsAPI } from '../../services/reports';
import { presetRange } from './utils/format';
import GlobalFilters from './GlobalFilters';
import ReportsSidebarTree from './ReportsSidebarTree';
import ExecutiveDashboard from './sections/ExecutiveDashboard';
import KlingAnalytics from './sections/KlingAnalytics';
import ChatGPTAnalytics from './sections/ChatGPTAnalytics';
import CostIntelligence from './sections/CostIntelligence';
import UserActivity from './sections/UserActivity';
import UserRetention from './sections/UserRetention';
import PowerUsers from './sections/PowerUsers';
import UserMaturity from './sections/UserMaturity';
import PromptPerformance from './sections/PromptPerformance';
import GoldenPrompts from './sections/GoldenPrompts';
import PromptLeaderboard from './sections/PromptLeaderboard';
import PromptEvolution from './sections/PromptEvolution';
import TaskProductivity from './sections/TaskProductivity';
import TaskCompletion from './sections/TaskCompletion';
import TaskAIImpact from './sections/TaskAIImpact';
import TaskBottlenecks from './sections/TaskBottlenecks';
import Recommendations from './sections/Recommendations';
import ReportBuilder from './reportBuilder/ReportBuilder';
import ReportBuilderV2 from './reportBuilderV2/ReportBuilderV2';
import ReportHistory from './sections/ReportHistory';
import ScheduledReports from './sections/ScheduledReports';
import UserDetail from './sections/UserDetail';
import ComingSoon from './sections/ComingSoon';
import './ReportsPanel.css';

const SECTION_LABELS = {
  executive: 'Executive Overview',
  adoption: 'AI Adoption',
  kling: 'Kling Analytics',
  chatgpt: 'ChatGPT Analytics',
  'other-tools': 'Other Tools',
  'user-activity': 'User Activity',
  'user-retention': 'User Retention',
  'power-users': 'Power Users',
  'ai-maturity': 'User AI Maturity',
  productivity: 'Productivity',
  completion: 'Completion Analysis',
  'task-ai-impact': 'AI Impact',
  bottlenecks: 'Bottlenecks',
  'prompt-performance': 'Prompt Performance',
  'golden-prompts': 'Golden Prompt Library',
  'prompt-leaderboard': 'Prompt Leaderboard',
  'prompt-evolution': 'Prompt Evolution',
  'credit-usage': 'Credit Usage',
  'token-analysis': 'Token Analysis',
  'roi-analysis': 'ROI Analysis',
  recommendations: 'AI Recommendations',
  'report-builder': 'Report Builder',
  library: 'Analytics Library',
  'report-history': 'Report History',
  'scheduled-reports': 'Scheduled Reports',
};

// Questions surfaced on the designed placeholder screens (from the question bank).
const PLACEHOLDER = {
  adoption: { subtitle: 'Depth and momentum of AI adoption across departments, roles and cohorts.', questions: ['Is AI adoption accelerating or plateauing quarter over quarter?', 'Which departments have the lowest adoption and need enablement?', 'Are new hires adopting AI faster than earlier cohorts?', 'What is the habitual (not just licensed) adoption rate?'] },
  'other-tools': { subtitle: 'Long-tail AI tool usage and portfolio rationalisation.', questions: ['Which AI tools are least used, and why?', 'Where can we consolidate overlapping tools?', 'Which tools have the best cost-to-output ratio?'] },
};

const ReportsPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('reports-panel', isOpen && isMinimized);

  const [section, setSection] = useState('executive');
  const [drill, setDrill] = useState(null); // { userId, userName }
  const [treeOpen, setTreeOpen] = useState(false);

  const [preset, setPreset] = useState('30d');
  const [filters, setFilters] = useState(() => ({ ...presetRange('30d'), department: 'all', tool: 'all' }));

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  const filtersQuery = useQuery({
    queryKey: ['reports', 'filters'],
    queryFn: () => reportsAPI.filters(),
    enabled: isOpen,
    staleTime: 10 * 60_000,
  });
  const departments = filtersQuery.data?.departments || [];
  const klingAccounts = filtersQuery.data?.klingAccounts || [];

  const queryFilters = useMemo(() => {
    const f = { start: filters.start, end: filters.end };
    if (filters.department && filters.department !== 'all') f.department = filters.department;
    if (filters.account && filters.account !== 'all') f.account = filters.account;
    return f;
  }, [filters.start, filters.end, filters.department, filters.account]);

  const updateFilters = (patch) => {
    if (patch.preset) setPreset(patch.preset);
    const rest = { ...patch };
    delete rest.preset;
    if (Object.keys(rest).length) setFilters((prev) => ({ ...prev, ...rest }));
  };

  const selectSection = (key) => {
    setSection(key);
    setDrill(null);
    setTreeOpen(false);
  };

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((v) => !v);
  };

  if (!isOpen) return null;

  const openUser = (userId, userName) => setDrill({ userId, userName });

  const renderContent = () => {
    if (drill) {
      return <UserDetail userId={drill.userId} userName={drill.userName} onBack={() => setDrill(null)} />;
    }
    if (section === 'executive') return <ExecutiveDashboard filters={queryFilters} />;
    if (section === 'kling') return <KlingAnalytics filters={queryFilters} onOpenUser={openUser} />;
    if (section === 'chatgpt') return <ChatGPTAnalytics filters={queryFilters} />;
    if (section === 'credit-usage' || section === 'token-analysis' || section === 'roi-analysis') {
      return <CostIntelligence view={section} filters={queryFilters} onOpenUser={openUser} />;
    }
    if (section === 'user-activity') return <UserActivity filters={queryFilters} />;
    if (section === 'user-retention') return <UserRetention filters={queryFilters} />;
    if (section === 'power-users') return <PowerUsers filters={queryFilters} onOpenUser={openUser} />;
    if (section === 'ai-maturity') return <UserMaturity filters={queryFilters} />;
    if (section === 'prompt-performance') return <PromptPerformance filters={queryFilters} />;
    if (section === 'golden-prompts') return <GoldenPrompts filters={queryFilters} />;
    if (section === 'prompt-leaderboard') return <PromptLeaderboard filters={queryFilters} onOpenUser={openUser} />;
    if (section === 'prompt-evolution') return <PromptEvolution filters={queryFilters} />;
    if (section === 'productivity') return <TaskProductivity filters={queryFilters} />;
    if (section === 'completion') return <TaskCompletion filters={queryFilters} />;
    if (section === 'task-ai-impact') return <TaskAIImpact filters={queryFilters} />;
    if (section === 'bottlenecks') return <TaskBottlenecks filters={queryFilters} />;
    if (section === 'recommendations') return <Recommendations filters={queryFilters} />;
    if (section === 'report-builder') return <ReportBuilder filters={queryFilters} />;
    if (section === 'library') return <ReportBuilderV2 />;
    if (section === 'report-history') return <ReportHistory />;
    if (section === 'scheduled-reports') return <ScheduledReports />;
    const ph = PLACEHOLDER[section];
    return <ComingSoon title={SECTION_LABELS[section] || 'Report'} subtitle={ph?.subtitle} questions={ph?.questions || []} />;
  };

  return (
    <>
      <div className={`rpt-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`rpt-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Reports — AI Intelligence Command Center"
      >
        <div className="rpt-header">
          {!isMinimized && (
            <button className="rpt-tree-toggle" onClick={() => setTreeOpen((v) => !v)} aria-label="Toggle report navigation">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" /></svg>
            </button>
          )}
          <div className="rpt-brand">
            <span className="rpt-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="10" width="3" height="7" /><rect x="12" y="6" width="3" height="11" /><rect x="17" y="13" width="3" height="4" /></svg>
            </span>
            <div className="rpt-title-wrap">
              <h2 className="rpt-title">Reports</h2>
              {!isMinimized && (
                <div className="rpt-breadcrumb">
                  <span>AI Intelligence Command Center</span>
                  <span>›</span>
                  <b>{SECTION_LABELS[section]}</b>
                  {drill && (<><span>›</span><b>{drill.userName}</b></>)}
                </div>
              )}
            </div>
          </div>
          <div className="rpt-header-spacer" />
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <GlobalFilters filters={filters} preset={preset} onChange={updateFilters} departments={departments} klingAccounts={klingAccounts} />
        )}

        {!isMinimized && (
          <div className="rpt-body">
            <nav className={`rpt-tree ${treeOpen ? 'open' : ''}`} aria-label="Report navigation">
              <ReportsSidebarTree active={section} onSelect={selectSection} />
            </nav>
            <div className="rpt-content">
              {renderContent()}
            </div>
          </div>
        )}
      </div>
    </>
  );
};

export default ReportsPanel;
