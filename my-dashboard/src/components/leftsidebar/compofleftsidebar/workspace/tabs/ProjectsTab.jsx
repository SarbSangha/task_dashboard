import { useEffect, useMemo, useState } from 'react';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  buildProjectSummaries,
  formatProjectDate,
  useWorkspaceTaskDataset,
} from '../workspaceTabData';
import './ProjectsTab.css';

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
    <div className="tab-content tab-content-projects workspace-projects">
      <div className="projects-status-row">
        <label className="projects-search-field">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            className="projects-search"
            type="search"
            placeholder="Search project folders"
            aria-label="Search project folders"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="add-btn projects-refresh-btn"
          onClick={() => void refresh()}
          disabled={isRefreshing}
          title="Refresh project folders"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8" /><path d="M4 4v4h4" /><path d="M4 13a8 8 0 0 0 14.3 4.9L20 16" /><path d="M20 20v-4h-4" />
          </svg>
          Refresh
        </button>

        <CacheStatusBanner
          showingCached={cacheStatus.showingCached}
          isRefreshing={isRefreshing}
          cachedAt={cacheStatus.cachedAt}
          liveUpdatedAt={cacheStatus.liveUpdatedAt}
          refreshingLabel="Refreshing latest workspace data..."
          liveLabel="Project folders are up to date"
          cachedLabel="Showing cached project folders"
          className="cache-status-banner--header"
        />
      </div>

      <div className="projects-toolbar">
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
                  <svg className="project-folder-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden="true">
                    <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.6l2 2h7.4a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />
                  </svg>
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
