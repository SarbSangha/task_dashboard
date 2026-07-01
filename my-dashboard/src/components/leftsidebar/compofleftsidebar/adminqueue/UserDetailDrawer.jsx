import React from 'react';
import { authAPI } from '../../../../services/api';
import { UserAvatar } from '../../../common/UserAvatar';
import './UserDetailDrawer.css';

function StateCls(u) {
  if (u.isDeleted) return 'deleted';
  if (u.isAdmin)   return 'admin';
  if (u.isActive)  return 'active';
  return 'disabled';
}

function StateLabel(u) {
  if (u.isDeleted) return 'Deleted';
  if (u.isAdmin)   return 'Admin';
  if (u.isActive)  return 'Active';
  return 'Disabled';
}

function InfoField({ label, value, wide }) {
  if (!value && value !== 0) return null;
  return (
    <div className={`udd-field${wide ? ' udd-field--wide' : ''}`}>
      <span className="udd-field-label">{label}</span>
      <span className="udd-field-value">{value}</span>
    </div>
  );
}

export default function UserDetailDrawer({
  user, setUsers, onClose,
  showConfirm, showPrompt, setMessage, onReload, formatDateTime,
}) {
  if (!user) return null;

  const handleToggleAccess = async () => {
    try {
      if (user.isActive) {
        const reason = (await showPrompt('Reason to remove login access:', {
          title: 'Remove Login Access', defaultValue: '',
        })) ?? '';
        await authAPI.deactivateUserAccess(user.id, reason);
      } else {
        await authAPI.activateUserAccess(user.id);
      }
      await onReload();
    } catch (e) {
      setMessage(e?.response?.data?.detail || 'Failed to update login access');
    }
  };

  const handleChangePassword = async () => {
    const p1 = await showPrompt(`New password for ${user.name}:`, {
      title: 'Change Password', defaultValue: '',
      placeholder: 'Min 8 characters', inputType: 'password', confirmText: 'Continue',
    });
    if (p1 === null) return;
    if (!p1.trim() || p1.trim().length < 8) { setMessage('Password must be at least 8 characters.'); return; }
    const p2 = await showPrompt('Confirm new password:', {
      title: 'Confirm Password', defaultValue: '',
      placeholder: 'Re-enter', inputType: 'password', confirmText: 'Update Password',
    });
    if (p2 === null) return;
    if (p1 !== p2) { setMessage('Passwords do not match.'); return; }
    try {
      await authAPI.adminChangeUserPassword(user.id, p1);
      setMessage('');
    } catch (e) {
      setMessage(e?.response?.data?.detail || 'Failed to update password');
    }
  };

  const handleDelete = async () => {
    const ok = await showConfirm(
      `Permanently delete account for ${user.name} (${user.email})?\n\nThis cannot be undone.`,
      { title: 'Delete Account' },
    );
    if (!ok) return;
    const reason = (await showPrompt('Reason for deletion (optional):', { title: 'Delete Reason', defaultValue: '' })) ?? '';
    try {
      await authAPI.deleteUserAccount(user.id, reason);
      await onReload();
    } catch (e) {
      setMessage(e?.response?.data?.detail || 'Failed to delete account');
    }
  };

  const roleDisplay = (user.roles || []).filter((r) => r !== 'user').join(', ') || (user.isAdmin ? 'Admin' : 'User');

  return (
    <>
      <div className="udd-overlay" onClick={onClose} />
      <aside className="udd-drawer" role="complementary" aria-label={`User details: ${user.name}`}>
        {/* ── Header ── */}
        <div className="udd-header">
          <h4 className="udd-header-title">User Profile</h4>
          <button type="button" className="udd-close" onClick={onClose} aria-label="Close drawer">✕</button>
        </div>

        <div className="udd-body">
          {/* ── Profile hero ── */}
          <div className="udd-hero">
            <UserAvatar avatar={user.avatar} name={user.name} size={52} />
            <div className="udd-hero-info">
              <span className="udd-hero-name">{user.name}</span>
              <span className="udd-hero-email">{user.email}</span>
              <div className="udd-hero-badges">
                <span className={`udd-state-badge udd-state-badge--${StateCls(user)}`}>
                  {StateLabel(user)}
                </span>
                {user.enforceActiveTaskPolicy && (
                  <span className="udd-policy-badge">Policy On</span>
                )}
              </div>
            </div>
          </div>

          {/* ── Profile details ── */}
          <section className="udd-section">
            <h5 className="udd-section-title">Profile Information</h5>
            <div className="udd-grid">
              <InfoField label="Employee ID"   value={user.employeeId} />
              <InfoField label="Department"    value={user.department} />
              <InfoField label="Position"      value={user.position} />
              <InfoField label="Roles"         value={roleDisplay} />
              <InfoField label="Joined"        value={formatDateTime(user.createdAt)} />
              <InfoField label="Last Login"    value={formatDateTime(user.lastLogin)} />
              <InfoField label="Approval"      value={user.approvalStatus} />
              <InfoField label="Approved At"   value={formatDateTime(user.approvedAt)} />
              <InfoField label="RMW Download"  value={user.isActive && !user.isDeleted ? 'Approved' : 'Not approved'} />
              {user.rejectionReason && (
                <InfoField label="Disabled Reason" value={user.rejectionReason} wide />
              )}
              {user.isDeleted && <>
                <InfoField label="Deleted At"    value={formatDateTime(user.deletedAt)} />
                <InfoField label="Delete Reason" value={user.deletedReason || 'N/A'} wide />
              </>}
            </div>
          </section>

          {/* ── Workplace Policy ── */}
          <section className="udd-section">
            <h5 className="udd-section-title">Workplace Policy</h5>
            <div className="udd-policy-row">
              <div>
                <span className="udd-policy-label">Active Task Requirement</span>
                {user.enforceActiveTaskPolicy && (
                  <p className="udd-policy-desc">User must have an active inbox task to access workplace tools.</p>
                )}
              </div>
              <span className={`udd-policy-status${user.enforceActiveTaskPolicy ? ' udd-policy-status--on' : ' udd-policy-status--off'}`}>
                {user.enforceActiveTaskPolicy ? 'Enabled' : 'Disabled'}
              </span>
            </div>
          </section>

          {/* ── Account Actions ── */}
          {!user.isDeleted && !user.isAdmin && (
            <section className="udd-section">
              <h5 className="udd-section-title">Account Actions</h5>
              <div className="udd-actions">
                <button
                  type="button"
                  className={`udd-action${user.isActive ? ' udd-action--disable' : ' udd-action--enable'}`}
                  onClick={handleToggleAccess}
                >
                  {user.isActive ? 'Disable Login Access' : 'Enable Login Access'}
                </button>
                <button type="button" className="udd-action" onClick={handleChangePassword}>
                  Change Password
                </button>
                <button type="button" className="udd-action udd-action--danger" onClick={handleDelete}>
                  Delete Account
                </button>
              </div>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
