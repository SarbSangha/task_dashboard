import React, { useEffect, useMemo, useRef, useState } from 'react';
import './WorkSpaceModal.css';
import Tools from './Tools';
import { activityAPI, authAPI, fileAPI, groupAPI, taskAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';

const FILES_API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export default function WorkSpaceModal({ isOpen, onClose, initialTab = 'overview' }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setActiveTab(initialTab || 'overview');
    }
  }, [isOpen, initialTab]);

  useEffect(() => {
    if (!isOpen) {
      // Reset layout state while closed so next open always starts centered.
      setIsMinimized(false);
      setIsMaximized(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

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
      setIsMaximized(true);
      return;
    }
    setIsMaximized((prev) => !prev);
  };

  return (
    <>
      {/* Backdrop */}
      <div className={`workspace-backdrop ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />

      {/* Main Workspace Window */}
      <div className={`workspace-window ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}>
        {/* Header */}
        <div className="workspace-header" onClick={isMinimized ? () => setIsMinimized(false) : undefined}>
          <div className="workspace-header-left">
            <div className="workspace-icon">📊</div>
            <h2>Workspace</h2>
          </div>
          <div className="workspace-header-right">
            <button
              className="workspace-minimize-btn"
              title={isMinimized ? 'Restore' : 'Minimize'}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMinimize();
              }}
            >
              {isMinimized ? '▢' : '─'}
            </button>
            <button
              className="workspace-maximize-btn"
              title={isMaximized ? 'Restore Window' : 'Maximize'}
              onClick={(e) => {
                e.stopPropagation();
                handleToggleMaximize();
              }}
            >
              {isMaximized ? '❐' : '□'}
            </button>
            <button
              className="workspace-close-btn"
              onClick={(e) => {
                e.stopPropagation();
                onClose();
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {/* Tabs Navigation */}
        {!isMinimized && (
        <div className="workspace-tabs">
          <button
            className={`workspace-tab ${activeTab === 'overview' ? 'active' : ''}`}
            onClick={() => setActiveTab('overview')}
          >
            <span className="tab-icon">📈</span>
            Overview
          </button>
          <button
            className={`workspace-tab ${activeTab === 'projects' ? 'active' : ''}`}
            onClick={() => setActiveTab('projects')}
          >
            <span className="tab-icon">📁</span>
            Projects
          </button>
          <button
            className={`workspace-tab ${activeTab === 'tasks' ? 'active' : ''}`}
            onClick={() => setActiveTab('tasks')}
          >
            <span className="tab-icon">✓</span>
            Tasks
          </button>
          <button
            className={`workspace-tab ${activeTab === 'team' ? 'active' : ''}`}
            onClick={() => setActiveTab('team')}
          >
            <span className="tab-icon">👥</span>
            Team
          </button>
          <button
            className={`workspace-tab ${activeTab === 'company' ? 'active' : ''}`}
            onClick={() => setActiveTab('company')}
          >
            <span className="tab-icon">🏢</span>
            Company
          </button>
          <button
            className={`workspace-tab ${activeTab === 'groups' ? 'active' : ''}`}
            onClick={() => setActiveTab('groups')}
          >
            <span className="tab-icon">💬</span>
            Groups
          </button>
          <button
            className={`workspace-tab ${activeTab === 'analytics' ? 'active' : ''}`}
            onClick={() => setActiveTab('analytics')}
          >
            <span className="tab-icon">📊</span>
            Analytics
          </button>
          <button
            className={`workspace-tab ${activeTab === 'Tools' ? 'active' : ''}`}
            onClick={() => setActiveTab('Tools')}
          >
            <span className="tab-icon">📊</span>
            Tools
          </button>
        </div>
        )}

        {/* Content Area */}
        {!isMinimized && (
        <div className="workspace-content">
          {activeTab === 'overview' && <OverviewContent />}
          {activeTab === 'projects' && <ProjectsContent />}
          {activeTab === 'tasks' && <TasksContent />}
          {activeTab === 'team' && <TeamContent />}
          {activeTab === 'company' && <CompanyContent />}
          {activeTab === 'groups' && <GroupsContent />}
          {activeTab === 'analytics' && <AnalyticsContent />}
          {activeTab === 'Tools' && <Tools />}
        </div>
        )}
      </div>
    </>
  );
}

// Overview Tab Content
function OverviewContent() {
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({
    activeTasks: 0,
    completedTasks: 0,
    projects: 0,
    teamMembers: 0,
  });
  const [recentActivity, setRecentActivity] = useState([]);

  const formatRelativeTime = (value) => {
    if (!value) return 'just now';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'just now';
    const diffMs = Date.now() - date.getTime();
    const minutes = Math.max(1, Math.floor(diffMs / (1000 * 60)));
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    return `${days} day${days === 1 ? '' : 's'} ago`;
  };

  useEffect(() => {
    let mounted = true;
    const loadOverview = async () => {
      setLoading(true);
      try {
        const [tasksRes, meRes] = await Promise.all([
          taskAPI.getAllTasks().catch(() => ({ tasks: [] })),
          authAPI.getCurrentUser().catch(() => ({ user: null })),
        ]);
        const tasks = tasksRes?.tasks || [];
        const me = meRes?.user || null;
        const myDept = me?.department || '';

        const activeStatuses = new Set([
          'pending',
          'forwarded',
          'assigned',
          'in_progress',
          'submitted',
          'under_review',
          'need_improvement',
          'approved',
        ]);
        const terminalStatuses = new Set(['completed', 'cancelled', 'rejected']);

        const activeTasks = tasks.filter((t) => activeStatuses.has((t.status || '').toLowerCase())).length;
        const completedTasks = tasks.filter((t) => (t.status || '').toLowerCase() === 'completed').length;
        const projectKeys = new Set(
          tasks
            .map((t) => (t.projectId || t.projectName || '').trim())
            .filter(Boolean)
        );

        let teamMembers = 0;
        if (myDept) {
          const deptRes = await authAPI.getUsersByDepartment(myDept).catch(() => ({ users: [] }));
          teamMembers = (deptRes?.users || []).length;
        }

        const activityRows = tasks
          .map((t) => {
            const status = (t.status || '').toLowerCase();
            const title = t.title || t.taskName || t.taskNumber || 'Task';
            const updatedAt = t.updatedAt || t.createdAt;
            if (status === 'completed') {
              return {
                icon: '✓',
                text: `Task completed: ${title}`,
                time: updatedAt,
              };
            }
            if (terminalStatuses.has(status)) {
              return {
                icon: '⚑',
                text: `Task ${status.replace('_', ' ')}: ${title}`,
                time: updatedAt,
              };
            }
            return {
              icon: '📝',
              text: `Task updated: ${title}`,
              time: updatedAt,
            };
          })
          .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
          .slice(0, 8);

        if (!mounted) return;
        setStats({
          activeTasks,
          completedTasks,
          projects: projectKeys.size,
          teamMembers,
        });
        setRecentActivity(activityRows);
      } catch (error) {
        console.error('Failed to load workspace overview:', error);
        if (!mounted) return;
        setStats({
          activeTasks: 0,
          completedTasks: 0,
          projects: 0,
          teamMembers: 0,
        });
        setRecentActivity([]);
      } finally {
        if (mounted) setLoading(false);
      }
    };

    loadOverview();
    return () => {
      mounted = false;
    };
  }, []);

  return (
    <div className="tab-content">
      <h3>Workspace Overview</h3>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="card-icon">📋</div>
          <div className="card-info">
            <div className="card-value">{stats.activeTasks}</div>
            <div className="card-label">Active Tasks</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="card-icon">✅</div>
          <div className="card-info">
            <div className="card-value">{stats.completedTasks}</div>
            <div className="card-label">Completed</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="card-icon">📁</div>
          <div className="card-info">
            <div className="card-value">{stats.projects}</div>
            <div className="card-label">Projects</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="card-icon">👥</div>
          <div className="card-info">
            <div className="card-value">{stats.teamMembers}</div>
            <div className="card-label">Team Members</div>
          </div>
        </div>
      </div>

      <div className="recent-activity">
        <h4>Recent Activity</h4>
        <div className="activity-list">
          {loading && (
            <div className="activity-item">
              <span className="activity-icon">⏳</span>
              <span className="activity-text">Loading live activity...</span>
              <span className="activity-time">now</span>
            </div>
          )}
          {!loading && recentActivity.length === 0 && (
            <div className="activity-item">
              <span className="activity-icon">•</span>
              <span className="activity-text">No recent activity available yet.</span>
              <span className="activity-time">-</span>
            </div>
          )}
          {!loading && recentActivity.map((item, idx) => (
            <div className="activity-item" key={`${item.text}-${idx}`}>
              <span className="activity-icon">{item.icon}</span>
              <span className="activity-text">{item.text}</span>
              <span className="activity-time">{formatRelativeTime(item.time)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// Projects Tab Content
const ACTIVE_PROJECT_STATUSES = new Set([
  'pending',
  'forwarded',
  'assigned',
  'in_progress',
  'submitted',
  'under_review',
  'need_improvement',
  'approved',
]);

function formatProjectDate(value) {
  if (!value) return 'No recent activity';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No recent activity';
  return date.toLocaleString();
}

function buildProjectSummaries(tasks = []) {
  const groups = new Map();

  tasks.forEach((task) => {
    const projectId = (task.projectId || '').trim();
    const projectName = (task.projectName || '').trim();
    if (!projectId && !projectName) return;

    const key = projectId ? `id:${projectId.toLowerCase()}` : `name:${projectName.toLowerCase()}`;
    const existing = groups.get(key) || {
      key,
      name: projectName || projectId,
      projectId,
      customerName: '',
      latestActivityAt: '',
      tasks: [],
      departments: new Set(),
      assignees: new Set(),
    };

    existing.name = existing.name || projectName || projectId;
    existing.projectId = existing.projectId || projectId;
    existing.customerName = existing.customerName || (task.customerName || '').trim();

    if (task.fromDepartment) existing.departments.add(task.fromDepartment);
    if (task.toDepartment) existing.departments.add(task.toDepartment);
    (task.assignedTo || []).forEach((member) => {
      existing.assignees.add(member.id || member.name || `${task.id}-assignee`);
    });

    const activityAt = task.updatedAt || task.createdAt || '';
    if (!existing.latestActivityAt || new Date(activityAt).getTime() > new Date(existing.latestActivityAt).getTime()) {
      existing.latestActivityAt = activityAt;
    }

    existing.tasks.push(task);
    groups.set(key, existing);
  });

  return Array.from(groups.values())
    .map((project) => {
      const projectTasks = [...project.tasks].sort(
        (a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
      const totalTasks = projectTasks.length;
      const completedTasks = projectTasks.filter((task) => (task.status || '').toLowerCase() === 'completed').length;
      const activeTasks = projectTasks.filter((task) => ACTIVE_PROJECT_STATUSES.has((task.status || '').toLowerCase())).length;
      const progress = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

      return {
        ...project,
        tasks: projectTasks,
        totalTasks,
        completedTasks,
        activeTasks,
        progress,
        statusClass: totalTasks > 0 && completedTasks === totalTasks ? 'completed' : 'active',
        statusLabel: totalTasks > 0 && completedTasks === totalTasks ? 'Completed' : 'Active',
        description:
          project.customerName ||
          `${totalTasks} task${totalTasks === 1 ? '' : 's'} across ${Math.max(project.departments.size, 1)} department${project.departments.size === 1 ? '' : 's'}`,
        departments: Array.from(project.departments).sort(),
        assigneeCount: project.assignees.size,
      };
    })
    .sort((a, b) => new Date(b.latestActivityAt || 0).getTime() - new Date(a.latestActivityAt || 0).getTime());
}

function ProjectsContent() {
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState([]);
  const [selectedProjectKey, setSelectedProjectKey] = useState('');
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');

  const loadProjects = async ({ preserveSelection = true } = {}) => {
    setLoading(true);
    setError('');
    try {
      const [inboxResponse, outboxResponse] = await Promise.all([
        taskAPI.getInbox(),
        taskAPI.getOutbox(),
      ]);
      const mergedTasks = [...(inboxResponse?.data || []), ...(outboxResponse?.data || [])];
      const uniqueTasks = Array.from(
        new Map(mergedTasks.map((task) => [task.id, task])).values()
      );
      const groupedProjects = buildProjectSummaries(uniqueTasks);
      setProjects(groupedProjects);
      setSelectedProjectKey((prev) => {
        if (preserveSelection && prev && groupedProjects.some((project) => project.key === prev)) {
          return prev;
        }
        return groupedProjects[0]?.key || '';
      });
    } catch (loadError) {
      console.error('Failed to load live projects:', loadError);
      setProjects([]);
      setSelectedProjectKey('');
      setError('Could not load live projects right now.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadProjects({ preserveSelection: false });
  }, []);

  const filteredProjects = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => {
      const departmentText = project.departments.join(' ').toLowerCase();
      return (
        project.name.toLowerCase().includes(query) ||
        (project.projectId || '').toLowerCase().includes(query) ||
        (project.customerName || '').toLowerCase().includes(query) ||
        departmentText.includes(query)
      );
    });
  }, [projects, search]);

  const selectedProject = useMemo(() => {
    if (!selectedProjectKey) return filteredProjects[0] || null;
    return filteredProjects.find((project) => project.key === selectedProjectKey)
      || projects.find((project) => project.key === selectedProjectKey)
      || null;
  }, [filteredProjects, projects, selectedProjectKey]);

  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Projects</h3>
        <button className="add-btn" onClick={() => void loadProjects()}>
          Refresh
        </button>
      </div>

      <div className="projects-toolbar">
        <input
          className="projects-search"
          type="text"
          placeholder="Search project folder..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="projects-helper-text">
          Create tasks with the same project name to keep them inside one project folder.
        </div>
      </div>

      {error && <div className="team-member-card">{error}</div>}

      <div className="projects-live-layout">
        <div className="projects-grid">
          {loading && (
            <div className="project-card">
              <div className="project-header">
                <h4>Loading live projects...</h4>
              </div>
              <p className="project-description">Reading project folders from your real tasks.</p>
            </div>
          )}

          {!loading && filteredProjects.length === 0 && (
            <div className="project-card">
              <div className="project-header">
                <h4>No project folders yet</h4>
              </div>
              <p className="project-description">
                Create a task with a project name and it will show up here automatically.
              </p>
            </div>
          )}

          {!loading && filteredProjects.map((project) => (
            <button
              key={project.key}
              type="button"
              className={`project-card live-project-card ${selectedProjectKey === project.key ? 'selected' : ''}`}
              onClick={() => setSelectedProjectKey(project.key)}
            >
              <div className="project-header">
                <h4>{project.name}</h4>
                <span className={`project-status ${project.statusClass}`}>{project.statusLabel}</span>
              </div>
              <div className="project-folder-meta">
                <span className="project-folder-icon">📁</span>
                <span>{project.projectId || 'No Project ID'}</span>
              </div>
              <p className="project-description">{project.description}</p>
              <div className="project-stats-row">
                <span>{project.totalTasks} task{project.totalTasks === 1 ? '' : 's'}</span>
                <span>{project.assigneeCount} assignee{project.assigneeCount === 1 ? '' : 's'}</span>
                <span>{project.departments.length || 1} dept</span>
              </div>
              <div className="project-progress">
                <div className="progress-bar">
                  <div className="progress-fill" style={{ width: `${project.progress}%` }}></div>
                </div>
                <span className="progress-text">
                  {project.progress}% Complete • {project.completedTasks}/{project.totalTasks} finished
                </span>
              </div>
            </button>
          ))}
        </div>

        <div className="project-folder-panel">
          {!selectedProject && (
            <div className="project-folder-empty">
              Select a project folder to see the tasks inside it.
            </div>
          )}

          {selectedProject && (
            <>
              <div className="project-folder-panel-header">
                <div>
                  <div className="project-folder-badge">Project Folder</div>
                  <h4>{selectedProject.name}</h4>
                  <p>
                    {selectedProject.projectId || 'No Project ID'} • Last activity {formatProjectDate(selectedProject.latestActivityAt)}
                  </p>
                </div>
                <span className={`project-status ${selectedProject.statusClass}`}>{selectedProject.statusLabel}</span>
              </div>

              <div className="project-folder-summary">
                <div className="overview-card compact">
                  <div className="card-info">
                    <div className="card-value">{selectedProject.totalTasks}</div>
                    <div className="card-label">Tasks</div>
                  </div>
                </div>
                <div className="overview-card compact">
                  <div className="card-info">
                    <div className="card-value">{selectedProject.activeTasks}</div>
                    <div className="card-label">Active</div>
                  </div>
                </div>
                <div className="overview-card compact">
                  <div className="card-info">
                    <div className="card-value">{selectedProject.completedTasks}</div>
                    <div className="card-label">Completed</div>
                  </div>
                </div>
              </div>

              <div className="project-task-list">
                {selectedProject.tasks.map((task) => (
                  <div className="project-task-item" key={task.id}>
                    <div className="project-task-main">
                      <div className="project-task-title">{task.title || task.taskNumber || `Task ${task.id}`}</div>
                      <div className="project-task-meta">
                        <span>{task.taskNumber || 'No Task ID'}</span>
                        <span>{task.toDepartment || task.fromDepartment || 'No department'}</span>
                        <span>{task.assignedTo?.length || 0} assignee{(task.assignedTo?.length || 0) === 1 ? '' : 's'}</span>
                      </div>
                    </div>
                    <div className="project-task-side">
                      <span className={`project-status ${((task.status || '').toLowerCase() === 'completed') ? 'completed' : 'active'}`}>
                        {(task.status || 'pending').replaceAll('_', ' ')}
                      </span>
                      <span className="project-task-date">
                        {task.deadline ? `Due ${formatProjectDate(task.deadline)}` : formatProjectDate(task.updatedAt || task.createdAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Tasks Tab Content
function TasksContent() {
  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>All Tasks</h3>
        <button className="add-btn">+ Add Task</button>
      </div>
      <div className="tasks-list">
        <div className="task-item">
          <input type="checkbox" className="task-checkbox" />
          <div className="task-details">
            <div className="task-title">Update documentation</div>
            <div className="task-meta">Due: Today • Priority: High</div>
          </div>
        </div>
        <div className="task-item">
          <input type="checkbox" className="task-checkbox" />
          <div className="task-details">
            <div className="task-title">Review pull requests</div>
            <div className="task-meta">Due: Tomorrow • Priority: Medium</div>
          </div>
        </div>
        <div className="task-item completed">
          <input type="checkbox" className="task-checkbox" checked />
          <div className="task-details">
            <div className="task-title">Fix login bug</div>
            <div className="task-meta">Completed yesterday</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Team Tab Content
function TeamContent() {
  const { showAlert } = useCustomDialogs();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [myDepartment, setMyDepartment] = useState('');
  const [isHodUser, setIsHodUser] = useState(false);
  const [activityByUser, setActivityByUser] = useState({});
  const [infoMember, setInfoMember] = useState(null);

  const formatSeconds = (seconds = 0) => {
    const total = Number(seconds) || 0;
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hrs}h ${mins}m ${secs}s`;
  };
  const formatDateTimeIndia = (value) => {
    if (!value) return 'N/A';
    try {
      return new Date(value).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    } catch {
      return 'N/A';
    }
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const me = await authAPI.getCurrentUser();
        const myDept = me?.user?.department || '';
        const position = (me?.user?.position || '').toLowerCase();
        const roles = (me?.user?.roles || []).map((r) => String(r).toLowerCase());
        const hod = position.includes('hod') || roles.includes('hod');
        setIsHodUser(hod);
        setMyDepartment(myDept);
        if (!myDept) {
          setMembers([]);
          return;
        }

        const deptUsersResponse = await authAPI.getUsersByDepartment(myDept);
        const users = (deptUsersResponse?.users || []).map((u) => ({
          id: u.id,
          name: u.name || `User ${u.id}`,
          department: u.department || myDept,
          position: u.position || 'Member',
        }));
        setMembers(users);

        if (hod) {
          try {
            const activityResponse = await activityAPI.department();
            const activityRows = activityResponse?.data || [];
            const map = {};
            activityRows.forEach((row) => {
              map[row.userId] = row;
            });
            setActivityByUser(map);
          } catch (activityError) {
            console.warn('Activity data unavailable for team:', activityError);
            setActivityByUser({});
          }
        } else {
          setActivityByUser({});
        }
      } catch (error) {
        console.error('Failed to load team data:', error);
        setMembers([]);
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Team Members ({myDepartment || 'Department'})</h3>
      </div>
      <div className="team-grid">
        {loading && <div className="team-member-card">Loading team members...</div>}
        {!loading && members.length === 0 && <div className="team-member-card">No members found in your department.</div>}
        {!loading && members.map((member) => (
          <div className="team-member-card" key={member.id}>
            <div className="member-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
            <div className="member-info">
              <div className="member-name">{member.name}</div>
              <div className="member-role">{member.department}</div>
              <div className="member-role">{member.position}</div>
            </div>
            <div className="outbox-card-menu-wrap" style={{ marginLeft: 'auto' }}>
              <button className="outbox-card-menu-btn" onClick={() => setOpenMenuId(openMenuId === member.id ? null : member.id)}>⋮</button>
              {openMenuId === member.id && (
                <div className="outbox-card-menu">
                  <button
                    onClick={() => {
                      setOpenMenuId(null);
                      void showAlert(`Chat with ${member.name} will open here.`, { title: 'Team Chat' });
                    }}
                  >
                    Chat
                  </button>
                  {isHodUser && (
                    <button
                      onClick={() => {
                        setOpenMenuId(null);
                        setInfoMember(member);
                      }}
                    >
                      Info
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {infoMember && (
        <>
          <div
            className="admin-queue-overlay"
            onClick={() => setInfoMember(null)}
            style={{ zIndex: 1400 }}
          />
          <div
            className="admin-queue-panel"
            style={{ zIndex: 1401, width: 'min(560px, 92vw)', height: 'auto', maxHeight: '80vh' }}
          >
            <div className="admin-queue-header">
              <h3>Member Info</h3>
              <button onClick={() => setInfoMember(null)}>✕</button>
            </div>
            <div className="admin-queue-content" style={{ gridTemplateColumns: '1fr', gap: '10px' }}>
              <div className="admin-queue-item">
                <p><strong>Name:</strong> {infoMember.name}</p>
                <p><strong>Department:</strong> {infoMember.department}</p>
                <p><strong>Position:</strong> {infoMember.position}</p>
                <p><strong>Status:</strong> {activityByUser[infoMember.id]?.status || 'OFFLINE'}</p>
                <p><strong>Login Time:</strong> {formatDateTimeIndia(activityByUser[infoMember.id]?.loginTime)}</p>
                <p><strong>Session Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.totalSessionDuration || 0)}</p>
                <p><strong>Active Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.activeTime || 0)}</p>
                <p><strong>Idle Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.idleTime || 0)}</p>
                <p><strong>Away Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.awayTime || 0)}</p>
                <p><strong>Last Seen:</strong> {formatDateTimeIndia(activityByUser[infoMember.id]?.lastSeen)}</p>
                <p><strong>Heartbeat Count:</strong> {activityByUser[infoMember.id]?.heartbeatCount ?? 0}</p>
                <p><strong>Productivity:</strong> {activityByUser[infoMember.id]?.productivity ?? 0}%</p>
                <p><strong>Tasks Done Today:</strong> {activityByUser[infoMember.id]?.tasksDone ?? 0}</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function CompanyContent() {
  const { showAlert } = useCustomDialogs();
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [selectedDepartment, setSelectedDepartment] = useState('');
  const [members, setMembers] = useState([]);
  const [openMenuId, setOpenMenuId] = useState(null);
  const [infoMember, setInfoMember] = useState(null);
  const [activityByUser, setActivityByUser] = useState({});

  const formatSeconds = (seconds = 0) => {
    const total = Number(seconds) || 0;
    const hrs = Math.floor(total / 3600);
    const mins = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hrs}h ${mins}m ${secs}s`;
  };
  const formatDateTimeIndia = (value) => {
    if (!value) return 'N/A';
    try {
      return new Date(value).toLocaleString('en-IN', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    } catch {
      return 'N/A';
    }
  };

  const loadMembersByDepartment = async (departmentName) => {
    try {
      const response = await authAPI.getUsersByDepartment(departmentName);
      setMembers(response?.users || []);
    } catch (error) {
      console.error('Failed to load users by department:', error);
      setMembers([]);
    }
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const me = await authAPI.getCurrentUser();
        const meRoles = (me?.user?.roles || []).map((r) => String(r).toLowerCase());
        const mePosition = (me?.user?.position || '').toLowerCase();
        const adminAccess = me?.user?.isAdmin || meRoles.includes('admin') || mePosition === 'admin';
        setIsAdmin(!!adminAccess);

        if (!adminAccess) {
          setDepartments([]);
          return;
        }

        const [deptRes, activityRes] = await Promise.all([
          authAPI.getDepartments(),
          activityAPI.allUsers().catch(() => ({ data: [] })),
        ]);
        const deptList = deptRes?.departments || [];
        setDepartments(deptList);
        if (deptList.length > 0) {
          setSelectedDepartment(deptList[0]);
          await loadMembersByDepartment(deptList[0]);
        }

        const activityMap = {};
        (activityRes?.data || []).forEach((row) => {
          activityMap[row.userId] = row;
        });
        setActivityByUser(activityMap);
      } catch (error) {
        console.error('Failed to load company view data:', error);
        setDepartments([]);
        setMembers([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  const onSelectDepartment = async (departmentName) => {
    setSelectedDepartment(departmentName);
    await loadMembersByDepartment(departmentName);
  };

  if (loading) {
    return (
      <div className="tab-content">
        <h3>Company</h3>
        <p>Loading company data...</p>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="tab-content">
        <h3>Company</h3>
        <p>Admin access required to view all company members.</p>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Company Directory</h3>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', marginBottom: '14px' }}>
        {departments.map((dept) => (
          <button
            key={dept}
            className="add-btn"
            style={{
              textAlign: 'left',
              opacity: selectedDepartment === dept ? 1 : 0.8,
              border: selectedDepartment === dept ? '1px solid rgba(255,255,255,0.35)' : undefined
            }}
            onClick={() => onSelectDepartment(dept)}
          >
            {dept}
          </button>
        ))}
      </div>

      <div className="team-grid">
        {members.length === 0 && <div className="team-member-card">No members found in selected department.</div>}
        {members.map((member) => (
          <div className="team-member-card" key={member.id}>
            <div className="member-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
            <div className="member-info">
              <div className="member-name">{member.name}</div>
              <div className="member-role">{member.department || selectedDepartment}</div>
              <div className="member-role">{member.position || 'Member'}</div>
            </div>
            <div className="outbox-card-menu-wrap" style={{ marginLeft: 'auto' }}>
              <button className="outbox-card-menu-btn" onClick={() => setOpenMenuId(openMenuId === member.id ? null : member.id)}>⋮</button>
              {openMenuId === member.id && (
                <div className="outbox-card-menu">
                  <button
                    onClick={() => {
                      setOpenMenuId(null);
                      void showAlert(`Chat with ${member.name} will open here.`, { title: 'Team Chat' });
                    }}
                  >
                    Chat
                  </button>
                  <button
                    onClick={() => {
                      setOpenMenuId(null);
                      setInfoMember(member);
                    }}
                  >
                    Info
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {infoMember && (
        <>
          <div
            className="admin-queue-overlay"
            onClick={() => setInfoMember(null)}
            style={{ zIndex: 1400 }}
          />
          <div
            className="admin-queue-panel"
            style={{ zIndex: 1401, width: 'min(560px, 92vw)', height: 'auto', maxHeight: '80vh' }}
          >
            <div className="admin-queue-header">
              <h3>Member Info</h3>
              <button onClick={() => setInfoMember(null)}>✕</button>
            </div>
            <div className="admin-queue-content" style={{ gridTemplateColumns: '1fr', gap: '10px' }}>
              <div className="admin-queue-item">
                <p><strong>Name:</strong> {infoMember.name}</p>
                <p><strong>Department:</strong> {infoMember.department || selectedDepartment}</p>
                <p><strong>Position:</strong> {infoMember.position || 'Member'}</p>
                <p><strong>Status:</strong> {activityByUser[infoMember.id]?.status || 'OFFLINE'}</p>
                <p><strong>Login Time:</strong> {formatDateTimeIndia(activityByUser[infoMember.id]?.loginTime)}</p>
                <p><strong>Session Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.totalSessionDuration || 0)}</p>
                <p><strong>Active Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.activeTime || 0)}</p>
                <p><strong>Idle Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.idleTime || 0)}</p>
                <p><strong>Away Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.awayTime || 0)}</p>
                <p><strong>Last Seen:</strong> {formatDateTimeIndia(activityByUser[infoMember.id]?.lastSeen)}</p>
                <p><strong>Heartbeat Count:</strong> {activityByUser[infoMember.id]?.heartbeatCount ?? 0}</p>
                <p><strong>Productivity:</strong> {activityByUser[infoMember.id]?.productivity ?? 0}%</p>
                <p><strong>Tasks Done Today:</strong> {activityByUser[infoMember.id]?.tasksDone ?? 0}</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function GroupsContent() {
  const [loading, setLoading] = useState(true);
  const [allUsers, setAllUsers] = useState([]);
  const [currentUserId, setCurrentUserId] = useState(null);
  const [groupName, setGroupName] = useState('');
  const [selectedIds, setSelectedIds] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [newMessage, setNewMessage] = useState('');
  const [sendingMessage, setSendingMessage] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [pendingAttachments, setPendingAttachments] = useState([]);
  const [showAddMemberPanel, setShowAddMemberPanel] = useState(false);
  const [showGroupMenu, setShowGroupMenu] = useState(false);
  const [addMemberSelection, setAddMemberSelection] = useState([]);
  const [feedback, setFeedback] = useState('');
  const messagesEndRef = useRef(null);
  const selectedGroupIdRef = useRef(null);
  const groupMenuRef = useRef(null);
  const attachmentInputRef = useRef(null);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );
  const isSelectedGroupAdmin = !!selectedGroup && selectedGroup.myRole === 'admin';
  const selectedGroupPreviewNames = (selectedGroup?.members || []).slice(0, 3).map((member) => member.name).join(', ');

  const buildDayLabel = (value) => {
    if (!value) return 'Recent';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Recent';
    const today = new Date();
    const messageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const todayDay = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const diffDays = Math.round((todayDay.getTime() - messageDay.getTime()) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    return date.toLocaleDateString(undefined, {
      day: 'numeric',
      month: 'short',
      year: messageDay.getFullYear() === todayDay.getFullYear() ? undefined : 'numeric',
    });
  };

  const formatMessageTime = (value) => {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  };

  const buildInitials = (value) =>
    (value || '')
      .split(' ')
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'G';

  const buildAvatarHue = (value) =>
    Array.from(value || 'group').reduce((total, char) => total + char.charCodeAt(0), 0) % 360;

  const buildAttachmentOpenUrl = (attachment) => {
    const params = new URLSearchParams();
    if (attachment?.path) params.set('path', attachment.path);
    else if (attachment?.url) params.set('url', attachment.url);
    return `${FILES_API_BASE}/api/files/open?${params.toString()}`;
  };

  const buildAttachmentPreviewUrl = (attachment) => buildAttachmentOpenUrl(attachment);

  const buildAttachmentDownloadUrl = (attachment) => {
    const params = new URLSearchParams();
    if (attachment?.path) params.set('path', attachment.path);
    else if (attachment?.url) params.set('url', attachment.url);
    if (attachment?.originalName || attachment?.filename) {
      params.set('filename', attachment.originalName || attachment.filename);
    }
    return `${FILES_API_BASE}/api/files/download?${params.toString()}`;
  };

  const getAttachmentLabel = (attachment) =>
    attachment?.originalName || attachment?.filename || 'Attachment';

  const isImageAttachment = (attachment) => `${attachment?.mimetype || ''}`.startsWith('image/');
  const isVideoAttachment = (attachment) => `${attachment?.mimetype || ''}`.startsWith('video/');

  const messageItems = useMemo(() => {
    const items = [];
    let lastLabel = null;

    messages.forEach((msg) => {
      const label = buildDayLabel(msg.createdAt);
      if (label !== lastLabel) {
        items.push({ type: 'separator', id: `sep-${label}-${msg.id}`, label });
        lastLabel = label;
      }
      items.push({ type: 'message', id: msg.id, message: msg });
    });

    return items;
  }, [messages]);

  const syncGroups = async ({ keepSelected = true } = {}) => {
    const res = await groupAPI.listGroups();
    const nextGroups = res?.data || [];
    setGroups(nextGroups);
    if (nextGroups.length === 0) {
      setSelectedGroupId(null);
      setMessages([]);
      return;
    }
    if (!keepSelected || !nextGroups.some((g) => g.id === selectedGroupId)) {
      setSelectedGroupId(nextGroups[0].id);
    }
  };

  const loadMessages = async (groupId) => {
    if (!groupId) {
      setMessages([]);
      return;
    }
    const res = await groupAPI.listMessages(groupId);
    setMessages(res?.data || []);
  };

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const [meRes, usersRes] = await Promise.all([
          authAPI.getCurrentUser(),
          groupAPI.listUsers(),
        ]);
        setCurrentUserId(meRes?.user?.id || null);
        setAllUsers(usersRes?.data || []);
        await syncGroups({ keepSelected: false });
      } catch (error) {
        console.error('Failed to load users for groups:', error);
        setAllUsers([]);
        setGroups([]);
        setSelectedGroupId(null);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, []);

  useEffect(() => {
    loadMessages(selectedGroupId).catch((err) => {
      console.error('Failed to load messages:', err);
      setMessages([]);
    });
  }, [selectedGroupId]);

  useEffect(() => {
    selectedGroupIdRef.current = selectedGroupId;
  }, [selectedGroupId]);

  useEffect(() => {
    setShowAddMemberPanel(false);
    setShowGroupMenu(false);
    setAddMemberSelection([]);
    setPendingAttachments([]);
    setNewMessage('');
  }, [selectedGroupId]);

  useEffect(() => {
    if (!showGroupMenu) return undefined;

    const handlePointerDown = (event) => {
      if (groupMenuRef.current && !groupMenuRef.current.contains(event.target)) {
        setShowGroupMenu(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [showGroupMenu]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      syncGroups().catch(() => {});
      if (selectedGroupId) {
        loadMessages(selectedGroupId).catch(() => {});
      }
    }, 60000);
    return () => clearInterval(interval);
  }, [selectedGroupId]);

  useEffect(() => {
    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload || payload.eventType !== 'group_message') return;
        const groupId = payload?.metadata?.groupId;
        if (!groupId) return;

        syncGroups().catch(() => {});
        if (selectedGroupIdRef.current === groupId) {
          loadMessages(groupId).catch(() => {});
        }
      },
      onOpen: () => {
        syncGroups().catch(() => {});
        if (selectedGroupIdRef.current) {
          loadMessages(selectedGroupIdRef.current).catch(() => {});
        }
      },
    });

    return () => {
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const toggleSelected = (id) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const createGroup = async () => {
    if (!groupName.trim() || selectedIds.length === 0) return;
    try {
      setFeedback('');
      const res = await groupAPI.createGroup(groupName.trim(), selectedIds);
      const created = res?.data;
      if (created) {
        setGroups((prev) => [created, ...prev.filter((g) => g.id !== created.id)]);
        setSelectedGroupId(created.id);
      } else {
        await syncGroups();
      }
      setGroupName('');
      setSelectedIds([]);
      setFeedback('Group created successfully.');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to create group.');
    }
  };

  const saveAddMembers = async (groupId) => {
    if (!addMemberSelection.length) return;
    try {
      setFeedback('');
      const res = await groupAPI.addMembers(groupId, addMemberSelection);
      const updated = res?.data;
      setGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
      setAddMemberSelection([]);
      setShowAddMemberPanel(false);
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to add members.');
    }
  };

  const sendMessage = async () => {
    if (!selectedGroupId || sendingMessage || uploadingAttachment) return;
    const trimmedMessage = newMessage.trim();
    if (!trimmedMessage && pendingAttachments.length === 0) return;
    setSendingMessage(true);
    try {
      const res = await groupAPI.sendMessage(selectedGroupId, {
        message: trimmedMessage,
        attachments: pendingAttachments,
      });
      const sent = res?.data;
      setMessages((prev) => (sent ? [...prev, sent] : prev));
      setNewMessage('');
      setPendingAttachments([]);
      await syncGroups();
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to send message.');
    } finally {
      setSendingMessage(false);
    }
  };

  const handleAttachmentSelect = async (event) => {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setUploadingAttachment(true);
    try {
      const response = await fileAPI.uploadFiles(files);
      setPendingAttachments((prev) => [...prev, ...(response?.data || [])]);
      setFeedback('');
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to upload attachment.');
    } finally {
      setUploadingAttachment(false);
      if (attachmentInputRef.current) {
        attachmentInputRef.current.value = '';
      }
    }
  };

  const updateMemberRole = async (memberId, role) => {
    if (!selectedGroupId) return;
    try {
      const res = await groupAPI.updateMemberRole(selectedGroupId, memberId, role);
      const updated = res?.data;
      setGroups((prev) => prev.map((g) => (g.id === selectedGroupId ? updated : g)));
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to update role.');
    }
  };

  const removeMember = async (memberId) => {
    if (!selectedGroupId) return;
    try {
      const res = await groupAPI.removeMember(selectedGroupId, memberId);
      const updated = res?.data;
      if (memberId === currentUserId) {
        await syncGroups({ keepSelected: false });
      } else {
        setGroups((prev) => prev.map((g) => (g.id === selectedGroupId ? updated : g)));
      }
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to remove member.');
    }
  };

  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Groups</h3>
        <button className="add-btn" onClick={() => syncGroups().catch(() => {})}>Refresh</button>
      </div>

      {feedback && <div className="team-member-card" style={{ marginBottom: '10px' }}>{feedback}</div>}

      <div className="groups-shell">
        <div className="groups-sidebar">
          <div className="groups-create-card">
            <div className="groups-create-title">Create Group</div>
            <input
              className="groups-input"
              type="text"
              placeholder="Group name..."
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <div className="groups-user-picker">
              {loading && <div>Loading employees...</div>}
              {!loading && allUsers.map((user) => (
                <label key={user.id} className="groups-user-option">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(user.id)}
                    onChange={() => toggleSelected(user.id)}
                  />
                  <span>{user.name} ({user.department || 'N/A'})</span>
                </label>
              ))}
            </div>
            <button className="add-btn" onClick={createGroup} disabled={!groupName.trim() || selectedIds.length === 0}>
              + Create Group
            </button>
          </div>

          <div className="groups-list">
            {groups.length === 0 && <div className="team-member-card">No groups created yet.</div>}
            {groups.map((group) => (
              <button
                type="button"
                className={`group-thread-card ${selectedGroupId === group.id ? 'active' : ''}`}
                key={group.id}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <div
                  className="group-thread-avatar"
                  style={{ '--group-avatar-hue': `${buildAvatarHue(group.name)}deg` }}
                >
                  {buildInitials(group.name)}
                </div>
                <div className="group-thread-copy">
                  <div className="group-thread-topline">
                    <div className="group-thread-name">{group.name}</div>
                    <div className="group-thread-meta">{group.memberCount} members</div>
                  </div>
                  <div className="group-thread-subline">
                    <span>Your role: {group.myRole}</span>
                    <span>{group.members?.slice(0, 2).map((member) => member.name).join(', ')}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>
        </div>

        <div className="groups-chat-window">
          {!selectedGroup && (
            <div className="group-chat-empty">
              <div className="group-chat-empty-icon">#</div>
              <h4>Select a group to start chatting</h4>
              <p>Your group conversations will appear here in a WhatsApp-style layout.</p>
            </div>
          )}

          {selectedGroup && (
            <>
              <div className="group-chat-header">
                <div className="group-chat-summary">
                  <div
                    className="group-chat-header-avatar"
                    style={{ '--group-avatar-hue': `${buildAvatarHue(selectedGroup.name)}deg` }}
                  >
                    {buildInitials(selectedGroup.name)}
                  </div>
                  <div>
                    <div className="group-chat-title">{selectedGroup.name}</div>
                    <div className="group-chat-subtitle">
                      {selectedGroup.memberCount} members{selectedGroupPreviewNames ? `, ${selectedGroupPreviewNames}` : ''}
                    </div>
                  </div>
                </div>
                <div className="group-chat-actions">
                  <span className="group-chat-badge">{selectedGroup.myRole}</span>
                  <div className="group-chat-menu-wrap" ref={groupMenuRef}>
                    <button
                      type="button"
                      className="group-chat-menu-trigger"
                      onClick={() => setShowGroupMenu((prev) => !prev)}
                    >
                      ...
                    </button>

                    {showGroupMenu && (
                      <div className="group-chat-menu">
                        {isSelectedGroupAdmin && (
                          <button
                            type="button"
                            className="group-chat-menu-action"
                            onClick={() => setShowAddMemberPanel((prev) => !prev)}
                          >
                            {showAddMemberPanel ? 'Close Add Members' : '+ Add Members'}
                          </button>
                        )}

                        {showAddMemberPanel && isSelectedGroupAdmin && (
                          <div className="group-add-members-panel group-add-members-panel-menu">
                            <div className="group-chat-menu-title">Add Members</div>
                            <div className="group-add-members-list">
                              {allUsers
                                .filter((u) => !selectedGroup.members.some((m) => m.id === u.id))
                                .map((user) => (
                                  <label key={user.id} className="groups-user-option">
                                    <input
                                      type="checkbox"
                                      checked={addMemberSelection.includes(user.id)}
                                      onChange={() =>
                                        setAddMemberSelection((prev) =>
                                          prev.includes(user.id) ? prev.filter((x) => x !== user.id) : [...prev, user.id]
                                        )
                                      }
                                    />
                                    <span>{user.name} ({user.department || 'N/A'})</span>
                                  </label>
                                ))}
                            </div>
                            <button className="add-btn" style={{ marginTop: '8px' }} onClick={() => saveAddMembers(selectedGroup.id)}>
                              Save Members
                            </button>
                          </div>
                        )}

                        <div className="group-chat-menu-section">
                          <div className="group-chat-menu-title">Members</div>
                          <div className="group-chat-menu-members">
                            {selectedGroup.members.map((member) => (
                              <div key={member.id} className="group-member-row group-member-row-menu">
                                <div className="group-member-main">
                                  <div
                                    className="group-member-avatar"
                                    style={{ '--group-avatar-hue': `${buildAvatarHue(member.name)}deg` }}
                                  >
                                    {buildInitials(member.name)}
                                  </div>
                                  <div>
                                    <div className="group-member-name">{member.name}</div>
                                    <div className="group-member-role-line">{member.role}</div>
                                  </div>
                                </div>
                                <div className="group-member-actions">
                                  {isSelectedGroupAdmin && member.id !== currentUserId && selectedGroup.createdBy !== member.id && (
                                    <>
                                      <button
                                        className="add-btn"
                                        onClick={() => updateMemberRole(member.id, member.role === 'admin' ? 'member' : 'admin')}
                                      >
                                        {member.role === 'admin' ? 'Demote' : 'Make Admin'}
                                      </button>
                                      <button className="add-btn" onClick={() => removeMember(member.id)}>Remove</button>
                                    </>
                                  )}
                                  {member.id === currentUserId && selectedGroup.createdBy !== currentUserId && (
                                    <button className="add-btn" onClick={() => removeMember(member.id)}>Leave</button>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="group-chat-body">
                <div className="group-chat-thread">
                  {messages.length === 0 && <div className="group-chat-empty-thread">No messages yet. Say hello to the group.</div>}
                  {messageItems.map((item) => {
                    if (item.type === 'separator') {
                      return (
                        <div key={item.id} className="group-chat-day-separator">
                          <span>{item.label}</span>
                        </div>
                      );
                    }

                    const msg = item.message;
                    const mine = msg.senderId === currentUserId;
                    return (
                      <div key={item.id} className={`group-chat-row ${mine ? 'mine' : 'theirs'}`}>
                        {!mine && (
                          <div
                            className="group-message-avatar"
                            style={{ '--group-avatar-hue': `${buildAvatarHue(msg.senderName)}deg` }}
                          >
                            {buildInitials(msg.senderName)}
                          </div>
                        )}
                        <div className={`group-message-bubble ${mine ? 'mine' : 'theirs'}`}>
                          {!mine && <div className="group-message-sender">{msg.senderName}</div>}
                          {msg.message && <div className="group-message-text">{msg.message}</div>}
                          {!!msg.attachments?.length && (
                            <div className="group-message-attachments">
                              {msg.attachments.map((attachment, index) => (
                                <a
                                  key={`${msg.id}-attachment-${index}`}
                                  className="group-message-attachment-card"
                                  href={buildAttachmentOpenUrl(attachment)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {isImageAttachment(attachment) ? (
                                    <img
                                      className="group-message-attachment-preview group-message-attachment-preview-media"
                                      src={buildAttachmentPreviewUrl(attachment)}
                                      alt={getAttachmentLabel(attachment)}
                                    />
                                  ) : isVideoAttachment(attachment) ? (
                                    <video
                                      className="group-message-attachment-preview group-message-attachment-preview-media"
                                      src={buildAttachmentPreviewUrl(attachment)}
                                      controls
                                      preload="metadata"
                                      onClick={(event) => {
                                        event.preventDefault();
                                        event.stopPropagation();
                                      }}
                                    />
                                  ) : (
                                    <div className="group-message-attachment-icon">+</div>
                                  )}
                                  <div className="group-message-attachment-copy">
                                    <span>{getAttachmentLabel(attachment)}</span>
                                    <small>{attachment.mimetype || 'Attachment'}</small>
                                  </div>
                                  <span
                                    className="group-message-attachment-download"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      window.open(buildAttachmentDownloadUrl(attachment), '_blank', 'noopener,noreferrer');
                                    }}
                                  >
                                    Open
                                  </span>
                                </a>
                              ))}
                            </div>
                          )}
                          <div className="group-message-meta">
                            <span>{formatMessageTime(msg.createdAt)}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              </div>

              <div className="group-chat-composer">
                {!!pendingAttachments.length && (
                  <div className="group-chat-attachment-strip">
                    {pendingAttachments.map((attachment, index) => (
                      <div key={`${attachment.path || attachment.url || attachment.filename}-${index}`} className="group-chat-attachment-pill">
                        <span>{getAttachmentLabel(attachment)}</span>
                        <button
                          type="button"
                          onClick={() =>
                            setPendingAttachments((prev) => prev.filter((_, attachmentIndex) => attachmentIndex !== index))
                          }
                        >
                          x
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                <div className="group-chat-composer-shell">
                  <button
                    type="button"
                    className="group-chat-tool-btn"
                    onClick={() => attachmentInputRef.current?.click()}
                    title="Attach files"
                    disabled={uploadingAttachment}
                  >
                    +
                  </button>
                  <input
                    ref={attachmentInputRef}
                    type="file"
                    multiple
                    onChange={handleAttachmentSelect}
                    style={{ display: 'none' }}
                  />
                  <input
                    className="groups-input group-chat-input"
                    type="text"
                    placeholder={uploadingAttachment ? 'Uploading attachment...' : 'Type a message'}
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                  />
                  <button
                    className="group-chat-send-btn"
                    onClick={sendMessage}
                    disabled={sendingMessage || uploadingAttachment || (!newMessage.trim() && pendingAttachments.length === 0)}
                  >
                    <span className={`group-chat-send-icon ${sendingMessage ? 'sending' : ''}`} />
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Analytics Tab Content
function AnalyticsContent() {
  return (
    <div className="tab-content">
      <h3>Analytics Dashboard</h3>
      <div className="analytics-grid">
        <div className="analytics-card">
          <h4>Task Completion Rate</h4>
          <div className="analytics-value">87%</div>
          <div className="analytics-trend positive">↑ 12% from last month</div>
        </div>
        <div className="analytics-card">
          <h4>Average Task Duration</h4>
          <div className="analytics-value">2.5 days</div>
          <div className="analytics-trend negative">↓ 0.3 days from last month</div>
        </div>
        <div className="analytics-card">
          <h4>Team Productivity</h4>
          <div className="analytics-value">94%</div>
          <div className="analytics-trend positive">↑ 8% from last month</div>
        </div>
      </div>
    </div>
  );
}
// Analytics Tab Content
function ToolsContent() {
  return (
    <Tools></Tools>
  );
}
