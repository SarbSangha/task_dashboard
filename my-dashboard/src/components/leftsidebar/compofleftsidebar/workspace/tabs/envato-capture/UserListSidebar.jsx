import { useCallback, useEffect, useRef, useState } from 'react';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { envatoCaptureAPI } from '../../../../../../services/api';
import { formatCount, formatCredits, formatRelativeTime, normalizeApiError } from './envatoCaptureUtils';

const USER_PAGE_SIZE = 30;

function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

function UserCard({ user, isSelected, onSelect }) {
  return (
    <button
      type="button"
      className={`chatgpt-capture-user-card${isSelected ? ' selected' : ''}`}
      aria-current={isSelected ? 'true' : undefined}
      onClick={() => onSelect(user.userId, user.name)}
    >
      <div className="chatgpt-capture-user-card-avatar" aria-hidden="true">
        <span>{initialsFor(user.name)}</span>
      </div>
      <div className="chatgpt-capture-user-card-body">
        <div className="chatgpt-capture-user-card-top">
          <span className="chatgpt-capture-user-card-name">{user.name || `User #${user.userId}`}</span>
        </div>
        {user.email && <span className="chatgpt-capture-user-card-email">{user.email}</span>}
        <div className="chatgpt-capture-user-card-meta">
          {user.department && <span className="chatgpt-capture-chip">{user.department}</span>}
          <span>{formatCount(user.generationCount)} generations</span>
          <span>💳 {formatCredits(user.creditsChargedTotal)}</span>
          <span className="chatgpt-capture-conv-card-time">{formatRelativeTime(user.lastGenerationAt)}</span>
        </div>
      </div>
    </button>
  );
}

export default function UserListSidebar({ selectedUserId, onSelectUser }) {
  const [searchInput, setSearchInput] = useState('');
  const [users, setUsers] = useState([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoadingMore, setUsersLoadingMore] = useState(false);
  const [usersError, setUsersError] = useState('');
  const requestTokenRef = useRef(0);

  const loadUsers = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setUsersLoadingMore(true);
      else setUsersLoading(true);
      setUsersError('');
      try {
        const response = await envatoCaptureAPI.listUsers({
          q: searchInput.trim() || undefined,
          limit: USER_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setUsers((prev) => (append ? [...prev, ...response.data] : response.data));
        setUsersTotal(response.pagination?.total || 0);
      } catch (error) {
        if (token !== requestTokenRef.current) return;
        setUsersError(normalizeApiError(error, 'Unable to load employees.'));
      } finally {
        if (token === requestTokenRef.current) {
          setUsersLoading(false);
          setUsersLoadingMore(false);
        }
      }
    },
    [searchInput]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => loadUsers(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  const handleLoadMore = useCallback(() => {
    if (usersLoadingMore || users.length >= usersTotal) return;
    loadUsers(users.length, { append: true });
  }, [users.length, usersLoadingMore, usersTotal, loadUsers]);

  return (
    <div className="chatgpt-capture-sidebar-panel">
      <div className="chatgpt-capture-filter-bar">
        <input
          type="search"
          className="chatgpt-capture-search-input"
          aria-label="Search employees by name, email, or department"
          placeholder="Search employees..."
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
      </div>

      {usersError && <div className="chatgpt-capture-alert">{usersError}</div>}

      {!usersLoading && !usersError && users.length === 0 && (
        <div className="chatgpt-capture-empty-state compact">
          <strong>No attributed generations yet</strong>
          <p>Once an employee generates something in Envato through the dashboard launcher, they'll show up here.</p>
        </div>
      )}

      {usersLoading && users.length === 0 && (
        <div aria-hidden="true">
          {Array.from({ length: 5 }).map((_, index) => (
            <div key={index} className="chatgpt-capture-user-card-wrap">
              <div className="chatgpt-capture-user-card loading">
                <SkeletonBlock width={40} height={40} rounded />
                <div style={{ flex: 1 }}>
                  <SkeletonBlock width="50%" height={13} />
                  <SkeletonBlock width="70%" height={11} style={{ marginTop: 6 }} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {users.length > 0 && (
        <div className="chatgpt-capture-conv-list">
          {users.map((user) => (
            <div key={user.userId} className="chatgpt-capture-user-card-wrap">
              <UserCard user={user} isSelected={user.userId === selectedUserId} onSelect={onSelectUser} />
            </div>
          ))}
          {users.length < usersTotal && (
            <button
              type="button"
              className="chatgpt-capture-secondary-btn"
              style={{ width: '100%', marginTop: 8 }}
              onClick={handleLoadMore}
              disabled={usersLoadingMore}
            >
              {usersLoadingMore ? 'Loading…' : `Load more (${usersTotal - users.length} remaining)`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
