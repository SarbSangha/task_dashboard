import React, { useEffect, useState } from 'react';
import { authAPI } from '../../../../services/api';
import './AdminApprovalsPanel.css';

const AdminApprovalsPanel = ({ isOpen, onClose }) => {
  const [pendingSignups, setPendingSignups] = useState([]);
  const [pendingProfileChanges, setPendingProfileChanges] = useState([]);
  const [pendingPasswordChanges, setPendingPasswordChanges] = useState([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (isOpen) {
      loadQueues();
    }
  }, [isOpen]);

  const loadQueues = async () => {
    setLoading(true);
    try {
      const [signups, profileChanges, passwordChanges] = await Promise.all([
        authAPI.getPendingSignups(),
        authAPI.getPendingProfileChanges(),
        authAPI.getPendingPasswordChanges()
      ]);
      setPendingSignups(signups.requests || []);
      setPendingProfileChanges(profileChanges.requests || []);
      setPendingPasswordChanges(passwordChanges.requests || []);
      setMessage('');
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to load approval queues');
    } finally {
      setLoading(false);
    }
  };

  const reviewRequest = async (requestId, approve) => {
    try {
      await authAPI.reviewApprovalRequest(requestId, approve);
      setMessage(approve ? 'Request approved' : 'Request rejected');
      await loadQueues();
    } catch (error) {
      setMessage(error?.response?.data?.detail || 'Failed to review request');
    }
  };

  if (!isOpen) return null;

  return (
    <>
      <div className="admin-approvals-overlay" onClick={onClose} />
      <div className="admin-approvals-panel">
        <div className="admin-approvals-header">
          <h3>Admin Approvals</h3>
          <button onClick={onClose}>✕</button>
        </div>

        <div className="admin-approvals-content">
          {loading && <p className="admin-loading">Loading...</p>}
          {message && <p className="admin-message">{message}</p>}

          <section className="admin-queue-block">
            <h4>Pending Signups ({pendingSignups.length})</h4>
            {pendingSignups.map((req) => (
              <div key={req.id} className="admin-request-row">
                <div>
                  <strong>{req.payload?.name}</strong>
                  <p>{req.payload?.email} | {req.payload?.position} | {req.payload?.department}</p>
                </div>
                <div className="admin-actions">
                  <button onClick={() => reviewRequest(req.id, true)}>Approve</button>
                  <button className="reject" onClick={() => reviewRequest(req.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </section>

          <section className="admin-queue-block">
            <h4>Pending Profile Changes ({pendingProfileChanges.length})</h4>
            {pendingProfileChanges.map((req) => (
              <div key={req.id} className="admin-request-row">
                <div>
                  <strong>User #{req.userId}</strong>
                  <p>{req.payload?.name} | {req.payload?.email} | {req.payload?.position} | {req.payload?.department}</p>
                </div>
                <div className="admin-actions">
                  <button onClick={() => reviewRequest(req.id, true)}>Approve</button>
                  <button className="reject" onClick={() => reviewRequest(req.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </section>

          <section className="admin-queue-block">
            <h4>Pending Password Changes ({pendingPasswordChanges.length})</h4>
            {pendingPasswordChanges.map((req) => (
              <div key={req.id} className="admin-request-row">
                <div>
                  <strong>User #{req.userId}</strong>
                  <p>{req.payload?.summary || 'Secure password change request'}</p>
                </div>
                <div className="admin-actions">
                  <button onClick={() => reviewRequest(req.id, true)}>Approve</button>
                  <button className="reject" onClick={() => reviewRequest(req.id, false)}>Reject</button>
                </div>
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  );
};

export default AdminApprovalsPanel;
