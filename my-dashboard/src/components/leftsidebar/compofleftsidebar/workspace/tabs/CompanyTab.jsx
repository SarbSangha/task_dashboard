import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { authAPI } from '../../../../../services/api';
import CompanyMemberPreview from '../CompanyMemberPreview';
import { useWorkspaceCompanyDirectory } from '../workspaceTabData';
import './CompanyTab.css';

const getInitials = (name = '') =>
  `${name}`.trim().split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase() || 'U';
const getHue = (name = '') => Array.from(`${name}`).reduce((total, char) => total + char.charCodeAt(0), 0) % 360;
// Positions come through as codes ("normal", "hod"); show people-friendly names.
const formatPosition = (position = '') => {
  const value = `${position || ''}`.trim().toLowerCase();
  if (!value || value === 'normal' || value === 'member') return 'Member';
  if (value === 'hod') return 'Head of department';
  if (value === 'spoc') return 'SPOC';
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
};
const isLeadPosition = (position = '') => ['hod', 'spoc', 'admin'].includes(`${position || ''}`.trim().toLowerCase());

export default function CompanyTab() {
  const { showAlert } = useCustomDialogs();
  const {
    loading,
    isRefreshing,
    isAdmin,
    canViewCompany,
    departments,
    selectedDepartment,
    members,
    activityByUser,
    cacheStatus,
    selectDepartment,
    refreshCompanyDirectory,
  } = useWorkspaceCompanyDirectory();
  const [openMenuId, setOpenMenuId] = useState(null);
  const [previewMember, setPreviewMember] = useState(null);
  const [newDepartmentName, setNewDepartmentName] = useState('');
  const [departmentSaving, setDepartmentSaving] = useState(false);
  const [showCreateDepartment, setShowCreateDepartment] = useState(false);
  const menuWrapRef = useRef(null);
  const navigate = useNavigate();

  useEffect(() => {
    if (openMenuId == null) return undefined;
    const closeOnOutside = (event) => {
      if (!menuWrapRef.current?.contains(event.target)) setOpenMenuId(null);
    };
    const closeOnEscape = (event) => {
      if (event.key === 'Escape') setOpenMenuId(null);
    };
    document.addEventListener('mousedown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [openMenuId]);

  const openDirectChat = (member) => {
    navigate(`/dashboard/messages?tab=direct&userId=${encodeURIComponent(member.id)}`);
  };

  useEffect(() => {
    setOpenMenuId(null);
  }, [selectedDepartment]);

  const handleAddDepartment = async () => {
    const name = `${newDepartmentName || ''}`.trim();
    if (!name) {
      await showAlert('Enter a department name first.', { title: 'Department Required' });
      return;
    }

    setDepartmentSaving(true);
    try {
      const response = await authAPI.createDepartment(name);
      const createdDepartmentName = `${response?.department?.name || name}`.trim();
      setNewDepartmentName('');
      setShowCreateDepartment(false);
      await refreshCompanyDirectory(createdDepartmentName);
    } catch (error) {
      await showAlert(error?.response?.data?.detail || 'Failed to add department.', { title: 'Unable to Add Department' });
    } finally {
      setDepartmentSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="tab-content workspace-company">
        <WorkspaceSkeleton variant="company" />
      </div>
    );
  }

  if (!canViewCompany) {
    return (
      <div className="tab-content workspace-company">
        <div className="workspace-company-empty">
          Admin or faculty access is required to view the company directory.
        </div>
      </div>
    );
  }

  return (
    <div className="tab-content workspace-company">
      <div className="workspace-company-section">
        <div className="workspace-company-section-head">
          <div>
            <strong>Departments</strong>
            <span>{departments.length} team{departments.length === 1 ? '' : 's'} · select one to see its people</span>
          </div>
          <div className="workspace-company-section-tools">
            <CacheStatusBanner
              showingCached={cacheStatus.showingCached}
              isRefreshing={isRefreshing}
              cachedAt={cacheStatus.cachedAt}
              liveUpdatedAt={cacheStatus.liveUpdatedAt}
              refreshingLabel="Refreshing company directory..."
              liveLabel="Company directory is up to date"
              cachedLabel="Showing cached company directory"
              className="cache-status-banner--header"
            />
            {isAdmin && (
              <button
                type="button"
                className={`workspace-company-new-btn ${showCreateDepartment ? 'is-open' : ''}`}
                onClick={() => setShowCreateDepartment((open) => !open)}
                aria-expanded={showCreateDepartment}
              >
                {showCreateDepartment ? 'Cancel' : '+ New department'}
              </button>
            )}
          </div>
        </div>

        {isAdmin && showCreateDepartment && (
          <form
            className="workspace-company-create-inline"
            onSubmit={(event) => {
              event.preventDefault();
              void handleAddDepartment();
            }}
          >
            <input
              className="workspace-company-input"
              value={newDepartmentName}
              onChange={(event) => setNewDepartmentName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape') setShowCreateDepartment(false);
              }}
              placeholder="Department name, e.g. 3D Visualizer"
              aria-label="New department name"
              autoFocus
            />
            <button type="submit" className="workspace-company-submit" disabled={departmentSaving || !newDepartmentName.trim()}>
              {departmentSaving ? 'Adding…' : 'Add department'}
            </button>
          </form>
        )}

        <div className="workspace-company-chip-grid">
          {departments.map((dept) => (
            <button
              key={dept}
              type="button"
              className={`workspace-company-chip ${selectedDepartment === dept ? 'active' : ''}`}
              onClick={() => {
                void selectDepartment(dept);
              }}
            >
              <span>{dept}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="workspace-company-member-grid">
        {members.length === 0 && (
          <div className="workspace-company-empty workspace-company-empty-members">
            No members found in selected department.
          </div>
        )}
        {members.map((member) => (
          <div
            className="workspace-company-member-card"
            key={member.id}
            role="button"
            tabIndex={0}
            onClick={() => setPreviewMember(member)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setPreviewMember(member);
              }
            }}
          >
            <div
              className="workspace-company-avatar"
              style={{ '--member-hue': `${getHue(member.name)}deg` }}
              aria-hidden="true"
            >
              {getInitials(member.name)}
            </div>
            <div className="workspace-company-member-body">
              <div className="workspace-company-member-name" title={member.name}>{member.name}</div>
              <div className="workspace-company-member-meta">
                <span className={`workspace-company-member-badge ${isLeadPosition(member.position) ? 'is-lead' : ''}`}>
                  {formatPosition(member.position)}
                </span>
              </div>
              {member.email && (
                <div className="workspace-company-member-email" title={member.email}>{member.email}</div>
              )}
            </div>
            <div className="workspace-company-member-actions" ref={openMenuId === member.id ? menuWrapRef : undefined}>
              <button
                type="button"
                className="workspace-company-menu-button"
                aria-label={`Open actions for ${member.name}`}
                aria-expanded={openMenuId === member.id}
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuId((currentMenuId) => (currentMenuId === member.id ? null : member.id));
                }}
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="12" cy="5" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="12" cy="19" r="1.6" />
                </svg>
              </button>
              {openMenuId === member.id && (
                <div className="workspace-company-menu">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuId(null);
                      openDirectChat(member);
                    }}
                  >
                    Message
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuId(null);
                      setPreviewMember(member);
                    }}
                  >
                    View profile
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <CompanyMemberPreview
        isOpen={!!previewMember}
        member={previewMember}
        selectedDepartment={selectedDepartment}
        activity={previewMember ? activityByUser[previewMember.id] : null}
        onClose={() => setPreviewMember(null)}
      />
    </div>
  );
}
