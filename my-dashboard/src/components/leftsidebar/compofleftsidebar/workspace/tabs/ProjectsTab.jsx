import React, { useEffect, useMemo, useState } from 'react';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  buildProjectSummaries,
  formatProjectDate,
  useWorkspaceTaskDataset,
} from '../workspaceTabData';

export default function ProjectsTab() {
  const { tasks, loading, isRefreshing, error, refresh, cacheStatus } = useWorkspaceTaskDataset();
  const [selectedProjectKey, setSelectedProjectKey] = useState('');
  const [search, setSearch] = useState('');
  const projects = useMemo(() => buildProjectSummaries(tasks), [tasks]);

  useEffect(() => {
    setSelectedProjectKey((prev) => {
      if (prev && projects.some((project) => project.key === prev)) {
        return prev;
      }
      return projects[0]?.key || '';
    });
  }, [projects]);

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
    return (
      filteredProjects.find((project) => project.key === selectedProjectKey) ||
      projects.find((project) => project.key === selectedProjectKey) ||
      null
    );
  }, [filteredProjects, projects, selectedProjectKey]);

  return (
    <div className="tab-content tab-content-projects">
      <div className="content-header">
        <h3>Projects</h3>
        <button className="add-btn" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>

      <CacheStatusBanner
        showingCached={cacheStatus.showingCached}
        isRefreshing={isRefreshing}
        cachedAt={cacheStatus.cachedAt}
        liveUpdatedAt={cacheStatus.liveUpdatedAt}
        refreshingLabel="Refreshing latest workspace data..."
        liveLabel="Project folders are up to date"
        cachedLabel="Showing cached project folders"
      />

      <div className="projects-toolbar">
        <input
          className="projects-search"
          type="text"
          placeholder="Search project folder..."
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <div className="projects-helper-text">
          Create tasks with the same project name to keep them inside one project folder.
        </div>
      </div>

      {error && <div className="team-member-card">{error}</div>}

      {loading ? (
        <WorkspaceSkeleton variant="projects" />
      ) : (
        <div className="projects-live-layout">
          <div className="projects-grid">
            {filteredProjects.length === 0 && (
              <div className="project-card">
                <div className="project-header">
                  <h4>No project folders yet</h4>
                </div>
                <p className="project-description">
                  Create a task with a project name and it will show up here automatically.
                </p>
              </div>
            )}

            {filteredProjects.map((project) => (
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
                    <div className="progress-fill" style={{ width: `${project.progress}%` }} />
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
      )}
    </div>
  );
}
