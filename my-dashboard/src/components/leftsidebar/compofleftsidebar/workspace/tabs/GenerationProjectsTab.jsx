import React, { useEffect, useMemo, useState } from 'react';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { generationProjectsAPI, generationRecordsAPI } from '../../../../../services/api';
import { formatProjectDate } from '../workspaceTabData';
import './GenerationProjectsTab.css';

const PAGE_SIZE = 24;
const UNGROUPED_KEY = 'ungrouped';

const EMPTY_PAGINATION = {
  limit: PAGE_SIZE,
  offset: 0,
  total: 0,
};

function normalizeApiError(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }
  if (error?.response?.status === 403) {
    return 'You do not have access to this generation project.';
  }
  if (error?.response?.status === 404) {
    return 'The requested generation project could not be found.';
  }
  if (error?.message) {
    return error.message;
  }
  return fallback;
}

function buildGenerationTitle(generation) {
  const prompt = `${generation?.promptText || ''}`.trim();
  if (prompt) {
    return prompt.length > 96 ? `${prompt.slice(0, 93)}...` : prompt;
  }
  return (
    generation?.providerTaskId
    || generation?.providerGenerationId
    || generation?.canonicalAssetKey
    || `Generation ${generation?.id || ''}`
  );
}

function buildGenerationSubtitle(generation) {
  const parts = [
    generation?.modelLabel,
    generation?.resolutionLabel,
    generation?.durationLabel,
    generation?.ingestionSource,
  ].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(' • ');
  }
  return 'Generation record';
}

function cloneViewState(state) {
  return {
    ...state,
    items: Array.isArray(state.items) ? [...state.items] : [],
    generations: Array.isArray(state.generations) ? [...state.generations] : [],
    pagination: { ...(state.pagination || EMPTY_PAGINATION) },
    project: state.project ? { ...state.project } : null,
  };
}

function PaginationControls({ pagination, label, onPageChange, loading = false }) {
  const total = Number(pagination?.total || 0);
  const limit = Number(pagination?.limit || PAGE_SIZE) || PAGE_SIZE;
  const offset = Number(pagination?.offset || 0) || 0;
  const start = total === 0 ? 0 : offset + 1;
  const end = total === 0 ? 0 : Math.min(offset + limit, total);
  const canPrev = offset > 0 && !loading;
  const canNext = offset + limit < total && !loading;

  return (
    <div className="generation-projects-pagination">
      <span>{label} {start}-{end} of {total}</span>
      <div className="generation-projects-pagination-actions">
        <button
          type="button"
          className="generation-projects-pagination-btn"
          onClick={() => onPageChange(Math.max(offset - limit, 0))}
          disabled={!canPrev}
        >
          Previous
        </button>
        <button
          type="button"
          className="generation-projects-pagination-btn"
          onClick={() => onPageChange(offset + limit)}
          disabled={!canNext}
        >
          Next
        </button>
      </div>
    </div>
  );
}

export default function GenerationProjectsTab() {
  const [projects, setProjects] = useState([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedKey, setSelectedKey] = useState(UNGROUPED_KEY);
  const [projectSearch, setProjectSearch] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [ungroupedOffset, setUngroupedOffset] = useState(0);
  const [projectOffset, setProjectOffset] = useState(0);
  const [ungroupedState, setUngroupedState] = useState({
    items: [],
    pagination: { ...EMPTY_PAGINATION },
    loading: true,
    error: '',
  });
  const [projectDetailState, setProjectDetailState] = useState({
    project: null,
    generations: [],
    pagination: { ...EMPTY_PAGINATION },
    loading: false,
    error: '',
  });
  const [actionGenerationId, setActionGenerationId] = useState(null);
  const [actionError, setActionError] = useState('');
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState('');
  const [toast, setToast] = useState(null);

  const selectedProjectId = selectedKey === UNGROUPED_KEY ? null : Number(selectedKey);
  const selectedProjectSummary = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) || null,
    [projects, selectedProjectId]
  );

  const filteredProjects = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return projects;
    return projects.filter((project) => (
      `${project.name || ''}`.toLowerCase().includes(query)
      || `${project.description || ''}`.toLowerCase().includes(query)
    ));
  }, [projects, projectSearch]);

  useEffect(() => {
    if (!toast?.message) return undefined;
    const timeoutId = window.setTimeout(() => {
      setToast(null);
    }, 3200);
    return () => window.clearTimeout(timeoutId);
  }, [toast]);

  const fetchProjects = async ({ silent = false } = {}) => {
    if (!silent) {
      setProjectsLoading(true);
    }
    setProjectsError('');
    try {
      const response = await generationProjectsAPI.listProjects();
      const nextProjects = Array.isArray(response?.data) ? response.data : [];
      setProjects(nextProjects);
      setSelectedKey((prev) => {
        if (prev === UNGROUPED_KEY) return prev;
        return nextProjects.some((project) => `${project.id}` === `${prev}`) ? prev : UNGROUPED_KEY;
      });
    } catch (error) {
      console.error('Failed to load generation projects:', error);
      setProjectsError(normalizeApiError(error, 'Could not load generation projects right now.'));
      if (!silent) {
        setProjects([]);
      }
    } finally {
      if (!silent) {
        setProjectsLoading(false);
      }
    }
  };

  const fetchUngrouped = async ({ offset = ungroupedOffset, silent = false } = {}) => {
    setUngroupedState((prev) => ({
      ...prev,
      loading: true,
      error: silent ? prev.error : '',
    }));
    try {
      const response = await generationRecordsAPI.getUngrouped({ limit: PAGE_SIZE, offset });
      setUngroupedState({
        items: Array.isArray(response?.data) ? response.data : [],
        pagination: {
          ...EMPTY_PAGINATION,
          ...(response?.pagination || {}),
        },
        loading: false,
        error: '',
      });
    } catch (error) {
      console.error('Failed to load ungrouped generations:', error);
      setUngroupedState((prev) => ({
        ...prev,
        loading: false,
        error: normalizeApiError(error, 'Could not load ungrouped generations right now.'),
      }));
    }
  };

  const fetchProjectDetail = async ({ projectId = selectedProjectId, offset = projectOffset, silent = false } = {}) => {
    if (!projectId) return;
    setProjectDetailState((prev) => ({
      ...prev,
      loading: true,
      error: silent ? prev.error : '',
    }));
    try {
      const [projectResponse, generationsResponse] = await Promise.all([
        generationProjectsAPI.getProject(projectId),
        generationProjectsAPI.getProjectGenerations(projectId, { limit: PAGE_SIZE, offset }),
      ]);
      setProjectDetailState({
        project: projectResponse?.data || generationsResponse?.project || null,
        generations: Array.isArray(generationsResponse?.data) ? generationsResponse.data : [],
        pagination: {
          ...EMPTY_PAGINATION,
          ...(generationsResponse?.pagination || {}),
        },
        loading: false,
        error: '',
      });
    } catch (error) {
      console.error('Failed to load generation project detail:', error);
      setProjectDetailState((prev) => ({
        ...prev,
        loading: false,
        error: normalizeApiError(error, 'Could not load this generation project right now.'),
      }));
    }
  };

  useEffect(() => {
    void fetchProjects();
  }, []);

  useEffect(() => {
    if (selectedKey === UNGROUPED_KEY) {
      void fetchUngrouped({ offset: ungroupedOffset });
      return;
    }
    void fetchProjectDetail({ projectId: selectedProjectId, offset: projectOffset });
  }, [selectedKey, selectedProjectId, ungroupedOffset, projectOffset]);

  const activeItems = selectedKey === UNGROUPED_KEY ? ungroupedState.items : projectDetailState.generations;
  const activePagination = selectedKey === UNGROUPED_KEY ? ungroupedState.pagination : projectDetailState.pagination;
  const activeLoading = selectedKey === UNGROUPED_KEY ? ungroupedState.loading : projectDetailState.loading;
  const activeError = selectedKey === UNGROUPED_KEY ? ungroupedState.error : projectDetailState.error;
  const activeProject = selectedKey === UNGROUPED_KEY ? null : (projectDetailState.project || selectedProjectSummary);

  const handleSelectSidebar = (nextKey) => {
    setActionError('');
    if (nextKey === UNGROUPED_KEY) {
      setSelectedKey(UNGROUPED_KEY);
      setUngroupedOffset(0);
      return;
    }
    setSelectedKey(`${nextKey}`);
    setProjectOffset(0);
  };

  const refreshCurrentView = async () => {
    setIsRefreshing(true);
    try {
      await fetchProjects({ silent: true });
      if (selectedKey === UNGROUPED_KEY) {
        await fetchUngrouped({ offset: ungroupedOffset, silent: true });
        return;
      }
      await fetchProjectDetail({ projectId: selectedProjectId, offset: projectOffset, silent: true });
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleCreateProject = async (event) => {
    event.preventDefault();
    const name = `${createForm.name || ''}`.trim();
    const description = `${createForm.description || ''}`.trim();
    if (!name) {
      setCreateError('Project name is required.');
      setToast({
        kind: 'error',
        message: 'Project name is required.',
      });
      return;
    }
    setCreateSubmitting(true);
    setCreateError('');
    try {
      const response = await generationProjectsAPI.createProject({
        name,
        description: description || null,
      });
      const createdProject = response?.data;
      if (createdProject) {
        setProjects((prev) => [createdProject, ...prev.filter((project) => project.id !== createdProject.id)]);
        setSelectedKey(`${createdProject.id}`);
        setProjectOffset(0);
      }
      setIsCreateOpen(false);
      setCreateForm({ name: '', description: '' });
      setProjectDetailState({
        project: createdProject || null,
        generations: [],
        pagination: { ...EMPTY_PAGINATION },
        loading: false,
        error: '',
      });
      setToast({
        kind: 'success',
        message: `Project "${createdProject?.name || name}" created.`,
      });
    } catch (error) {
      console.error('Failed to create generation project:', error);
      const message = normalizeApiError(error, 'Could not create the generation project right now.');
      setCreateError(message);
      setToast({
        kind: 'error',
        message,
      });
    } finally {
      setCreateSubmitting(false);
    }
  };

  const applyOptimisticMove = (generation, nextProjectId) => {
    const currentProjectId = generation.projectId ?? null;
    const normalizedNextProjectId = nextProjectId == null ? null : Number(nextProjectId);
    if (normalizedNextProjectId === currentProjectId) return;

    setProjects((prev) => prev.map((project) => {
      let generationCount = Number(project.generationCount || 0);
      if (project.id === currentProjectId) {
        generationCount = Math.max(generationCount - 1, 0);
      }
      if (project.id === normalizedNextProjectId) {
        generationCount += 1;
      }
      return {
        ...project,
        generationCount,
      };
    }));

    if (currentProjectId === null && normalizedNextProjectId !== null) {
      setUngroupedState((prev) => ({
        ...prev,
        items: prev.items.filter((item) => item.id !== generation.id),
        pagination: {
          ...prev.pagination,
          total: Math.max(Number(prev.pagination.total || 0) - 1, 0),
        },
      }));
    }

    if (currentProjectId !== null && normalizedNextProjectId === null) {
      setUngroupedState((prev) => ({
        ...prev,
        pagination: {
          ...prev.pagination,
          total: Number(prev.pagination.total || 0) + 1,
        },
      }));
    }

    if (selectedProjectId && currentProjectId === selectedProjectId && normalizedNextProjectId !== currentProjectId) {
      setProjectDetailState((prev) => ({
        ...prev,
        project: prev.project
          ? {
            ...prev.project,
            generationCount: Math.max(Number(prev.project.generationCount || 0) - 1, 0),
          }
          : prev.project,
        generations: prev.generations.filter((item) => item.id !== generation.id),
        pagination: {
          ...prev.pagination,
          total: Math.max(Number(prev.pagination.total || 0) - 1, 0),
        },
      }));
    }
  };

  const handleGenerationMove = async (generation, rawNextProjectId) => {
    const nextProjectId = rawNextProjectId === '' ? null : Number(rawNextProjectId);
    const currentProjectId = generation.projectId ?? null;
    if (nextProjectId === currentProjectId) {
      return;
    }

    setActionGenerationId(generation.id);
    setActionError('');
    const snapshot = {
      projects: projects.map((project) => ({ ...project })),
      ungroupedState: cloneViewState(ungroupedState),
      projectDetailState: cloneViewState(projectDetailState),
    };

    applyOptimisticMove(generation, nextProjectId);
    try {
      if (nextProjectId === null) {
        if (!currentProjectId) return;
        await generationProjectsAPI.removeGeneration(currentProjectId, generation.id);
      } else {
        await generationProjectsAPI.assignGeneration(nextProjectId, generation.id);
      }
      await refreshCurrentView();
      const destinationProject = projects.find((project) => project.id === nextProjectId);
      setToast({
        kind: 'success',
        message: nextProjectId === null
          ? 'Generation removed from project and returned to Ungrouped.'
          : currentProjectId == null
            ? `Generation moved into "${destinationProject?.name || 'project'}".`
            : `Generation reassigned to "${destinationProject?.name || 'project'}".`,
      });
    } catch (error) {
      console.error('Failed to move generation between projects:', error);
      setProjects(snapshot.projects);
      setUngroupedState(snapshot.ungroupedState);
      setProjectDetailState(snapshot.projectDetailState);
      const message = normalizeApiError(error, 'Could not update the generation project assignment.');
      setActionError(message);
      setToast({
        kind: 'error',
        message,
      });
    } finally {
      setActionGenerationId(null);
    }
  };

  const isInitialLoading = projectsLoading && projects.length === 0 && ungroupedState.loading;

  return (
    <div className="tab-content tab-content-projects generation-projects-tab">
      <div className="generation-projects-actions">
        <button
          className="generation-projects-toolbar-btn generation-projects-toolbar-btn-primary"
          type="button"
          onClick={() => setIsCreateOpen(true)}
          disabled={createSubmitting}
        >
          Create Project
        </button>
        <button
          className="generation-projects-toolbar-btn generation-projects-toolbar-btn-secondary"
          type="button"
          onClick={() => void refreshCurrentView()}
          disabled={isRefreshing}
        >
          {isRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      <div className="generation-projects-toolbar">
        <input
          className="generation-projects-search"
          type="text"
          placeholder="Search generation projects..."
          value={projectSearch}
          onChange={(event) => setProjectSearch(event.target.value)}
        />
        <div className="generation-projects-helper-text">
          Task Projects stay in the existing Projects tab. This workspace is only for generation organization.
        </div>
        {isRefreshing && (
          <div className="generation-projects-inline-status">
            Syncing the latest project assignments and ungrouped generations...
          </div>
        )}
      </div>

      {(projectsError || actionError) && (
        <div className="generation-projects-alert">
          {projectsError || actionError}
        </div>
      )}

      {isInitialLoading ? (
        <WorkspaceSkeleton variant="projects" />
      ) : (
        <div className="generation-projects-shell">
          <aside className="generation-projects-sidebar">
            <button
              type="button"
              className={`generation-projects-sidebar-card ${selectedKey === UNGROUPED_KEY ? 'selected' : ''}`}
              onClick={() => handleSelectSidebar(UNGROUPED_KEY)}
            >
              <div className="generation-projects-sidebar-head">
                <div>
                  <span className="generation-projects-badge">Ungrouped</span>
                  <h4>Ungrouped Generations <span className="generation-projects-inline-count">({ungroupedState.pagination.total || 0})</span></h4>
                </div>
                <span className="generation-projects-count">{ungroupedState.pagination.total || 0}</span>
              </div>
              <p>Any generation without a project appears here automatically. Move items out of this queue whenever you're ready.</p>
            </button>

            <div className="generation-projects-sidebar-list">
              {filteredProjects.length === 0 ? (
                <div className="generation-projects-empty-card">
                  <div className="generation-projects-empty-card-header">
                    <h4 className="generation-projects-empty-card-title">No generation projects yet</h4>
                  </div>
                  <p className="generation-projects-empty-card-description">
                    Create a generation project to start organizing your captured and recovered outputs.
                  </p>
                </div>
              ) : (
                filteredProjects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    className={`generation-projects-sidebar-card ${selectedProjectId === project.id ? 'selected' : ''}`}
                    onClick={() => handleSelectSidebar(project.id)}
                  >
                    <div className="generation-projects-sidebar-head">
                      <div>
                        <span className="generation-projects-badge">Generation Project</span>
                        <h4>{project.name} <span className="generation-projects-inline-count">({project.generationCount || 0})</span></h4>
                      </div>
                      <span className="generation-projects-count">{project.generationCount || 0}</span>
                    </div>
                    <p>{project.description || 'No description yet.'}</p>
                    <div className="generation-projects-sidebar-meta">
                      <span>Updated {formatProjectDate(project.updatedAt)}</span>
                    </div>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="generation-projects-panel">
            <div className="generation-projects-panel-header">
              <div>
                <div className="generation-projects-breadcrumb">
                  <span>Workspace</span>
                  <span>Generation Projects</span>
                  <span>{selectedKey === UNGROUPED_KEY ? 'Ungrouped' : (activeProject?.name || 'Project')}</span>
                </div>
                <div className="generation-projects-panel-badge">
                  {selectedKey === UNGROUPED_KEY ? 'Ungrouped View' : 'Generation Project'}
                </div>
                <h4>
                  {selectedKey === UNGROUPED_KEY ? 'Ungrouped Generations' : activeProject?.name || 'Generation Project'}
                  <span className="generation-projects-panel-count"> {activePagination.total || 0}</span>
                </h4>
                <p>
                  {selectedKey === UNGROUPED_KEY
                    ? 'Generations move here automatically when they do not belong to a project.'
                    : (activeProject?.description || 'Use this project to keep related generations together.')}
                </p>
              </div>

              <div className="generation-projects-panel-actions">
                <div className="generation-projects-view-toggle">
                  <button
                    type="button"
                    className={viewMode === 'grid' ? 'active' : ''}
                    onClick={() => setViewMode('grid')}
                  >
                    Grid
                  </button>
                  <button
                    type="button"
                    className={viewMode === 'list' ? 'active' : ''}
                    onClick={() => setViewMode('list')}
                  >
                    List
                  </button>
                </div>
                <input
                  className="generation-projects-search generation-projects-search-placeholder"
                  type="text"
                  placeholder="Search generations coming soon"
                  disabled
                />
                {activeLoading && activeItems.length > 0 && (
                  <div className="generation-projects-inline-status">
                    Refreshing this view...
                  </div>
                )}
              </div>
            </div>

            <div className="generation-projects-summary">
              <div className="generation-projects-stat-card">
                <div className="generation-projects-stat-info">
                  <div className="generation-projects-stat-value">{activePagination.total || 0}</div>
                  <div className="generation-projects-stat-label">Visible Generations</div>
                </div>
              </div>
              <div className="generation-projects-stat-card">
                <div className="generation-projects-stat-info">
                  <div className="generation-projects-stat-value">{selectedKey === UNGROUPED_KEY ? 'Live' : (activeProject?.generationCount || 0)}</div>
                  <div className="generation-projects-stat-label">{selectedKey === UNGROUPED_KEY ? 'Queue' : 'Project Count'}</div>
                </div>
              </div>
              <div className="generation-projects-stat-card">
                <div className="generation-projects-stat-info">
                  <div className="generation-projects-stat-value">{selectedKey === UNGROUPED_KEY ? 'Auto' : 'Fresh'}</div>
                  <div className="generation-projects-stat-label">
                    {selectedKey === UNGROUPED_KEY
                      ? 'No project required'
                      : `Updated ${formatProjectDate(activeProject?.updatedAt)}`}
                  </div>
                </div>
              </div>
            </div>

            {activeLoading && activeItems.length === 0 ? (
              <WorkspaceSkeleton variant="projects" />
            ) : activeError ? (
              <div className="generation-projects-folder-empty">{activeError}</div>
            ) : activeItems.length === 0 ? (
              <div className="generation-projects-empty-state">
                <strong>{selectedKey === UNGROUPED_KEY ? 'No ungrouped generations right now' : 'No generations in this project yet'}</strong>
                <span>
                  {selectedKey === UNGROUPED_KEY
                    ? 'Recovered and captured generations will land here until you move them into a project.'
                    : 'Move generations into this project from Ungrouped or another generation project.'}
                </span>
              </div>
            ) : (
              <>
                <div className={`generation-projects-generation-list ${viewMode}`}>
                  {activeItems.map((generation) => (
                    <article
                      key={generation.id}
                      className={`generation-project-card ${actionGenerationId === generation.id ? 'pending' : ''}`}
                    >
                      <div className="generation-project-card-top">
                        <div>
                          <span
                            className={`generation-project-status ${
                              (generation.ownershipStatus || '').toLowerCase() === 'unknown'
                                ? 'active'
                                : 'completed'
                            }`}
                          >
                            {(generation.ownershipStatus || 'unknown').replaceAll('_', ' ')}
                          </span>
                          <h5>{buildGenerationTitle(generation)}</h5>
                        </div>
                        <span className="generation-project-date">{formatProjectDate(generation.createdAt)}</span>
                      </div>

                      <p className="generation-project-subtitle">{buildGenerationSubtitle(generation)}</p>

                      <div className="generation-project-identifiers">
                        {generation.providerTaskId && <span>Task {generation.providerTaskId}</span>}
                        {generation.providerGenerationId && <span>Generation {generation.providerGenerationId}</span>}
                        {generation.canonicalAssetKey && <span>Asset linked</span>}
                      </div>

                      <div className="generation-project-card-actions">
                        <select
                          className="generation-project-select"
                          value={generation.projectId ?? ''}
                          disabled={actionGenerationId === generation.id}
                          onChange={(event) => void handleGenerationMove(generation, event.target.value)}
                        >
                          <option value="">Ungrouped</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="generation-project-action-btn"
                          disabled={actionGenerationId === generation.id || generation.projectId == null}
                          onClick={() => void handleGenerationMove(generation, '')}
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))}
                </div>

                <PaginationControls
                  pagination={activePagination}
                  label={selectedKey === UNGROUPED_KEY ? 'Ungrouped' : 'Project'}
                  loading={activeLoading}
                  onPageChange={(nextOffset) => {
                    if (selectedKey === UNGROUPED_KEY) {
                      setUngroupedOffset(nextOffset);
                      return;
                    }
                    setProjectOffset(nextOffset);
                  }}
                />
              </>
            )}
          </section>
        </div>
      )}

      {toast?.message && (
        <div className={`generation-projects-toast ${toast.kind === 'error' ? 'error' : 'success'}`}>
          {toast.kind === 'error' ? '✕' : '✓'} {toast.message}
        </div>
      )}

      {isCreateOpen && (
        <div className="generation-projects-modal-backdrop" onClick={() => !createSubmitting && setIsCreateOpen(false)}>
          <div className="generation-projects-modal" onClick={(event) => event.stopPropagation()}>
            <div className="generation-projects-modal-head">
              <div>
                <span className="generation-projects-badge">Generation Project</span>
                <h4>Create a new project</h4>
              </div>
              <button
                type="button"
                className="generation-projects-modal-close"
                onClick={() => !createSubmitting && setIsCreateOpen(false)}
              >
                ✕
              </button>
            </div>

            <form className="generation-projects-modal-form" onSubmit={handleCreateProject}>
              <label>
                <span>Project name</span>
                <input
                  type="text"
                  value={createForm.name}
                  maxLength={200}
                  placeholder="Summer Campaign"
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                />
              </label>

              <label>
                <span>Description</span>
                <textarea
                  value={createForm.description}
                  maxLength={5000}
                  placeholder="Optional notes for this generation project"
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))}
                />
              </label>

              {createError && <div className="generation-projects-alert">{createError}</div>}

              <div className="generation-projects-modal-actions">
                <button
                  type="button"
                  className="generation-projects-toolbar-btn generation-projects-toolbar-btn-secondary"
                  disabled={createSubmitting}
                  onClick={() => setIsCreateOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="generation-projects-toolbar-btn generation-projects-toolbar-btn-primary"
                  disabled={createSubmitting}
                >
                  {createSubmitting ? 'Creating...' : 'Create Project'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
