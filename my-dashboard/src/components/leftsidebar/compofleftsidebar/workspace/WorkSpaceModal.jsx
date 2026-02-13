import React, { useState } from 'react';
import './WorkSpaceModal.css';
import Tools from './Tools';

export default function WorkSpaceModal({ isOpen, onClose }) {
  const [activeTab, setActiveTab] = useState('overview');

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="workspace-backdrop" onClick={onClose} />

      {/* Main Workspace Window */}
      <div className="workspace-window">
        {/* Header */}
        <div className="workspace-header">
          <div className="workspace-header-left">
            <div className="workspace-icon">📊</div>
            <h2>Workspace</h2>
          </div>
          <div className="workspace-header-right">
            <button className="workspace-minimize-btn" title="Minimize">─</button>
            <button className="workspace-maximize-btn" title="Maximize">□</button>
            <button className="workspace-close-btn" onClick={onClose}>✕</button>
          </div>
        </div>

        {/* Tabs Navigation */}
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

        {/* Content Area */}
        <div className="workspace-content">
          {activeTab === 'overview' && <OverviewContent />}
          {activeTab === 'projects' && <ProjectsContent />}
          {activeTab === 'tasks' && <TasksContent />}
          {activeTab === 'team' && <TeamContent />}
          {activeTab === 'analytics' && <AnalyticsContent />}
          {activeTab === 'Tools' && <Tools />}
        </div>
      </div>
    </>
  );
}

// Overview Tab Content
function OverviewContent() {
  return (
    <div className="tab-content">
      <h3>Workspace Overview</h3>
      <div className="overview-grid">
        <div className="overview-card">
          <div className="card-icon">📋</div>
          <div className="card-info">
            <div className="card-value">24</div>
            <div className="card-label">Active Tasks</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="card-icon">✅</div>
          <div className="card-info">
            <div className="card-value">156</div>
            <div className="card-label">Completed</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="card-icon">📁</div>
          <div className="card-info">
            <div className="card-value">8</div>
            <div className="card-label">Projects</div>
          </div>
        </div>
        <div className="overview-card">
          <div className="card-icon">👥</div>
          <div className="card-info">
            <div className="card-value">12</div>
            <div className="card-label">Team Members</div>
          </div>
        </div>
      </div>

      <div className="recent-activity">
        <h4>Recent Activity</h4>
        <div className="activity-list">
          <div className="activity-item">
            <span className="activity-icon">✓</span>
            <span className="activity-text">Task completed: Design mockups</span>
            <span className="activity-time">2 hours ago</span>
          </div>
          <div className="activity-item">
            <span className="activity-icon">📝</span>
            <span className="activity-text">New task created: Review documentation</span>
            <span className="activity-time">4 hours ago</span>
          </div>
          <div className="activity-item">
            <span className="activity-icon">👤</span>
            <span className="activity-text">John joined the team</span>
            <span className="activity-time">1 day ago</span>
          </div>
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
  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Team Members</h3>
        <button className="add-btn">+ Invite Member</button>
      </div>
      <div className="team-grid">
        <div className="team-member-card">
          <div className="member-avatar">👤</div>
          <div className="member-info">
            <div className="member-name">John Doe</div>
            <div className="member-role">Project Manager</div>
          </div>
        </div>
        <div className="team-member-card">
          <div className="member-avatar">👤</div>
          <div className="member-info">
            <div className="member-name">Jane Smith</div>
            <div className="member-role">Developer</div>
          </div>
        </div>
        <div className="team-member-card">
          <div className="member-avatar">👤</div>
          <div className="member-info">
            <div className="member-name">Mike Johnson</div>
            <div className="member-role">Designer</div>
          </div>
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
