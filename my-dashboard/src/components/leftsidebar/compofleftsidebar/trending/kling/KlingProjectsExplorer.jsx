import React, { useCallback, useEffect, useState } from 'react';
import { generationProjectsAPI } from '../../../../../services/api';
import { UserAvatar } from '../../../../common/UserAvatar';
import { formatGenerationDate } from './klingMedia';

const PAGE_SIZE = 24;

export default function KlingProjectsExplorer({ onSelectProject }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  useEffect(() => {
    setOffset(0);
  }, [search]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await generationProjectsAPI.listDirectory({
          q: search || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (cancelled) return;
        setProjects(Array.isArray(response?.data) ? response.data : []);
        setTotal(Number.isFinite(response?.pagination?.total) ? response.pagination.total : 0);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load Kling projects:', fetchError);
          setError('Could not load projects right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [search, offset]);

  const handlePrevious = useCallback(() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE)), []);
  const handleNext = useCallback(() => setOffset((prev) => prev + PAGE_SIZE), []);

  return (
    <div className="kling-projects-explorer">
      <div className="kling-projects-toolbar">
        <input
          className="trendings-search kling-search"
          placeholder="Search projects..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </div>

      {error && <div className="kling-state kling-state-error">{error}</div>}
      {!error && loading && <div className="kling-state">Loading projects...</div>}
      {!error && !loading && projects.length === 0 && <div className="kling-state">No projects found.</div>}

      {!error && !loading && projects.length > 0 && (
        <>
          <div className="kling-projects-grid">
            {projects.map((project) => (
              <button type="button" key={project.id} className="kling-project-card" onClick={() => onSelectProject(project)}>
                <div className="kling-project-card-cover">{project.name ? project.name.slice(0, 1).toUpperCase() : '#'}</div>
                <div className="kling-project-card-body">
                  <h4 className="kling-project-card-title">{project.name}</h4>
                  {project.description && <p className="kling-project-card-description">{project.description}</p>}
                  <div className="kling-project-card-owner">
                    <UserAvatar avatar={project.ownerAvatar} name={project.ownerName || 'Unknown owner'} size={20} />
                    <span>{project.ownerName || 'Unknown owner'}</span>
                  </div>
                  <div className="kling-project-card-stats">
                    <span>{project.generationCount} generations</span>
                    <span>Updated {formatGenerationDate(project.updatedAt)}</span>
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="kling-projects-pagination">
            <button type="button" onClick={handlePrevious} disabled={offset === 0}>
              Previous
            </button>
            <span>
              {total === 0 ? 0 : offset + 1}-{Math.min(offset + PAGE_SIZE, total)} of {total}
            </span>
            <button type="button" onClick={handleNext} disabled={offset + PAGE_SIZE >= total}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}
