import { useEffect, useMemo, useState } from 'react';
import { authAPI, isRequestCanceled } from '../../../../../services/api';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { ACTIVE_PROJECT_STATUSES, buildProjectSummaries, useWorkspaceTaskDataset } from '../workspaceTabData';
import './OverviewTab.css';

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good Morning';
  if (hour < 17) return 'Good Afternoon';
  return 'Good Evening';
}

function formatRelativeTime(value) {
  if (!value) return 'just now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'just now';
  const diffMs = Date.now() - date.getTime();
  const minutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  return `${days}d ago`;
}

const STATUS_CONFIG = {
  completed:       { icon: '✓', label: 'Completed',    color: 'success', priority: 0 },
  need_improvement:{ icon: '↩', label: 'Needs Work',   color: 'warning', priority: 1 },
  under_review:    { icon: '◎', label: 'Under Review', color: 'info',    priority: 2 },
  approved:        { icon: '✓', label: 'Approved',     color: 'success', priority: 3 },
  in_progress:     { icon: '▶', label: 'In Progress',  color: 'primary', priority: 4 },
  submitted:       { icon: '↑', label: 'Submitted',    color: 'info',    priority: 5 },
  assigned:        { icon: '◉', label: 'Assigned',     color: 'default', priority: 6 },
  pending:         { icon: '○', label: 'Pending',      color: 'default', priority: 7 },
  forwarded:       { icon: '→', label: 'Forwarded',    color: 'default', priority: 8 },
  cancelled:       { icon: '✕', label: 'Cancelled',    color: 'error',   priority: 9 },
  rejected:        { icon: '✕', label: 'Rejected',     color: 'error',   priority: 9 },
};

function getStatusConfig(status) {
  return STATUS_CONFIG[(status || '').toLowerCase()] || { icon: '•', label: status || 'Unknown', color: 'default', priority: 10 };
}

function KpiCard({ value, label, subtext, icon, colorClass, onClick }) {
  return (
    <button
      type="button"
      className={`ov-kpi-card ${colorClass}`}
      onClick={onClick}
      aria-label={`${label}: ${value}`}
    >
      <div className="ov-kpi-top">
        <span className="ov-kpi-icon" aria-hidden="true">{icon}</span>
        <span className="ov-kpi-label">{label}</span>
      </div>
      <div className="ov-kpi-value">{value}</div>
      <div className="ov-kpi-sub">{subtext}</div>
      <span className="ov-kpi-arrow" aria-hidden="true">→</span>
    </button>
  );
}

function PriorityEmptyState() {
  return (
    <div className="ov-panel-empty" role="status">
      <span className="ov-panel-empty-icon" aria-hidden="true">✓</span>
      <span className="ov-panel-empty-title">You're all caught up</span>
      <span className="ov-panel-empty-sub">No tasks need your attention right now.</span>
    </div>
  );
}

function ActivityEmptyState() {
  return (
    <div className="ov-panel-empty" role="status">
      <span className="ov-panel-empty-icon" aria-hidden="true">◈</span>
      <span className="ov-panel-empty-title">No recent activity</span>
      <span className="ov-panel-empty-sub">Your task updates will appear here.</span>
    </div>
  );
}

function ProjectsEmptyState({ onNavigate }) {
  return (
    <div className="ov-empty-state">
      <span className="ov-empty-icon" aria-hidden="true">▣</span>
      <span className="ov-empty-title">No projects yet</span>
      <span className="ov-empty-sub">Tasks will be grouped into projects automatically.</span>
      <button type="button" className="ov-empty-cta" onClick={() => onNavigate?.('projects')}>
        Open Projects →
      </button>
    </div>
  );
}

export default function OverviewTab({ onNavigateToTab }) {
  const { tasks, currentUser, loading, isRefreshing, error, cacheStatus } = useWorkspaceTaskDataset();
  const [teamMembers, setTeamMembers] = useState(0);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();

    const loadTeamMembers = async () => {
      const myDept = currentUser?.department || '';
      if (!myDept) { if (mounted) setTeamMembers(0); return; }
      try {
        const deptRes = await authAPI.getUsersByDepartment(myDept, '', { signal: controller.signal }).catch((err) => {
          if (isRequestCanceled(err)) return { __canceled: true };
          return { users: [] };
        });
        if (deptRes?.__canceled || controller.signal.aborted) return;
        if (mounted) setTeamMembers((deptRes?.users || []).length);
      } catch (err) {
        if (isRequestCanceled(err) || controller.signal.aborted) return;
        if (mounted) setTeamMembers(0);
      }
    };

    void loadTeamMembers();
    return () => { mounted = false; controller.abort(); };
  }, [currentUser?.department]);

  const stats = useMemo(() => {
    const activeTasks      = tasks.filter((t) => ACTIVE_PROJECT_STATUSES.has((t.status || '').toLowerCase())).length;
    const completedTasks   = tasks.filter((t) => (t.status || '').toLowerCase() === 'completed').length;
    const needWork         = tasks.filter((t) => (t.status || '').toLowerCase() === 'need_improvement').length;
    const underReview      = tasks.filter((t) => (t.status || '').toLowerCase() === 'under_review').length;
    const projectKeys      = new Set(tasks.map((t) => (t.projectId || t.projectName || '').trim()).filter(Boolean));
    const completionRate   = tasks.length > 0 ? Math.round((completedTasks / tasks.length) * 100) : 0;
    return { activeTasks, completedTasks, needWork, underReview, projects: projectKeys.size, teamMembers, completionRate, total: tasks.length };
  }, [tasks, teamMembers]);

  const priorityTasks = useMemo(() => {
    const ATTENTION_STATUSES = ['need_improvement', 'under_review', 'pending', 'assigned'];
    return tasks
      .filter((t) => ATTENTION_STATUSES.includes((t.status || '').toLowerCase()))
      .sort((a, b) => getStatusConfig(a.status).priority - getStatusConfig(b.status).priority)
      .slice(0, 5);
  }, [tasks]);

  const recentActivity = useMemo(() => {
    return tasks
      .map((task) => {
        const s     = (task.status || '').toLowerCase();
        const cfg   = getStatusConfig(task.status);
        const title = task.title || task.taskName || task.taskNumber || 'Task';
        const textMap = {
          completed:        `Completed: ${title}`,
          need_improvement: `Needs work: ${title}`,
          under_review:     `Under review: ${title}`,
          approved:         `Approved: ${title}`,
          submitted:        `Submitted: ${title}`,
          assigned:         `Assigned: ${title}`,
        };
        return {
          icon:   cfg.icon,
          color:  cfg.color,
          text:   textMap[s] || `Updated: ${title}`,
          time:   task.updatedAt || task.createdAt,
        };
      })
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
      .slice(0, 6);
  }, [tasks]);

  const topProjects = useMemo(() => buildProjectSummaries(tasks).slice(0, 3), [tasks]);

  const greeting  = getGreeting();
  const firstName = currentUser?.name?.split(' ')[0] || 'there';

  const kpiCards = [
    {
      key:        'active',
      value:      stats.activeTasks,
      label:      'Active Tasks',
      subtext:    stats.needWork > 0 ? `${stats.needWork} need${stats.needWork === 1 ? 's' : ''} attention` : 'On track',
      icon:       '◉',
      colorClass: 'ov-kpi-primary',
      tab:        'tasks',
    },
    {
      key:        'completed',
      value:      stats.completedTasks,
      label:      'Completed',
      subtext:    `${stats.completionRate}% completion rate`,
      icon:       '✓',
      colorClass: 'ov-kpi-success',
      tab:        'tasks',
    },
    {
      key:        'projects',
      value:      stats.projects,
      label:      'Projects',
      subtext:    stats.projects === 0 ? 'No projects yet' : `${topProjects.filter((p) => p.statusClass === 'active').length} active`,
      icon:       '▣',
      colorClass: 'ov-kpi-purple',
      tab:        'projects',
    },
    {
      key:        'team',
      value:      stats.teamMembers,
      label:      'Team Members',
      subtext:    currentUser?.department || 'Your department',
      icon:       '◈',
      colorClass: 'ov-kpi-blue',
      tab:        'team',
    },
  ];

  const quickActions = [
    { icon: '✓', label: 'My Tasks',     tab: 'tasks' },
    { icon: '📁', label: 'Projects',    tab: 'projects' },
    { icon: '📊', label: 'Analytics',   tab: 'analytics' },
    { icon: '🧰', label: 'Tools',       tab: 'Tools' },
    { icon: '👥', label: 'Team',        tab: 'team' },
    { icon: '🎬', label: 'Gen Projects',tab: 'generation-projects' },
  ];

  const attentionCount = stats.needWork + stats.underReview;

  return (
    <div className="ov-dashboard" role="main" aria-label="Workspace overview">
      <CacheStatusBanner
        showingCached={cacheStatus.showingCached}
        isRefreshing={isRefreshing}
        cachedAt={cacheStatus.cachedAt}
        liveUpdatedAt={cacheStatus.liveUpdatedAt}
        refreshingLabel="Refreshing workspace…"
        liveLabel="Workspace is up to date"
        cachedLabel="Showing cached data"
      />

      {error && <div className="ov-error-alert" role="alert">{error}</div>}

      {loading ? (
        <WorkspaceSkeleton variant="overview" />
      ) : (
        <>
          {/* ── Hero ──────────────────────────────────────────────────── */}
          <section className="ov-hero" aria-label="Workspace summary">
            <div className="ov-hero-body">
              <p className="ov-hero-eyebrow">Workspace</p>
              <h2 className="ov-hero-greeting">{greeting}, {firstName}</h2>
              <p className="ov-hero-subtitle">
                {stats.activeTasks > 0
                  ? <>You have <strong>{stats.activeTasks}</strong> active task{stats.activeTasks !== 1 ? 's' : ''}{attentionCount > 0 ? <> and <strong>{attentionCount}</strong> need{attentionCount !== 1 ? '' : 's'} attention</> : ''}.</>
                  : "You're all caught up. No active tasks right now."}
              </p>
              <div className="ov-hero-chips" aria-label="Workspace status">
                {currentUser?.department && (
                  <span className="ov-chip">
                    <span aria-hidden="true">◈</span>
                    {currentUser.department}
                  </span>
                )}
                <span className="ov-chip">
                  <span className="ov-chip-live" aria-hidden="true" />
                  {stats.total} task{stats.total !== 1 ? 's' : ''} total
                </span>
                {stats.projects > 0 && (
                  <span className="ov-chip">
                    <span aria-hidden="true">▣</span>
                    {stats.projects} project{stats.projects !== 1 ? 's' : ''}
                  </span>
                )}
              </div>
            </div>

            <nav className="ov-quick-actions" aria-label="Quick navigation">
              {quickActions.map((action) => (
                <button
                  key={action.label}
                  type="button"
                  className="ov-qa-btn"
                  onClick={() => onNavigateToTab?.(action.tab)}
                  aria-label={`Go to ${action.label}`}
                >
                  <span className="ov-qa-icon" aria-hidden="true">{action.icon}</span>
                  <span className="ov-qa-label">{action.label}</span>
                  <span className="ov-qa-arrow" aria-hidden="true">›</span>
                </button>
              ))}
            </nav>
          </section>

          {/* ── KPI Cards ─────────────────────────────────────────────── */}
          <section aria-label="Key metrics">
            <div className="ov-kpi-grid">
              {kpiCards.map((card) => (
                <KpiCard
                  key={card.key}
                  value={card.value}
                  label={card.label}
                  subtext={card.subtext}
                  icon={card.icon}
                  colorClass={card.colorClass}
                  onClick={() => card.tab && onNavigateToTab?.(card.tab)}
                />
              ))}
            </div>
          </section>

          {/* ── Priority + Activity ───────────────────────────────────── */}
          <div className="ov-mid-row">
            {/* Priority panel */}
            <section className="ov-panel" aria-label="Tasks needing attention">
              <div className="ov-panel-head">
                <span className="ov-panel-title">Needs Attention</span>
                {priorityTasks.length > 0 && (
                  <span className="ov-panel-badge" aria-label={`${priorityTasks.length} tasks`}>
                    {priorityTasks.length}
                  </span>
                )}
              </div>

              {priorityTasks.length === 0 ? (
                <PriorityEmptyState />
              ) : (
                <>
                  <ul className="ov-priority-list" aria-label="Priority tasks">
                    {priorityTasks.map((task, idx) => {
                      const cfg   = getStatusConfig(task.status);
                      const title = task.title || task.taskName || task.taskNumber || 'Task';
                      return (
                        <li key={task.id || idx} className="ov-priority-item">
                          <span className={`ov-priority-dot ov-dot-${cfg.color}`} aria-hidden="true" />
                          <div className="ov-priority-content">
                            <span className="ov-priority-title" title={title}>{title}</span>
                            <span className="ov-priority-meta">
                              {formatRelativeTime(task.updatedAt || task.createdAt)}
                            </span>
                          </div>
                          <span className={`ov-badge ov-badge-${cfg.color}`}>{cfg.label}</span>
                        </li>
                      );
                    })}
                  </ul>
                  <button
                    type="button"
                    className="ov-panel-footer-btn"
                    onClick={() => onNavigateToTab?.('tasks')}
                  >
                    View all tasks →
                  </button>
                </>
              )}
            </section>

            {/* Activity timeline */}
            <section className="ov-panel" aria-label="Recent activity">
              <div className="ov-panel-head">
                <span className="ov-panel-title">Recent Activity</span>
              </div>

              {recentActivity.length === 0 ? (
                <ActivityEmptyState />
              ) : (
                <ol className="ov-timeline" aria-label="Activity timeline">
                  {recentActivity.map((item, idx) => (
                    <li key={`${item.text}-${idx}`} className="ov-timeline-item">
                      <div className="ov-timeline-track">
                        <span className={`ov-timeline-dot ov-dot-${item.color}`} aria-hidden="true">
                          {item.icon}
                        </span>
                        {idx < recentActivity.length - 1 && (
                          <div className="ov-timeline-line" aria-hidden="true" />
                        )}
                      </div>
                      <div className="ov-timeline-body">
                        <span className="ov-timeline-text">{item.text}</span>
                        <time className="ov-timeline-time">{formatRelativeTime(item.time)}</time>
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </div>

          {/* ── Projects ──────────────────────────────────────────────── */}
          <section aria-label="Projects overview">
            <div className="ov-section-head">
              <h3 className="ov-section-title">Projects</h3>
              <button
                type="button"
                className="ov-section-action"
                onClick={() => onNavigateToTab?.('projects')}
              >
                View all →
              </button>
            </div>

            {topProjects.length === 0 ? (
              <ProjectsEmptyState onNavigate={onNavigateToTab} />
            ) : (
              <div className="ov-projects-grid">
                {topProjects.map((project, idx) => (
                  <button
                    key={project.key || idx}
                    type="button"
                    className="ov-project-card"
                    onClick={() => onNavigateToTab?.('projects')}
                    aria-label={`${project.name} — ${project.progress}% complete`}
                  >
                    <div className="ov-project-head">
                      <span className="ov-project-name" title={project.name}>{project.name}</span>
                      <span className={`ov-project-status ov-status-${project.statusClass}`}>
                        {project.statusLabel}
                      </span>
                    </div>
                    <div className="ov-project-progress" role="progressbar" aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100}>
                      <div className="ov-project-fill" style={{ width: `${project.progress}%` }} />
                    </div>
                    <div className="ov-project-foot">
                      <span className="ov-project-stat">{project.progress}%</span>
                      <span className="ov-project-stat">{project.totalTasks} task{project.totalTasks !== 1 ? 's' : ''}</span>
                      {project.assigneeCount > 0 && (
                        <span className="ov-project-stat">{project.assigneeCount} member{project.assigneeCount !== 1 ? 's' : ''}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </section>

          {/* ── Analytics Snapshot ────────────────────────────────────── */}
          <section aria-label="Analytics snapshot">
            <div className="ov-section-head">
              <h3 className="ov-section-title">Analytics Snapshot</h3>
              <button
                type="button"
                className="ov-section-action"
                onClick={() => onNavigateToTab?.('analytics')}
              >
                Full analytics →
              </button>
            </div>
            <div className="ov-analytics-strip">
              <div className="ov-analytics-stat">
                <span className="ov-analytics-icon" aria-hidden="true">◎</span>
                <div className="ov-analytics-info">
                  <span className="ov-analytics-val">{stats.completionRate}%</span>
                  <span className="ov-analytics-lbl">Completion Rate</span>
                </div>
              </div>
              <div className="ov-analytics-divider" aria-hidden="true" />
              <div className="ov-analytics-stat">
                <span className="ov-analytics-icon" aria-hidden="true">✓</span>
                <div className="ov-analytics-info">
                  <span className="ov-analytics-val">{stats.completedTasks}</span>
                  <span className="ov-analytics-lbl">Tasks Done</span>
                </div>
              </div>
              <div className="ov-analytics-divider" aria-hidden="true" />
              <div className="ov-analytics-stat">
                <span className="ov-analytics-icon" aria-hidden="true">▶</span>
                <div className="ov-analytics-info">
                  <span className="ov-analytics-val">{stats.activeTasks}</span>
                  <span className="ov-analytics-lbl">In Progress</span>
                </div>
              </div>
              <button
                type="button"
                className="ov-analytics-cta"
                onClick={() => onNavigateToTab?.('analytics')}
              >
                View Detailed Analytics
                <span aria-hidden="true"> →</span>
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
