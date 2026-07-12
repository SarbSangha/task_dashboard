import React, { useCallback, useEffect, useState } from 'react';
import { generationRecordsAPI } from '../../../../../services/api';
import { UserAvatar } from '../../../../common/UserAvatar';
import { formatGenerationDate } from './klingMedia';

const PAGE_SIZE = 24;

export default function KlingUserExplorer({ onSelectUser }) {
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [users, setUsers] = useState([]);
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
        const response = await generationRecordsAPI.getUsers({
          q: search || undefined,
          limit: PAGE_SIZE,
          offset,
        });
        if (cancelled) return;
        setUsers(Array.isArray(response?.data) ? response.data : []);
        setTotal(Number.isFinite(response?.pagination?.total) ? response.pagination.total : 0);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load Kling user directory:', fetchError);
          setError('Could not load users right now.');
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
          placeholder="Search users by name or department..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </div>

      {error && <div className="kling-state kling-state-error">{error}</div>}
      {!error && loading && <div className="kling-state">Loading users...</div>}
      {!error && !loading && users.length === 0 && <div className="kling-state">No users with generations found.</div>}

      {!error && !loading && users.length > 0 && (
        <>
          <div className="kling-projects-grid">
            {users.map((user) => (
              <button type="button" key={user.userId} className="kling-project-card" onClick={() => onSelectUser(user)}>
                <div className="kling-user-card-header">
                  <UserAvatar avatar={user.avatar} name={user.name || 'Unknown user'} size={48} />
                  <div className="kling-user-card-heading">
                    <h4 className="kling-project-card-title">{user.name || 'Unknown user'}</h4>
                    <span className="kling-user-card-department">{user.department || 'No department'}</span>
                  </div>
                </div>
                <div className="kling-project-card-body">
                  <div className="kling-user-card-stats">
                    <div>
                      <span>{user.totalGenerations}</span>
                      <label>Total</label>
                    </div>
                    <div>
                      <span>{user.imageCount}</span>
                      <label>Images</label>
                    </div>
                    <div>
                      <span>{user.videoCount}</span>
                      <label>Videos</label>
                    </div>
                  </div>
                  <div className="kling-project-card-stats">
                    <span>{Math.round(user.creditsBurned || 0)} credits</span>
                    <span>Active {formatGenerationDate(user.lastActivityAt)}</span>
                  </div>
                  {user.topModel && <p className="kling-project-card-description">Most used: {user.topModel}</p>}
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
