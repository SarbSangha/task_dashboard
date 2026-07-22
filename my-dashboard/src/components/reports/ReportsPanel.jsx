import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { reportsAPI, downloadBlobResponse } from '../../services/reports';
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
import ActiveUsersDrill from './sections/ActiveUsersDrill';
import ContributorsDrill, { CONTRIBUTOR_METRICS, PROVIDER_LABELS } from './sections/ContributorsDrill';
import TaskContributorsDrill from './sections/TaskContributorsDrill';
import PromptDrill from './sections/PromptDrill';
import ChatGptUsersDrill from './sections/ChatGptUsersDrill';
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
  const [canvasQueue, setCanvasQueue] = useState([]);
  const [canvasToast, setCanvasToast] = useState(null);
  const [workbookBusy, setWorkbookBusy] = useState(false);
  const [showRangeMenu, setShowRangeMenu] = useState(false);
  const [customStart, setCustomStart] = useState(() => presetRange('15d').start);
  const [customEnd, setCustomEnd] = useState(() => presetRange('15d').end);

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
  const klingUsers = filtersQuery.data?.klingUsers || [];

  const queryFilters = useMemo(() => {
    const f = { start: filters.start, end: filters.end };
    if (filters.department && filters.department !== 'all') f.department = filters.department;
    if (filters.account && filters.account !== 'all') f.account = filters.account;
    // The person who generated, as opposed to the shared Kling login above.
    if (filters.klingUser && filters.klingUser !== 'all') f.user = filters.klingUser;
    return f;
  }, [filters.start, filters.end, filters.department, filters.account, filters.klingUser]);

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

  // Fetch and download the multi-sheet executive Excel workbook for a window.
  // `range` = { start, end } (YYYY-MM-DD); omitted → server default (15-day cycle).
  const downloadWorkbook = async (range) => {
    if (workbookBusy) return;
    setShowRangeMenu(false);
    setWorkbookBusy(true);
    setCanvasToast('Generating Excel report…');
    try {
      const params = range?.start && range?.end ? { start: range.start, end: range.end } : {};
      const res = await reportsAPI.aiWorkbook(params);
      downloadBlobResponse(res, 'AI-Usage-Report.xlsx');
      setCanvasToast('Excel report downloaded.');
    } catch (err) {
      setCanvasToast(err?.response?.status === 403
        ? 'You need admin access to download the report.'
        : 'Could not generate the Excel report. Please try again.');
    } finally {
      setWorkbookBusy(false);
      setTimeout(() => setCanvasToast(null), 3200);
    }
  };

  const pickPreset = (preset) => downloadWorkbook(presetRange(preset));
  const downloadCustom = () => {
    if (!customStart || !customEnd) return;
    const [start, end] = customStart <= customEnd ? [customStart, customEnd] : [customEnd, customStart];
    downloadWorkbook({ start, end });
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

  // `mode` carries the entry metric down: coming from an output KPI, level 3 is
  // the generation timeline rather than the login timeline.
  const openUser = (userId, userName, mode = 'activity', provider, focusDate) =>
    setDrill({ userId, userName, mode, provider, focusDate });

  // "Add to canvas" from any analytics level: queue the block, tell the user,
  // and leave them where they are so they can keep drilling.
  //
  // Each queued block carries a unique `_qid` so the builder can ingest it
  // exactly once. Without it, StrictMode's double-invoked mount effect (and any
  // re-render before the queue drains) appends the same block twice.
  const addToCanvas = (block, label) => {
    const _qid = `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    setCanvasQueue((q) => [...q, { ...block, _qid }]);
    setCanvasToast(`${label} added to the Report Builder canvas.`);
    setTimeout(() => setCanvasToast(null), 3200);
  };

  const renderContent = () => {
    // Drill order: a specific user wins; otherwise a KPI drill view (e.g. active users).
    if (drill?.userId) {
      return (
        <UserDetail
          userId={drill.userId}
          userName={drill.userName}
          mode={drill.mode}
          provider={drill.provider}
          focusDate={drill.focusDate}
          onBack={() => setDrill(null)}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (drill?.view === 'active-users') {
      // DAU/WAU/MAU and chart clicks pass their own window/department;
      // plain Active Users falls back to the global filters.
      const scoped = {
        ...queryFilters,
        ...(drill.start && drill.end ? { start: drill.start, end: drill.end } : {}),
        ...(drill.department ? { department: drill.department } : {}),
      };
      // A single-day scope means we already know the day — open it directly.
      const focusDate = drill.start && drill.start === drill.end ? drill.start : undefined;
      return (
        <ActiveUsersDrill
          filters={scoped}
          label={drill.label}
          initialSort={drill.sort}
          onOpenUser={(userId, userName) => openUser(userId, userName, 'activity', undefined, focusDate)}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (drill?.view === 'chatgpt-users') {
      return (
        <ChatGptUsersDrill
          filters={queryFilters}
          onOpenUser={(userId, userName) => openUser(userId, userName, 'chat')}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (drill?.view === 'prompt-drill') {
      return <PromptDrill mode={drill.mode} filters={queryFilters} onAddToCanvas={addToCanvas} />;
    }
    if (drill?.view === 'task-contributors') {
      return (
        <TaskContributorsDrill
          date={drill.date}
          priority={drill.priority}
          filters={queryFilters}
          onOpenUser={(userId, userName) => openUser(userId, userName, 'activity', undefined, drill.date)}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (drill?.view?.startsWith('contributors:')) {
      // view = "contributors:<metric>[:<provider>]"
      const [, metric, provider] = drill.view.split(':');
      return (
        <ContributorsDrill
          metric={metric}
          provider={provider}
          date={drill.date}
          hour={drill.hour}
          department={drill.department}
          filters={queryFilters}
          // With a specific day in context, skip the timeline and open that day directly.
          onOpenUser={(userId, userName) => openUser(userId, userName, 'output', provider, drill.date)}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'executive') return <ExecutiveDashboard filters={queryFilters} onDrill={(view) => setDrill({ view })} onAddToCanvas={addToCanvas} />;
    if (section === 'kling') {
      return (
        <KlingAnalytics
          filters={queryFilters}
          onOpenUser={(userId, userName) => openUser(userId, userName, 'output', 'kling')}
          onDrill={(view, ctx) => setDrill({ view, ...ctx })}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'chatgpt') {
      return (
        <ChatGPTAnalytics
          filters={queryFilters}
          onOpenUser={(userId, userName) => openUser(userId, userName, 'chat')}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'credit-usage' || section === 'token-analysis' || section === 'roi-analysis') {
      return (
        <CostIntelligence
          view={section}
          filters={queryFilters}
          onOpenUser={(userId, userName) => openUser(userId, userName, 'output')}
          onDrill={(v, ctx) => setDrill({ view: v, ...ctx })}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'user-activity') {
      return (
        <UserActivity
          filters={queryFilters}
          onDrill={(view, ctx) => setDrill({ view, ...ctx })}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'user-retention') return <UserRetention filters={queryFilters} />;
    if (section === 'power-users') return <PowerUsers filters={queryFilters} onOpenUser={openUser} />;
    if (section === 'ai-maturity') return <UserMaturity filters={queryFilters} />;
    if (section === 'prompt-performance') {
      return (
        <PromptPerformance
          filters={queryFilters}
          onDrill={(view, ctx) => setDrill({ view, ...ctx })}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'golden-prompts') return <GoldenPrompts filters={queryFilters} onAddToCanvas={addToCanvas} />;
    if (section === 'prompt-leaderboard') return <PromptLeaderboard filters={queryFilters} onOpenUser={openUser} />;
    if (section === 'prompt-evolution') return <PromptEvolution filters={queryFilters} />;
    if (section === 'productivity') return <TaskProductivity filters={queryFilters} onAddToCanvas={addToCanvas} />;
    if (section === 'completion') {
      return (
        <TaskCompletion
          filters={queryFilters}
          onDrill={(view, ctx) => setDrill({ view, ...ctx })}
          onAddToCanvas={addToCanvas}
        />
      );
    }
    if (section === 'task-ai-impact') return <TaskAIImpact filters={queryFilters} />;
    if (section === 'bottlenecks') return <TaskBottlenecks filters={queryFilters} />;
    if (section === 'recommendations') return <Recommendations filters={queryFilters} />;
    if (section === 'report-builder') {
      return <ReportBuilder filters={queryFilters} incoming={canvasQueue} onIncomingConsumed={() => setCanvasQueue([])} />;
    }
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
                  {drill?.view === 'active-users' && (<><span>›</span><b>Active Users</b></>)}
                  {drill?.view === 'task-contributors' && (<><span>›</span><b>Task Load</b></>)}
                  {drill?.view === 'chatgpt-users' && (<><span>›</span><b>ChatGPT Users</b></>)}
                  {drill?.view === 'prompt-drill' && (<><span>›</span><b>{drill.mode === 'reuse' ? 'Prompt Reuse' : 'Prompts by Person'}</b></>)}
                  {drill?.view?.startsWith('contributors:') && (
                    <>
                      <span>›</span>
                      <b>
                        {[PROVIDER_LABELS[drill.view.split(':')[2]], CONTRIBUTOR_METRICS[drill.view.split(':')[1]]?.title || 'Contributors']
                          .filter(Boolean).join(' · ')}
                      </b>
                    </>
                  )}
                  {drill?.userId && (<><span>›</span><b>{drill.userName}</b></>)}
                </div>
              )}
            </div>
          </div>
          <div className="rpt-header-spacer" />
          {!isMinimized && (
            <div className="rpt-workbook-wrap">
              <button
                className="rpt-workbook-btn"
                onClick={() => setShowRangeMenu((v) => !v)}
                disabled={workbookBusy}
                aria-haspopup="menu"
                aria-expanded={showRangeMenu}
                title="Download the full multi-sheet Excel report (Dashboard, Overview, Tool Master, Employee Summary, ChatGPT & Kling logs)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
                {workbookBusy ? 'Generating…' : 'Download Excel'}
                {!workbookBusy && <span className="rpt-workbook-caret" aria-hidden="true">▾</span>}
              </button>
              {showRangeMenu && (
                <>
                  <div className="rpt-range-backdrop" onClick={() => setShowRangeMenu(false)} />
                  <div className="rpt-range-menu" role="menu">
                    <div className="rpt-range-title">Report period</div>
                    <button className="rpt-range-item" role="menuitem" onClick={() => pickPreset('today')}>Today</button>
                    <button className="rpt-range-item" role="menuitem" onClick={() => pickPreset('tomorrow')}>Tomorrow</button>
                    <button className="rpt-range-item" role="menuitem" onClick={() => pickPreset('15d')}>Last 15 days</button>
                    <button className="rpt-range-item" role="menuitem" onClick={() => pickPreset('30d')}>Last 30 days</button>
                    <div className="rpt-range-sep" />
                    <div className="rpt-range-custom">
                      <span className="rpt-range-sublabel">Custom range</span>
                      <div className="rpt-range-dates">
                        <input type="date" value={customStart} max={customEnd} onChange={(e) => setCustomStart(e.target.value)} aria-label="Start date" />
                        <span className="rpt-range-arrow">→</span>
                        <input type="date" value={customEnd} min={customStart} onChange={(e) => setCustomEnd(e.target.value)} aria-label="End date" />
                      </div>
                      <button className="rpt-range-generate" onClick={downloadCustom} disabled={!customStart || !customEnd}>
                        Generate
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
          {!isMinimized && canvasQueue.length > 0 && (
            <button
              className="rpt-canvas-badge"
              onClick={() => selectSection('report-builder')}
              title="Open the Report Builder to see the queued blocks"
            >
              {canvasQueue.length} on canvas →
            </button>
          )}
          <WindowControls
            isMinimized={isMinimized}
            isMaximized={isMaximized}
            onMinimize={handleToggleMinimize}
            onMaximize={handleToggleMaximize}
            onClose={onClose}
          />
        </div>

        {!isMinimized && (
          <GlobalFilters filters={filters} preset={preset} onChange={updateFilters} departments={departments} klingAccounts={klingAccounts} klingUsers={klingUsers} />
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

        {canvasToast && <div className="rpt-canvas-toast">{canvasToast}</div>}
      </div>
    </>
  );
};

export default ReportsPanel;
