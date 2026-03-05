import React, { useEffect, useMemo, useRef, useState } from 'react';
import './WorkSpaceModal.css';
import Tools from './Tools';
import { activityAPI, authAPI, groupAPI, taskAPI, createNotificationsSocket } from '../../../../services/api';

export default function WorkSpaceModal({ isOpen, onClose, initialTab = 'overview' }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setIsMinimized(false);
      setIsMaximized(false);
      setActiveTab(initialTab || 'overview');
    }
  }, [isOpen, initialTab]);

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
function ProjectsContent() {
  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Projects</h3>
        <button className="add-btn">+ New Project</button>
      </div>
      <div className="projects-grid">
        <div className="project-card">
          <div className="project-header">
            <h4>Website Redesign</h4>
            <span className="project-status active">Active</span>
          </div>
          <p className="project-description">Complete overhaul of company website</p>
          <div className="project-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '65%' }}></div>
            </div>
            <span className="progress-text">65% Complete</span>
          </div>
        </div>
        <div className="project-card">
          <div className="project-header">
            <h4>Mobile App</h4>
            <span className="project-status active">Active</span>
          </div>
          <p className="project-description">iOS and Android app development</p>
          <div className="project-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '40%' }}></div>
            </div>
            <span className="progress-text">40% Complete</span>
          </div>
        </div>
        <div className="project-card">
          <div className="project-header">
            <h4>Marketing Campaign</h4>
            <span className="project-status completed">Completed</span>
          </div>
          <p className="project-description">Q4 marketing strategy execution</p>
          <div className="project-progress">
            <div className="progress-bar">
              <div className="progress-fill" style={{ width: '100%' }}></div>
            </div>
            <span className="progress-text">100% Complete</span>
          </div>
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
                      alert(`Chat with ${member.name} will open here.`);
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
                      alert(`Chat with ${member.name} will open here.`);
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
  const [showAddMemberPanel, setShowAddMemberPanel] = useState(false);
  const [addMemberSelection, setAddMemberSelection] = useState([]);
  const [feedback, setFeedback] = useState('');
  const messagesEndRef = useRef(null);
  const selectedGroupIdRef = useRef(null);
  const wsRef = useRef(null);
  const reconnectTimerRef = useRef(null);

  const selectedGroup = useMemo(
    () => groups.find((g) => g.id === selectedGroupId) || null,
    [groups, selectedGroupId]
  );
  const isSelectedGroupAdmin = !!selectedGroup && selectedGroup.myRole === 'admin';

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
    let disposed = false;

    const connectWs = () => {
      if (disposed) return;
      const socket = createNotificationsSocket({
        onMessage: (payload) => {
          if (!payload || payload.eventType !== 'group_message') return;
          const groupId = payload?.metadata?.groupId;
          if (!groupId) return;

          syncGroups().catch(() => {});
          if (selectedGroupIdRef.current === groupId) {
            loadMessages(groupId).catch(() => {});
          }
        },
        onClose: () => {
          if (disposed) return;
          reconnectTimerRef.current = window.setTimeout(connectWs, 3000);
        },
      });
      wsRef.current = socket;
    };

    connectWs();

    return () => {
      disposed = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (wsRef.current && wsRef.current.readyState <= 1) {
        wsRef.current.close();
      }
      wsRef.current = null;
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
    if (!selectedGroupId || !newMessage.trim() || sendingMessage) return;
    setSendingMessage(true);
    try {
      const res = await groupAPI.sendMessage(selectedGroupId, newMessage.trim());
      const sent = res?.data;
      setMessages((prev) => (sent ? [...prev, sent] : prev));
      setNewMessage('');
      await syncGroups();
    } catch (error) {
      setFeedback(error?.response?.data?.detail || 'Failed to send message.');
    } finally {
      setSendingMessage(false);
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

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(280px, 360px) 1fr', gap: '12px' }}>
        <div style={{ display: 'grid', gap: '10px', alignContent: 'start' }}>
          <div style={{ display: 'grid', gap: '8px', border: '1px solid #2b3b59', borderRadius: '8px', padding: '10px' }}>
            <input
              type="text"
              placeholder="Group name..."
              value={groupName}
              onChange={(e) => setGroupName(e.target.value)}
            />
            <div style={{ maxHeight: '140px', overflowY: 'auto', border: '1px solid #2b3b59', borderRadius: '8px', padding: '8px' }}>
              {loading && <div>Loading employees...</div>}
              {!loading && allUsers.map((user) => (
                <label key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
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

          <div className="team-grid" style={{ marginTop: 0 }}>
            {groups.length === 0 && <div className="team-member-card">No groups created yet.</div>}
            {groups.map((group) => (
              <div
                className="team-member-card"
                key={group.id}
                style={{
                  border: selectedGroupId === group.id ? '1px solid #7f8cff' : undefined,
                  cursor: 'pointer',
                }}
                onClick={() => setSelectedGroupId(group.id)}
              >
                <div className="member-info" style={{ width: '100%' }}>
                  <div className="member-name">{group.name}</div>
                  <div className="member-role">{group.memberCount} members</div>
                  <div className="member-role">Role: {group.myRole}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ border: '1px solid #2b3b59', borderRadius: '8px', minHeight: '460px', display: 'grid', gridTemplateRows: 'auto 1fr auto' }}>
          {!selectedGroup && (
            <div style={{ padding: '16px' }}>Select a group to start chatting.</div>
          )}

          {selectedGroup && (
            <>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid #2b3b59', display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' }}>
                <div>
                  <div className="member-name">{selectedGroup.name}</div>
                  <div className="member-role">{selectedGroup.memberCount} members</div>
                </div>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                  {isSelectedGroupAdmin && (
                    <button className="add-btn" onClick={() => setShowAddMemberPanel((p) => !p)}>
                      {showAddMemberPanel ? 'Close Add Members' : '+ Add Members'}
                    </button>
                  )}
                </div>
              </div>

              {showAddMemberPanel && isSelectedGroupAdmin && (
                <div style={{ padding: '10px 12px', borderBottom: '1px solid #2b3b59' }}>
                  <div style={{ maxHeight: '130px', overflowY: 'auto', border: '1px solid #2b3b59', borderRadius: '8px', padding: '8px' }}>
                    {allUsers
                      .filter((u) => !selectedGroup.members.some((m) => m.id === u.id))
                      .map((user) => (
                        <label key={user.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
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

              <div style={{ overflowY: 'auto', padding: '12px', display: 'grid', gap: '8px' }}>
                {messages.length === 0 && <div className="member-role">No messages yet.</div>}
                {messages.map((msg) => {
                  const mine = msg.senderId === currentUserId;
                  return (
                    <div
                      key={msg.id}
                      style={{
                        justifySelf: mine ? 'end' : 'start',
                        maxWidth: '80%',
                        background: mine ? '#2d5eff' : '#223047',
                        color: '#fff',
                        borderRadius: '10px',
                        padding: '8px 10px',
                      }}
                    >
                      {!mine && <div style={{ fontSize: '11px', opacity: 0.8 }}>{msg.senderName}</div>}
                      <div>{msg.message}</div>
                      <div style={{ fontSize: '11px', opacity: 0.75, marginTop: '4px' }}>
                        {msg.createdAt ? new Date(msg.createdAt).toLocaleString() : ''}
                      </div>
                    </div>
                  );
                })}
                <div ref={messagesEndRef} />
              </div>

              <div style={{ borderTop: '1px solid #2b3b59', padding: '10px 12px' }}>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    placeholder="Type a message..."
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        sendMessage();
                      }
                    }}
                  />
                  <button className="add-btn" onClick={sendMessage} disabled={sendingMessage || !newMessage.trim()}>
                    Send
                  </button>
                </div>
                <div style={{ marginTop: '10px', display: 'grid', gap: '6px' }}>
                  <div className="member-role">Members</div>
                  <div style={{ maxHeight: '130px', overflowY: 'auto', border: '1px solid #2b3b59', borderRadius: '8px', padding: '8px' }}>
                    {selectedGroup.members.map((member) => (
                      <div key={member.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                        <span>{member.name} ({member.role})</span>
                        <div style={{ display: 'flex', gap: '6px' }}>
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
