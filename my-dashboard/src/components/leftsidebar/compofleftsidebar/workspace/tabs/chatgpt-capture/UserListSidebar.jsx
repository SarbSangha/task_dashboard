import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { useElementSize } from '../../../../../../hooks/useElementSize';
import { useDebouncedValue } from './useDebouncedValue';
import { formatCount, formatRelativeTime, getHealthStatusMeta, normalizeApiError } from './chatgptCaptureUtils';

const USER_PAGE_SIZE = 20;
const USER_CARD_HEIGHT = 140;
const SORT_OPTIONS = [
  { key: 'recent', label: 'Last active' },
  { key: 'conversations', label: 'Most conversations' },
  { key: 'messages', label: 'Most messages' },
  { key: 'name', label: 'Name A-Z' },
];
const HEALTH_OPTIONS = [
  { key: '', label: 'All capture health' },
  { key: 'healthy', label: 'Healthy' },
  { key: 'degraded', label: 'Degraded' },
];

function initialsFor(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || '?';
}

function UserCard({ ariaAttributes, index, style, users, selectedUserId, onSelect }) {
  const user = users[index];

  if (!user) {
    return (
      <div {...ariaAttributes} style={style} className="chatgpt-capture-user-card-wrap">
        <div className="chatgpt-capture-user-card loading" aria-hidden="true">
          <SkeletonBlock width={40} height={40} rounded />
          <div style={{ flex: 1 }}>
            <SkeletonBlock width="50%" height={13} />
            <SkeletonBlock width="70%" height={11} style={{ marginTop: 6 }} />
          </div>
        </div>
      </div>
    );
  }

  const isSelected = user.userId === selectedUserId;
  const healthMeta = getHealthStatusMeta(user.captureHealth);

  return (
    <div {...ariaAttributes} style={style} className="chatgpt-capture-user-card-wrap">
      <button
        type="button"
        className={`chatgpt-capture-user-card${isSelected ? ' selected' : ''}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelect(user.userId, user.name)}
      >
        <div className="chatgpt-capture-user-card-avatar" aria-hidden="true">
          {user.avatar ? (
            <img src={user.avatar} alt="" />
          ) : (
            <span>{initialsFor(user.name)}</span>
          )}
        </div>
        <div className="chatgpt-capture-user-card-body">
          <div className="chatgpt-capture-user-card-top">
            <span className="chatgpt-capture-user-card-name">{user.name}</span>
            <span className={`chatgpt-capture-health-dot tone-${healthMeta.tone}`} title={healthMeta.label} aria-hidden="true" />
          </div>
          {user.email && <span className="chatgpt-capture-user-card-email">{user.email}</span>}
          <div className="chatgpt-capture-user-card-meta">
            {user.department && <span className="chatgpt-capture-chip">{user.department}</span>}
            <span>{formatCount(user.conversationsCount)} convos</span>
            <span>{formatCount(user.messagesCount)} msgs</span>
            {user.imagesCount > 0 && <span>🖼️ {user.imagesCount}</span>}
            {user.filesCount > 0 && <span>📄 {user.filesCount}</span>}
            <span className="chatgpt-capture-conv-card-time">{formatRelativeTime(user.lastActiveAt)}</span>
          </div>
        </div>
      </button>
    </div>
  );
}

export default function UserListSidebar({ selectedUserId, onSelectUser }) {
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [healthFilter, setHealthFilter] = useState('');
  const [sortKey, setSortKey] = useState('recent');

  const [users, setUsers] = useState([]);
  const [usersTotal, setUsersTotal] = useState(0);
  const [usersLoading, setUsersLoading] = useState(false);
  const [usersLoadingMore, setUsersLoadingMore] = useState(false);
  const [usersError, setUsersError] = useState('');

  const searchInputRef = useRef(null);
  const requestTokenRef = useRef(0);

  const baseFilters = useMemo(
    () => ({
      q: debouncedSearch.trim() || undefined,
      health: healthFilter || undefined,
      sort: sortKey,
    }),
    [debouncedSearch, healthFilter, sortKey]
  );

  const loadUsers = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setUsersLoadingMore(true);
      else setUsersLoading(true);
      setUsersError('');
      try {
        const response = await chatgptCaptureAPI.listUsers({ ...baseFilters, limit: USER_PAGE_SIZE, offset });
        if (token !== requestTokenRef.current) return;
        setUsers((prev) => (append ? [...prev, ...response.data] : response.data));
        setUsersTotal(response.pagination?.total || 0);
      } catch (error) {
        if (token !== requestTokenRef.current) return;
        setUsersError(normalizeApiError(error, 'Unable to load users.'));
      } finally {
        if (token === requestTokenRef.current) {
          setUsersLoading(false);
          setUsersLoadingMore(false);
        }
      }
    },
    [baseFilters]
  );

  useEffect(() => {
    loadUsers(0, { append: false });
  }, [loadUsers]);

  const handleLoadMoreUsers = useCallback(() => {
    if (usersLoadingMore || users.length >= usersTotal) return;
    loadUsers(users.length, { append: true });
  }, [users.length, usersLoadingMore, usersTotal, loadUsers]);

  // Keyboard shortcut: "/" focuses search, matching the conversation list's
  // own shortcut so the two modes feel like one consistent surface.
  useEffect(() => {
    const handleKeyDown = (event) => {
      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearchInput('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const [listWrapRef, listSize] = useElementSize();

  const rowProps = useMemo(
    () => ({ users, selectedUserId, onSelect: onSelectUser }),
    [users, selectedUserId, onSelectUser]
  );

  const rowCount = users.length < usersTotal ? users.length + 1 : users.length;

  const handleRowsRendered = useCallback(
    ({ stopIndex }) => {
      if (stopIndex >= rowCount - 2) handleLoadMoreUsers();
    },
    [handleLoadMoreUsers, rowCount]
  );

  return (
    <div className="chatgpt-capture-sidebar-panel">
      <div className="chatgpt-capture-filter-bar">
        <input
          ref={searchInputRef}
          type="search"
          className="chatgpt-capture-search-input"
          aria-label="Search users by name, email, or department"
          placeholder="Search users... (press / to focus)"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <div className="chatgpt-capture-filter-row">
          <select
            className="chatgpt-capture-select"
            aria-label="Filter by capture health"
            value={healthFilter}
            onChange={(event) => setHealthFilter(event.target.value)}
          >
            {HEALTH_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
          <select
            className="chatgpt-capture-select"
            aria-label="Sort users"
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>

      {usersError && <div className="chatgpt-capture-alert">{usersError}</div>}

      {!usersLoading && !usersError && users.length === 0 && (
        <div className="chatgpt-capture-empty-state compact">
          <strong>No users found</strong>
          <p>Try widening your filters, or wait for staff to capture ChatGPT conversations with the extension active.</p>
        </div>
      )}

      {(users.length > 0 || usersLoading) && (
        <div className="chatgpt-capture-conv-list" ref={listWrapRef}>
          {listSize.width > 0 && listSize.height > 0 && (
            <List
              className="chatgpt-capture-virtual-list"
              rowComponent={UserCard}
              rowProps={rowProps}
              rowCount={Math.max(rowCount, usersLoading ? 6 : 0)}
              rowHeight={USER_CARD_HEIGHT}
              onRowsRendered={handleRowsRendered}
              overscanCount={4}
              style={{ height: listSize.height, width: listSize.width }}
            />
          )}
        </div>
      )}
    </div>
  );
}
