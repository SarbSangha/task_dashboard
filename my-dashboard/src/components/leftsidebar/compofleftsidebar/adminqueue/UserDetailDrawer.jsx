import { useEffect, useMemo, useRef, useState } from 'react';
import { authAPI } from '../../../../services/api';
import { useAuth } from '../../../../context/AuthContext';
import { UserAvatar } from '../../../common/UserAvatar';
import SidebarAccessList from './SidebarAccessList';
import { getAvatarHue } from '../../../../utils/taskPresentation';
import './UserDetailDrawer.css';

const POSITION_OPTIONS = [
  { value: 'NORMAL', label: 'Member', hint: 'Regular access.' },
  { value: 'HOD', label: 'Head of department', hint: 'Can approve and manage tasks for their department.' },
  { value: 'SPOC', label: 'SPOC', hint: 'Single point of contact: can review department submissions.' },
  { value: 'FACULTY', label: 'Faculty', hint: 'Not tied to a department.' },
];

const humanize = (value = '') => {
  const text = `${value || ''}`.trim().replace(/[_-]+/g, ' ').toLowerCase();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : '';
};

// Same casing rule as the Login Access table: all-caps names in title case.
const tidyText = (value = '') => {
  const text = `${value || ''}`.trim();
  if (!text || text !== text.toUpperCase() || text.length <= 3) return text;
  return text.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
};

const formatPosition = (position) => {
  const value = `${position || ''}`.trim().toUpperCase();
  return POSITION_OPTIONS.find((option) => option.value === value)?.label || humanize(position) || '—';
};

const stateOf = (user) => {
  if (user.isDeleted) return { cls: 'deleted', label: 'Deleted' };
  if (!user.isActive) return { cls: 'disabled', label: 'Login disabled' };
  return { cls: 'active', label: 'Active' };
};

const buildDraft = (user) => ({
  name: user.name || '',
  email: user.email || '',
  employee_id: user.employeeId || '',
  department: user.department || '',
  position: `${user.position || 'NORMAL'}`.toUpperCase(),
});

function Switch({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`udd-switch${checked ? ' is-on' : ''}`}
      onClick={onChange}
      disabled={disabled}
    >
      <span className="udd-switch-thumb" />
    </button>
  );
}

function AccessRow({ title, description, checked, onChange, busy, disabled, lockedLabel }) {
  return (
    <div className={`udd-access-row${disabled ? ' is-locked' : ''}`}>
      <div className="udd-access-copy">
        <span className="udd-access-title">{title}</span>
        {description && <span className="udd-access-desc">{description}</span>}
      </div>
      {lockedLabel ? (
        <span className="udd-locked">{lockedLabel}</span>
      ) : (
        <Switch checked={checked} onChange={onChange} disabled={disabled || busy} label={title} />
      )}
    </div>
  );
}

function Field({ label, children, hint, error }) {
  return (
    <label className={`udd-form-field${error ? ' has-error' : ''}`}>
      <span className="udd-form-label">{label}</span>
      {children}
      {error ? <span className="udd-form-error">{error}</span> : hint ? <span className="udd-form-hint">{hint}</span> : null}
    </label>
  );
}

export default function UserDetailDrawer({
  user: initialUser, setUsers, onClose,
  showConfirm, showPrompt, setMessage, onReload, onRefresh, formatDateTime,
}) {
  const { user: currentUser } = useAuth();
  const [user, setUser] = useState(initialUser);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => buildDraft(initialUser || {}));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState(null);
  const [departments, setDepartments] = useState([]);
  const [features, setFeatures] = useState([]);
  const noticeTimer = useRef(null);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    authAPI.getAdminDepartments()
      .then((res) => { if (!cancelled) setDepartments((res?.departments || []).map((d) => d.name).filter(Boolean)); })
      .catch(() => {});
    authAPI.getFeatureAccessCatalog()
      .then((res) => { if (!cancelled) setFeatures(res?.features || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      if (editing) setEditing(false);
      else onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  useEffect(() => {
    if (editing) firstFieldRef.current?.focus();
  }, [editing]);

  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const departmentOptions = useMemo(() => {
    const names = new Set(departments);
    if (draft.department) names.add(draft.department);
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [departments, draft.department]);

  if (!user) return null;

  const isSelf = Number(user.id) === Number(currentUser?.id);
  const isProtected = Boolean(user.isSuperAdmin) && !isSelf;
  const canEdit = !user.isDeleted && !isProtected;
  const state = stateOf(user);
  const roleNames = (user.roles || []).filter((role) => role !== 'user');

  const flash = (text, tone = 'success') => {
    window.clearTimeout(noticeTimer.current);
    setNotice({ text, tone });
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3500);
  };

  // Keep this drawer and the table behind it in step with server responses.
  const applyUser = (nextUser) => {
    if (!nextUser) return;
    setUser((prev) => ({ ...prev, ...nextUser }));
    setUsers?.((prev) => prev.map((row) => (row.id === nextUser.id ? { ...row, ...nextUser } : row)));
  };

  const fail = (error, fallback) => {
    const detail = error?.response?.data?.detail;
    flash(typeof detail === 'string' ? detail : fallback, 'error');
  };

  const changedFields = (() => {
    const original = buildDraft(user);
    return Object.keys(draft).filter((key) => `${draft[key] || ''}`.trim() !== `${original[key] || ''}`.trim());
  })();

  const startEditing = () => {
    setDraft(buildDraft(user));
    setFormError('');
    setEditing(true);
  };

  const saveProfile = async (event) => {
    event?.preventDefault();
    if (!changedFields.length) { setEditing(false); return; }
    if (draft.name.trim().length < 2) { setFormError('Name must be at least 2 characters.'); return; }
    if (!/^\S+@\S+\.\S+$/.test(draft.email.trim())) { setFormError('Enter a valid email address.'); return; }
    if (draft.position !== 'FACULTY' && !draft.department) { setFormError('Choose a department (only Faculty can be without one).'); return; }

    const original = buildDraft(user);
    if (changedFields.includes('email') || changedFields.includes('position')) {
      const notes = [];
      if (changedFields.includes('email')) notes.push(`Their sign-in email will change to ${draft.email.trim()}.`);
      if (changedFields.includes('position')) {
        notes.push(`Position changes from ${formatPosition(original.position)} to ${formatPosition(draft.position)}, which changes what they can approve and see.`);
      }
      const ok = await showConfirm(notes.join('\n\n'), { title: `Update ${user.name}?`, confirmText: 'Save changes' });
      if (!ok) return;
    }

    const changes = Object.fromEntries(changedFields.map((key) => [key, `${draft[key] || ''}`.trim()]));
    setSaving(true);
    setFormError('');
    try {
      const res = await authAPI.adminUpdateUserProfile(user.id, changes);
      applyUser(res?.user);
      setEditing(false);
      flash(res?.message === 'No changes' ? 'Nothing to update.' : 'Profile updated.');
      setMessage?.('');
    } catch (error) {
      const detail = error?.response?.data?.detail;
      setFormError(typeof detail === 'string' ? detail : 'Could not save the profile. Try again.');
    } finally {
      setSaving(false);
    }
  };

  const toggleLogin = async () => {
    if (busyKey) return;
    try {
      setBusyKey('login');
      if (user.isActive) {
        const reason = await showPrompt(`Why are you removing login access for ${user.name}?`, {
          title: 'Disable login access', defaultValue: '', placeholder: 'Reason (shown to admins)', confirmText: 'Disable access',
        });
        if (reason === null) return;
        await authAPI.deactivateUserAccess(user.id, reason || '');
        applyUser({ id: user.id, isActive: false, rejectionReason: reason || null });
        flash('Login access disabled. Their sessions were signed out.');
      } else {
        await authAPI.activateUserAccess(user.id);
        applyUser({ id: user.id, isActive: true, rejectionReason: null });
        flash('Login access restored.');
      }
      onRefresh?.();
    } catch (error) {
      fail(error, 'Could not update login access.');
    } finally {
      setBusyKey('');
    }
  };

  const toggleAdmin = async () => {
    if (busyKey) return;
    const enabling = !user.isAdmin;
    const ok = await showConfirm(
      enabling
        ? `Give ${user.name} admin access? They will be able to manage users, access and settings.`
        : `Remove admin access from ${user.name}?`,
      { title: enabling ? 'Grant admin access' : 'Remove admin access', confirmText: enabling ? 'Grant access' : 'Remove access' },
    );
    if (!ok) return;
    try {
      setBusyKey('admin');
      const res = await authAPI.setUserAdminAccess(user.id, enabling);
      applyUser(res?.user);
      flash(enabling ? 'Admin access granted.' : 'Admin access removed.');
    } catch (error) {
      fail(error, 'Could not change admin access.');
    } finally {
      setBusyKey('');
    }
  };

  const togglePolicy = async () => {
    if (busyKey) return;
    try {
      setBusyKey('policy');
      const res = await authAPI.setUserWorkplacePolicy(user.id, !user.enforceActiveTaskPolicy);
      applyUser(res?.user);
      flash(user.enforceActiveTaskPolicy ? 'Workplace policy turned off.' : 'Workplace policy turned on.');
    } catch (error) {
      fail(error, 'Could not update the workplace policy.');
    } finally {
      setBusyKey('');
    }
  };

  const toggleFeature = async (feature) => {
    if (busyKey) return;
    const enabled = !user.featureAccess?.[feature.key];
    try {
      setBusyKey(`feature:${feature.key}`);
      const res = await authAPI.setUserFeatureAccess(user.id, feature.key, enabled);
      applyUser(res?.user);
      flash(`${feature.label} ${enabled ? 'turned on' : 'turned off'}.`);
    } catch (error) {
      fail(error, `Could not update ${feature.label}.`);
    } finally {
      setBusyKey('');
    }
  };

  const toggleSection = async (section) => {
    if (busyKey) return;
    const visible = user.sectionVisibility?.[section.key] === false;
    try {
      setBusyKey(`section:${section.key}`);
      const res = await authAPI.setUserSectionVisibility(user.id, section.key, visible);
      applyUser(res?.user);
      flash(`${section.label} ${visible ? 'is back in' : 'was removed from'} their sidebar.`);
    } catch (error) {
      fail(error, `Could not update ${section.label}.`);
    } finally {
      setBusyKey('');
    }
  };

  const changePassword = async () => {
    const p1 = await showPrompt(`New password for ${user.name}:`, {
      title: 'Set a new password', defaultValue: '', placeholder: 'At least 8 characters', inputType: 'password', confirmText: 'Continue',
    });
    if (p1 === null) return;
    if (p1.trim().length < 8) { flash('Password must be at least 8 characters.', 'error'); return; }
    const p2 = await showPrompt('Type the new password again:', {
      title: 'Confirm password', defaultValue: '', placeholder: 'Re-enter password', inputType: 'password', confirmText: 'Update password',
    });
    if (p2 === null) return;
    if (p1 !== p2) { flash('The passwords did not match.', 'error'); return; }
    try {
      setBusyKey('password');
      await authAPI.adminChangeUserPassword(user.id, p1);
      flash('Password updated. They were signed out everywhere.');
    } catch (error) {
      fail(error, 'Could not update the password.');
    } finally {
      setBusyKey('');
    }
  };

  const deleteAccount = async () => {
    const ok = await showConfirm(
      `Delete the account for ${user.name} (${user.email})?\n\nThey lose access immediately. This cannot be undone.`,
      { title: 'Delete account', confirmText: 'Delete account' },
    );
    if (!ok) return;
    const reason = (await showPrompt('Reason for deletion (optional):', { title: 'Delete reason', defaultValue: '' })) ?? '';
    try {
      setBusyKey('delete');
      await authAPI.deleteUserAccount(user.id, reason);
      await onReload();
    } catch (error) {
      fail(error, 'Could not delete the account.');
      setBusyKey('');
    }
  };

  const profileRows = [
    ['Employee ID', user.employeeId],
    ['Department', tidyText(user.department)],
    ['Position', formatPosition(user.position)],
    ['Extra roles', roleNames.length ? roleNames.map(humanize).join(', ') : ''],
    ['Joined', formatDateTime(user.createdAt)],
    ['Last login', formatDateTime(user.lastLogin)],
    ['Approved', formatDateTime(user.approvedAt)],
  ].filter(([, value]) => value && value !== 'N/A');

  return (
    <>
      <div className="udd-overlay" onClick={onClose} />
      <aside className="udd-drawer" role="dialog" aria-modal="true" aria-label={`User profile: ${user.name}`}>
        <div className="udd-header">
          <h4 className="udd-header-title">User profile</h4>
          <button type="button" className="udd-close" onClick={onClose} aria-label="Close user profile">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="udd-body">
          <div className="udd-hero">
            <span
              className="udd-hero-avatar"
              style={{ '--user-avatar-fallback-background': `hsl(${getAvatarHue(user.name || user.email)} 52% 48%)` }}
            >
              <UserAvatar avatar={user.avatar} name={user.name} size={56} />
            </span>
            <div className="udd-hero-info">
              <span className="udd-hero-name">{user.name}</span>
              <span className="udd-hero-email">{user.email}</span>
              <div className="udd-hero-badges">
                <span className={`udd-state-badge udd-state-badge--${state.cls}`}>{state.label}</span>
                {user.isAdmin && <span className="udd-state-badge udd-state-badge--admin">Admin</span>}
                {user.isSuperAdmin && <span className="udd-state-badge udd-state-badge--admin">Super admin</span>}
                {user.enforceActiveTaskPolicy && <span className="udd-policy-badge">Policy on</span>}
                {isSelf && <span className="udd-self-badge">You</span>}
              </div>
            </div>
          </div>

          {notice && (
            <div className={`udd-notice udd-notice--${notice.tone}`} role={notice.tone === 'error' ? 'alert' : 'status'}>
              {notice.text}
            </div>
          )}

          {user.isDeleted && (
            <div className="udd-deleted-note">
              <strong>This account was deleted</strong>
              <span>
                {formatDateTime(user.deletedAt)}
                {user.deletedReason ? ` · ${user.deletedReason}` : ''}
              </span>
            </div>
          )}

          {/* ── Profile ── */}
          <section className="udd-section">
            <div className="udd-section-head">
              <h5 className="udd-section-title">Profile</h5>
              {canEdit && !editing && (
                <button type="button" className="udd-link-btn" onClick={startEditing}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16Z" /></svg>
                  Edit
                </button>
              )}
              {isProtected && <span className="udd-locked">Super admin · read only</span>}
            </div>

            {editing ? (
              <form className="udd-form" onSubmit={saveProfile} noValidate>
                <Field label="Full name">
                  <input
                    ref={firstFieldRef}
                    className="udd-input"
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    maxLength={120}
                    autoComplete="off"
                  />
                </Field>
                <Field label="Email" hint="Used to sign in.">
                  <input
                    className="udd-input"
                    type="email"
                    value={draft.email}
                    onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                    autoComplete="off"
                  />
                </Field>
                <div className="udd-form-row">
                  <Field label="Employee ID">
                    <input
                      className="udd-input"
                      value={draft.employee_id}
                      onChange={(e) => setDraft((d) => ({ ...d, employee_id: e.target.value }))}
                      maxLength={60}
                      autoComplete="off"
                    />
                  </Field>
                  <Field label="Position">
                    <select
                      className="udd-input"
                      value={draft.position}
                      onChange={(e) => setDraft((d) => ({ ...d, position: e.target.value }))}
                    >
                      {/* Legacy positions (e.g. ADMIN) stay selectable so an unrelated edit doesn't silently change them. */}
                      {!POSITION_OPTIONS.some((option) => option.value === draft.position) && (
                        <option value={draft.position}>{formatPosition(draft.position)}</option>
                      )}
                      {POSITION_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </Field>
                </div>
                {POSITION_OPTIONS.some((option) => option.value === draft.position) && (
                  <p className="udd-form-note">
                    {POSITION_OPTIONS.find((option) => option.value === draft.position).hint}
                  </p>
                )}
                <Field label={draft.position === 'FACULTY' ? 'Department (optional)' : 'Department'}>
                  <select
                    className="udd-input"
                    value={draft.department}
                    onChange={(e) => setDraft((d) => ({ ...d, department: e.target.value }))}
                  >
                    <option value="">{draft.position === 'FACULTY' ? 'No department' : 'Choose a department'}</option>
                    {departmentOptions.map((name) => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                </Field>

                {formError && <div className="udd-form-alert" role="alert">{formError}</div>}

                <div className="udd-form-actions">
                  <button type="button" className="udd-btn udd-btn--ghost" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </button>
                  <button type="submit" className="udd-btn udd-btn--primary" disabled={saving || !changedFields.length}>
                    {saving ? 'Saving…' : changedFields.length ? `Save ${changedFields.length} change${changedFields.length === 1 ? '' : 's'}` : 'No changes'}
                  </button>
                </div>
              </form>
            ) : (
              <dl className="udd-kv">
                {profileRows.map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
                {user.rejectionReason && !user.isActive && (
                  <div className="udd-kv-wide">
                    <dt>Disabled because</dt>
                    <dd>{user.rejectionReason}</dd>
                  </div>
                )}
              </dl>
            )}
          </section>

          {/* ── Access ── */}
          {!user.isDeleted && (
            <section className="udd-section">
              <div className="udd-section-head">
                <h5 className="udd-section-title">Access</h5>
              </div>
              <div className="udd-access-list">
                <AccessRow
                  title="Login access"
                  description={user.isActive ? 'Can sign in to the dashboard.' : 'Cannot sign in.'}
                  checked={Boolean(user.isActive)}
                  onChange={toggleLogin}
                  busy={busyKey === 'login'}
                  disabled={isSelf || isProtected}
                  lockedLabel={isSelf ? 'Your account' : undefined}
                />
                <AccessRow
                  title="Admin access"
                  description="Manage users, access, clients and settings."
                  checked={Boolean(user.isAdmin)}
                  onChange={toggleAdmin}
                  busy={busyKey === 'admin'}
                  disabled={isSelf || isProtected || (!user.isAdmin && !user.isActive)}
                  lockedLabel={isSelf ? 'Your account' : isProtected ? 'Always on' : undefined}
                />
                {!user.isAdmin && (
                  <AccessRow
                    title="Active task required"
                    description="Workplace tools only open while they have an active inbox task."
                    checked={Boolean(user.enforceActiveTaskPolicy)}
                    onChange={togglePolicy}
                    busy={busyKey === 'policy'}
                  />
                )}
              </div>
            </section>
          )}

          {/* ── Sidebar sections ── */}
          {!user.isDeleted && (
            <section className="udd-section">
              <SidebarAccessList
                user={user}
                catalog={features}
                busyKey={busyKey}
                onToggleFeature={toggleFeature}
                onToggleSection={toggleSection}
              />
            </section>
          )}

          {/* ── Security & danger zone ── */}
          {!user.isDeleted && !isProtected && (
            <section className="udd-section">
              <div className="udd-section-head">
                <h5 className="udd-section-title">Security</h5>
              </div>
              <div className="udd-action-row">
                <div className="udd-access-copy">
                  <span className="udd-access-title">Password</span>
                  <span className="udd-access-desc">Set a new password. They will be signed out everywhere.</span>
                </div>
                <button type="button" className="udd-btn udd-btn--ghost" onClick={changePassword} disabled={busyKey === 'password'}>
                  Change password
                </button>
              </div>
              {!isSelf && !user.isAdmin && (
                <div className="udd-danger-zone">
                  <div className="udd-access-copy">
                    <span className="udd-access-title">Delete account</span>
                    <span className="udd-access-desc">Removes their access permanently. Cannot be undone.</span>
                  </div>
                  <button type="button" className="udd-btn udd-btn--danger" onClick={deleteAccount} disabled={busyKey === 'delete'}>
                    Delete
                  </button>
                </div>
              )}
            </section>
          )}
        </div>
      </aside>
    </>
  );
}
