import React, { useEffect, useMemo, useState } from 'react';
import { authAPI, subscribeRealtimeNotifications } from '../../../../services/api';
import { useCustomDialogs } from '../../../common/CustomDialogs';
import { useAuth } from '../../../../context/AuthContext';
import CacheStatusBanner from '../../../common/CacheStatusBanner';
import {
  buildTaskPanelCacheKey,
  getTaskPanelCacheEntry,
  invalidateTaskPanelCache,
  setTaskPanelCache,
} from '../../../../utils/taskPanelCache';
import { useMinimizedWindowStack } from '../../../../hooks/useMinimizedWindowStack';
import './AdminRequestPanel.css';

const ADMIN_QUEUE_CACHE_TTL_MS = 90 * 1000;

const AdminRequestPanel = ({ isOpen, onClose, onMinimizedChange, onActivate }) => {
  const { user } = useAuth();
  const { showConfirm, showPrompt } = useCustomDialogs();
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cacheStatus, setCacheStatus] = useState({
    showingCached: false,
    cachedAt: 0,
    liveUpdatedAt: 0,
  });
  const [requests, setRequests] = useState([]);
  const [users, setUsers] = useState([]);
  const [activeType, setActiveType] = useState('all');
  const [message, setMessage] = useState('');
  const [menuUserId, setMenuUserId] = useState(null);
  const [infoUser, setInfoUser] = useState(null);
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const minimizedWindowStyle = useMinimizedWindowStack('admin-queue-panel', isOpen && isMinimized);
  const refreshTimerRef = React.useRef(null);
  const cacheKey = useMemo(
    () => (user?.id ? buildTaskPanelCacheKey(user.id, 'admin_queue') : null),
    [user?.id]
  );

  useEffect(() => {
    onMinimizedChange?.(isOpen && isMinimized);
  }, [isMinimized, isOpen, onMinimizedChange]);

  const formatDateTime = (value) => {
    if (!value) return 'N/A';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return value;
    return d.toLocaleString();
  };

  const loadData = async ({ silent = false } = {}) => {
    if (!cacheKey) return;
    if (silent) setIsRefreshing(true);
    else setLoading(true);
    try {
      const [reqRes, usersRes] = await Promise.all([
        authAPI.getAdminPendingRequests(),
        authAPI.getAdminAllUsers(),
      ]);
      const nextRequests = reqRes?.requests || [];
      const nextUsers = usersRes?.users || [];
      setRequests(nextRequests);
      setUsers(nextUsers);
      setTaskPanelCache(cacheKey, {
        requests: nextRequests,
        users: nextUsers,
      });
      setCacheStatus((prev) => ({
        showingCached: false,
        cachedAt: prev.cachedAt,
        liveUpdatedAt: Date.now(),
      }));
      setMessage('');
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to load admin data');
    } finally {
      if (silent) setIsRefreshing(false);
      else setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen || !cacheKey) return;
    setIsMinimized(false);
    setIsMaximized(false);
    const cachedEntry = getTaskPanelCacheEntry(cacheKey, ADMIN_QUEUE_CACHE_TTL_MS);
    const cached = cachedEntry?.value || null;
    const hasCachedData = Array.isArray(cached?.requests) || Array.isArray(cached?.users);
    if (Array.isArray(cached?.requests)) {
      setRequests(cached.requests);
    }
    if (Array.isArray(cached?.users)) {
      setUsers(cached.users);
    }
    if (hasCachedData) {
      setCacheStatus({
        showingCached: true,
        cachedAt: cachedEntry?.cachedAt || 0,
        liveUpdatedAt: 0,
      });
    }
    void loadData({ silent: hasCachedData });
  }, [cacheKey, isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;

    const scheduleRefresh = () => {
      if (refreshTimerRef.current) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        loadData({ silent: true });
      }, 250);
    };

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        const eventType = payload?.eventType || '';
        if (!eventType.startsWith('admin_')) return;
        scheduleRefresh();
      },
      onOpen: () => {
        scheduleRefresh();
      },
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadData({ silent: true });
    }, 180000);

    const onFocus = () => scheduleRefresh();
    window.addEventListener('focus', onFocus);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
      window.removeEventListener('focus', onFocus);
      if (refreshTimerRef.current) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [cacheKey, isOpen]);

  if (!isOpen) return null;

  const handleToggleMinimize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }
    setIsMaximized(false);
    setIsMinimized(true);
  };

  const handleToggleMaximize = () => {
    if (isMinimized) {
      onActivate?.();
      setIsMinimized(false);
      return;
    }
    setIsMaximized((prev) => !prev);
  };

  const filteredRequests = requests.filter((req) => {
    if (activeType === 'deleted') return false;
    return activeType === 'all' || req.requestType === activeType;
  });
  const filteredUsers = users.filter((u) => {
    if (activeType === 'deleted') return !!u.isDeleted;
    return !u.isDeleted;
  });

  const handleReview = async (requestId, approve) => {
    const notes = (await showPrompt(
      approve ? 'Approval note (optional):' : 'Reason for rejection (required):',
      {
        title: approve ? 'Approve Request' : 'Reject Request',
        defaultValue: '',
      }
    )) ?? '';
    if (!approve && !notes.trim()) {
      setMessage('Rejection reason is required.');
      return;
    }
    try {
      await authAPI.reviewAdminRequest(requestId, approve, notes);
      if (cacheKey) {
        invalidateTaskPanelCache(cacheKey);
      }
      await loadData({ silent: true });
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to review request');
    }
  };

  const handleDeactivate = async (userId, isActive) => {
    try {
      if (isActive) {
        const reason = (await showPrompt('Reason to remove login access:', {
          title: 'Remove Login Access',
          defaultValue: '',
        })) ?? '';
        await authAPI.deactivateUserAccess(userId, reason);
      } else {
        await authAPI.activateUserAccess(userId);
      }
      if (cacheKey) {
        invalidateTaskPanelCache(cacheKey);
      }
      await loadData({ silent: true });
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to update user access');
    }
  };

  const handleDeleteAccount = async (user) => {
    const confirmDelete = await showConfirm(
      `Delete account permanently for ${user.name} (${user.email})?\nThis cannot be used for login again.`,
      { title: 'Delete Account' }
    );
    if (!confirmDelete) return;

    const reason = (await showPrompt('Reason for permanent account deletion (optional):', {
      title: 'Delete Reason',
      defaultValue: '',
    })) ?? '';
    try {
      await authAPI.deleteUserAccount(user.id, reason);
      setMenuUserId(null);
      setMessage(`Account deleted: ${user.name}`);
      if (cacheKey) {
        invalidateTaskPanelCache(cacheKey);
      }
      await loadData({ silent: true });
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to delete account');
    }
  };

  return (
    <>
      <div
        className={`admin-queue-overlay ${isMinimized ? 'disabled' : ''}`}
        onClick={!isMinimized ? () => { setMenuUserId(null); onClose(); } : undefined}
      />
      <div
        className={`admin-queue-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
      >
        <div
          className="admin-queue-header"
          onClick={isMinimized ? () => { onActivate?.(); setIsMinimized(false); } : undefined}
        >
          <h3>Admin Queue</h3>
          <div className="admin-queue-controls">
            {!isMinimized && (
              <button
                className="admin-queue-window-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleMinimize();
                }}
                title="Minimize"
              >
                ─
              </button>
            )}
            <button
              className="admin-queue-window-btn"
              onClick={(event) => {
                event.stopPropagation();
                handleToggleMaximize();
              }}
              title={isMinimized ? 'Restore' : isMaximized ? 'Restore Window' : 'Maximize'}
            >
              {isMinimized ? '▢' : isMaximized ? '❐' : '□'}
            </button>
            <button
              className="admin-queue-close-btn"
              onClick={(event) => {
                event.stopPropagation();
                onClose();
              }}
            >
              ✕
            </button>
          </div>
        </div>

        {!isMinimized && (
        <div className="admin-queue-tabs">
          <button className={activeType === 'all' ? 'active' : ''} onClick={() => setActiveType('all')}>All</button>
          <button className={activeType === 'signup' ? 'active' : ''} onClick={() => setActiveType('signup')}>Login Requests</button>
          <button className={activeType === 'profile_update' ? 'active' : ''} onClick={() => setActiveType('profile_update')}>Profile Requests</button>
          <button className={activeType === 'password_change' ? 'active' : ''} onClick={() => setActiveType('password_change')}>Password Requests</button>
          <button className={activeType === 'deleted' ? 'active' : ''} onClick={() => setActiveType('deleted')}>Deleted</button>
        </div>
        )}

        {!isMinimized && (
        <div className="admin-queue-content">
          <CacheStatusBanner
            showingCached={cacheStatus.showingCached}
            isRefreshing={isRefreshing}
            cachedAt={cacheStatus.cachedAt}
            liveUpdatedAt={cacheStatus.liveUpdatedAt}
            refreshingLabel="Refreshing latest admin queue..."
            liveLabel="Admin queue is up to date"
            cachedLabel="Showing cached admin queue"
          />
          {loading && <p>Loading...</p>}
          {message && <p className="admin-queue-msg">{message}</p>}

          <section>
            <h4>Incoming Requests</h4>
            {activeType === 'deleted' && !loading && <p>Deleted filter selected. Request list is hidden.</p>}
            {activeType !== 'deleted' && filteredRequests.length === 0 && !loading && <p>No pending requests.</p>}
            {filteredRequests.map((req) => (
              <div className="admin-queue-item" key={req.requestId}>
                <p><strong>Type:</strong> {req.requestType}</p>
                <p><strong>Name:</strong> {req.user?.name}</p>
                <p><strong>Email:</strong> {req.user?.email}</p>
                <p><strong>Department:</strong> {req.user?.department || req.payload?.department || 'N/A'}</p>
                <p><strong>Position:</strong> {req.user?.position || req.payload?.position || 'N/A'}</p>
                <p><strong>Requested Data:</strong></p>
                <pre>{JSON.stringify(req.payload || {}, null, 2)}</pre>
                <div className="admin-queue-actions">
                  <button onClick={() => handleReview(req.requestId, true)}>Approve</button>
                  <button className="reject" onClick={() => handleReview(req.requestId, false)}>Reject</button>
                </div>
              </div>
            ))}
          </section>

          <section>
            <h4>{activeType === 'deleted' ? 'Deleted Accounts' : 'User Login Access'}</h4>
            <div className="admin-user-list">
              {filteredUsers.length === 0 && !loading && (
                <p>{activeType === 'deleted' ? 'No deleted accounts.' : 'No active users found.'}</p>
              )}
              {filteredUsers.map((u) => (
                <div className={`admin-user-row ${u.isDeleted ? 'deleted-user-row' : ''}`} key={u.id}>
                  <div>
                    <strong>{u.name}</strong> <span>({u.email})</span>
                    <p>{u.department || 'N/A'} · {u.position || 'N/A'}</p>
                    {!u.isActive && u.rejectionReason && <p className="reject-reason">Denied: {u.rejectionReason}</p>}
                    {u.isDeleted && (
                      <p className="deleted-account-meta">
                        Deleted: {formatDateTime(u.deletedAt)} · Reason: {u.deletedReason || 'N/A'}
                      </p>
                    )}
                  </div>
                  <div className="admin-user-actions">
                    {!u.isDeleted && (
                      <button onClick={() => handleDeactivate(u.id, u.isActive)}>
                        {u.isActive ? 'Remove Login Access' : 'Restore Login Access'}
                      </button>
                    )}
                    <div className="admin-user-menu-wrap">
                      <button
                        className="admin-user-menu-btn"
                        onClick={() => setMenuUserId((prev) => (prev === u.id ? null : u.id))}
                      >
                        ⋮
                      </button>
                      {menuUserId === u.id && (
                        <div className="admin-user-menu">
                          <button onClick={() => { setInfoUser(u); setMenuUserId(null); }}>Info</button>
                          {!u.isDeleted && (
                            <button className="danger" onClick={() => handleDeleteAccount(u)}>
                              Delete Account
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
        )}
      </div>

      {infoUser && (
        <div className="admin-info-overlay" onClick={() => setInfoUser(null)}>
          <div className="admin-info-modal" onClick={(e) => e.stopPropagation()}>
            <div className="admin-info-header">
              <h4>User Info</h4>
              <button className="admin-queue-close-btn" onClick={() => setInfoUser(null)}>✕</button>
            </div>
            <div className="admin-info-grid">
              <p><strong>Name:</strong> {infoUser.name || 'N/A'}</p>
              <p><strong>Email:</strong> {infoUser.email || 'N/A'}</p>
              <p><strong>Employee ID:</strong> {infoUser.employeeId || 'N/A'}</p>
              <p><strong>Department:</strong> {infoUser.department || 'N/A'}</p>
              <p><strong>Position:</strong> {infoUser.position || 'N/A'}</p>
              <p><strong>Roles:</strong> {(infoUser.roles || []).join(', ') || 'N/A'}</p>
              <p><strong>Signup Date:</strong> {formatDateTime(infoUser.createdAt)}</p>
              <p><strong>Last Login:</strong> {formatDateTime(infoUser.lastLogin)}</p>
              <p><strong>Approval Status:</strong> {infoUser.approvalStatus || 'N/A'}</p>
              <p><strong>Approved At:</strong> {formatDateTime(infoUser.approvedAt)}</p>
              <p><strong>Login Access:</strong> {infoUser.isActive ? 'Active' : 'Disabled'}</p>
              <p><strong>Deleted:</strong> {infoUser.isDeleted ? 'Yes' : 'No'}</p>
              {infoUser.isDeleted && (
                <>
                  <p><strong>Deleted At:</strong> {formatDateTime(infoUser.deletedAt)}</p>
                  <p><strong>Delete Reason:</strong> {infoUser.deletedReason || 'N/A'}</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default AdminRequestPanel;
