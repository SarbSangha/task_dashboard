import React, { useEffect, useMemo, useState } from 'react';
import { authAPI, isRequestCanceled } from '../../../../../services/api';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { ACTIVE_PROJECT_STATUSES, useWorkspaceTaskDataset } from '../workspaceTabData';

function formatRelativeTime(value) {
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
}

export default function OverviewTab() {
  const { tasks, currentUser, loading, isRefreshing, error, cacheStatus } = useWorkspaceTaskDataset();
  const [teamMembers, setTeamMembers] = useState(0);

  useEffect(() => {
    let mounted = true;
    const controller = new AbortController();
    const loadTeamMembers = async () => {
      const myDept = currentUser?.department || '';
      if (!myDept) {
        if (mounted) setTeamMembers(0);
        return;
      }
      try {
        const deptRes = await authAPI.getUsersByDepartment(myDept, '', { signal: controller.signal }).catch((error) => {
          if (isRequestCanceled(error)) {
            return { __canceled: true };
          }
          return { users: [] };
        });
        if (deptRes?.__canceled || controller.signal.aborted) return;
        if (mounted) {
          setTeamMembers((deptRes?.users || []).length);
        }
      } catch (loadError) {
        if (isRequestCanceled(loadError) || controller.signal.aborted) return;
        console.error('Failed to load workspace team count:', loadError);
        if (mounted) setTeamMembers(0);
      }
    };

    void loadTeamMembers();
    return () => {
      mounted = false;
      controller.abort();
    };
  }, [currentUser?.department]);

  const stats = useMemo(() => {
    const activeTasks = tasks.filter((task) => ACTIVE_PROJECT_STATUSES.has((task.status || '').toLowerCase())).length;
    const completedTasks = tasks.filter((task) => (task.status || '').toLowerCase() === 'completed').length;
    const projectKeys = new Set(
      tasks
        .map((task) => (task.projectId || task.projectName || '').trim())
        .filter(Boolean)
    );

    return {
      activeTasks,
      completedTasks,
      projects: projectKeys.size,
      teamMembers,
    };
  }, [tasks, teamMembers]);

  const recentActivity = useMemo(() => {
    const terminalStatuses = new Set(['completed', 'cancelled', 'rejected']);
    return tasks
      .map((task) => {
        const status = (task.status || '').toLowerCase();
        const title = task.title || task.taskName || task.taskNumber || 'Task';
        const updatedAt = task.updatedAt || task.createdAt;
        if (status === 'completed') {
          return { icon: '✓', text: `Task completed: ${title}`, time: updatedAt };
        }
        if (terminalStatuses.has(status)) {
          return { icon: '⚑', text: `Task ${status.replace('_', ' ')}: ${title}`, time: updatedAt };
        }
        return { icon: '📝', text: `Task updated: ${title}`, time: updatedAt };
      })
      .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
      .slice(0, 8);
  }, [tasks]);

  return (
    <div className="tab-content tab-content-groups">
      <h3>Workspace Overview</h3>
      <CacheStatusBanner
        showingCached={cacheStatus.showingCached}
        isRefreshing={isRefreshing}
        cachedAt={cacheStatus.cachedAt}
        liveUpdatedAt={cacheStatus.liveUpdatedAt}
        refreshingLabel="Refreshing latest workspace data..."
        liveLabel="Workspace overview is up to date"
        cachedLabel="Showing cached workspace overview"
      />
      {error && <div className="team-member-card">{error}</div>}
      {loading ? (
        <WorkspaceSkeleton variant="overview" />
      ) : (
        <>
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
              {recentActivity.length === 0 ? (
                <div className="activity-item">
                  <span className="activity-icon">•</span>
                  <span className="activity-text">No recent activity available yet.</span>
                  <span className="activity-time">-</span>
                </div>
              ) : (
                recentActivity.map((item, idx) => (
                  <div className="activity-item" key={`${item.text}-${idx}`}>
                    <span className="activity-icon">{item.icon}</span>
                    <span className="activity-text">{item.text}</span>
                    <span className="activity-time">{formatRelativeTime(item.time)}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
