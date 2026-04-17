import React, { useEffect, useMemo, useState } from 'react';
import { subscribeRealtimeNotifications, taskAPI } from '../../../services/api';
import { formatDateTimeIndia } from '../../../utils/dateTime';
import './NotificationsPanel.css';

const formatDateTime = (value) => {
  const formattedValue = formatDateTimeIndia(value);
  return formattedValue === 'N/A' ? '-' : formattedValue;
};

const NotificationsPanel = ({ isOpen, onClose }) => {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [markingId, setMarkingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  const unreadCount = useMemo(
    () => items.filter((item) => !item.isRead).length,
    [items]
  );

  const loadNotifications = async () => {
    setLoading(true);
    try {
      const response = await taskAPI.getNotifications(unreadOnly);
      setItems(response?.notifications || []);
      setError('');
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to load notifications');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return undefined;
    loadNotifications();

    const unsubscribe = subscribeRealtimeNotifications({
      onMessage: (payload) => {
        if (!payload) return;
        if (payload.eventType === 'group_message') return;
        loadNotifications();
      },
      onOpen: () => loadNotifications(),
    });

    const interval = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      loadNotifications();
    }, 180000);

    return () => {
      unsubscribe();
      window.clearInterval(interval);
    };
  }, [isOpen, unreadOnly]);

  const markAsRead = async (id) => {
    setMarkingId(id);
    try {
      await taskAPI.markNotificationRead(id);
      setItems((prev) => prev.map((item) => (item.id === id ? { ...item, isRead: true } : item)));
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to mark notification as read');
    } finally {
      setMarkingId(null);
    }
  };

  const markAllVisibleRead = async () => {
    const ids = items.filter((item) => !item.isRead).map((item) => item.id);
    if (ids.length === 0) return;
    setLoading(true);
    try {
      await Promise.all(ids.map((id) => taskAPI.markNotificationRead(id)));
      setItems((prev) => prev.map((item) => ({ ...item, isRead: true })));
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to mark all notifications as read');
    } finally {
      setLoading(false);
    }
  };

  const removeNotification = async (id) => {
    setDeletingId(id);
    try {
      await taskAPI.deleteNotification(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch (err) {
      setError(err?.response?.data?.detail || 'Failed to remove notification');
    } finally {
      setDeletingId(null);
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="notifications-overlay" onClick={onClose} />
      <div className="notifications-panel">
        <div className="notifications-header">
          <div>
            <h3>Notifications</h3>
            <p>{unreadCount} unread</p>
          </div>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="notifications-toolbar">
          <label>
            <input
              type="checkbox"
              checked={unreadOnly}
              onChange={(event) => setUnreadOnly(event.target.checked)}
            />
            Show unread only
          </label>
          <button onClick={markAllVisibleRead} disabled={loading || unreadCount === 0}>
            Mark all read
          </button>
        </div>

        <div className="notifications-content">
          {loading && <p className="notifications-state">Loading notifications...</p>}
          {error && <p className="notifications-error">{error}</p>}
          {!loading && !error && items.length === 0 && (
            <p className="notifications-state">No notifications available.</p>
          )}
          {!loading && !error && items.map((item) => (
            <div key={item.id} className={`notifications-item ${item.isRead ? 'read' : 'unread'}`}>
              <div className="notifications-item-head">
                <strong>{item.title}</strong>
                <span>{formatDateTime(item.createdAt)}</span>
              </div>
              <p>{item.message}</p>
              <div className="notifications-item-meta">
                <span>{item.taskNumber || '-'}</span>
                <span>{item.projectId || '-'}</span>
                <span>{item.eventType || '-'}</span>
                <div className="notifications-item-actions">
                  {!item.isRead && (
                    <button
                      className="notifications-mark-btn"
                      onClick={() => markAsRead(item.id)}
                      disabled={markingId === item.id || deletingId === item.id}
                    >
                      {markingId === item.id ? '...' : 'Mark read'}
                    </button>
                  )}
                  <button
                    className="notifications-remove-btn"
                    onClick={() => removeNotification(item.id)}
                    disabled={deletingId === item.id || markingId === item.id}
                  >
                    {deletingId === item.id ? 'Removing...' : 'Remove'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default NotificationsPanel;
