import React, { useEffect, useState } from 'react';
import { authAPI } from '../../../../services/api';
import './AdminRequestPanel.css';

const AdminRequestPanel = ({ isOpen, onClose }) => {
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState([]);
  const [users, setUsers] = useState([]);
  const [activeType, setActiveType] = useState('all');
  const [message, setMessage] = useState('');

  const loadData = async () => {
    setLoading(true);
    try {
      const [reqRes, usersRes] = await Promise.all([
        authAPI.getAdminPendingRequests(),
        authAPI.getAdminAllUsers(),
      ]);
      setRequests(reqRes?.requests || []);
      setUsers(usersRes?.users || []);
      setMessage('');
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to load admin data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadData();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const filteredRequests = requests.filter((req) => activeType === 'all' || req.requestType === activeType);

  const handleReview = async (requestId, approve) => {
    const notes = window.prompt(
      approve ? 'Approval note (optional):' : 'Reason for rejection (required):',
      ''
    ) ?? '';
    if (!approve && !notes.trim()) {
      setMessage('Rejection reason is required.');
      return;
    }
    try {
      await authAPI.reviewAdminRequest(requestId, approve, notes);
      await loadData();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to review request');
    }
  };

  const handleDeactivate = async (userId, isActive) => {
    try {
      if (isActive) {
        const reason = window.prompt('Reason to remove login access:', '') ?? '';
        await authAPI.deactivateUserAccess(userId, reason);
      } else {
        await authAPI.activateUserAccess(userId);
      }
      await loadData();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to update user access');
    }
  };

  return (
    <>
      <div className="admin-queue-overlay" onClick={onClose} />
      <div className="admin-queue-panel">
        <div className="admin-queue-header">
          <h3>Admin Request Queue</h3>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="admin-queue-tabs">
          <button className={activeType === 'all' ? 'active' : ''} onClick={() => setActiveType('all')}>All</button>
          <button className={activeType === 'signup' ? 'active' : ''} onClick={() => setActiveType('signup')}>Login Requests</button>
          <button className={activeType === 'profile_update' ? 'active' : ''} onClick={() => setActiveType('profile_update')}>Profile Requests</button>
        </div>

        <div className="admin-queue-content">
          {loading && <p>Loading...</p>}
          {message && <p className="admin-queue-msg">{message}</p>}

          <section>
            <h4>Incoming Requests</h4>
            {filteredRequests.length === 0 && !loading && <p>No pending requests.</p>}
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
            <h4>User Login Access</h4>
            <div className="admin-user-list">
              {users.map((u) => (
                <div className="admin-user-row" key={u.id}>
                  <div>
                    <strong>{u.name}</strong> <span>({u.email})</span>
                    <p>{u.department || 'N/A'} · {u.position || 'N/A'}</p>
                    {!u.isActive && u.rejectionReason && <p className="reject-reason">Denied: {u.rejectionReason}</p>}
                  </div>
                  <button onClick={() => handleDeactivate(u.id, u.isActive)}>
                    {u.isActive ? 'Remove Login Access' : 'Restore Login Access'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
};

export default AdminRequestPanel;
