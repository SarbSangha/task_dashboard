import { useEffect, useState } from 'react';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { authAPI } from '../../../../../services/api';
import CompanyMemberPreview from '../CompanyMemberPreview';
import { useWorkspaceCompanyDirectory } from '../workspaceTabData';
import './CompanyTab.css';

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
      <CacheStatusBanner
        showingCached={cacheStatus.showingCached}
        isRefreshing={isRefreshing}
        cachedAt={cacheStatus.cachedAt}
        liveUpdatedAt={cacheStatus.liveUpdatedAt}
        refreshingLabel="Refreshing company directory..."
        liveLabel="Company directory is up to date"
        cachedLabel="Showing cached company directory"
      />

      {isAdmin && (
        <div className="workspace-company-toolbar">
          <div className="workspace-company-create-panel">
            <div className="workspace-company-create-copy">
              <strong>Add Department</strong>
              <span>Create a reusable team for assignments, credentials, and member views.</span>
            </div>
            <div className="workspace-company-create-controls">
              <input
                className="workspace-company-input"
                value={newDepartmentName}
                onChange={(event) => setNewDepartmentName(event.target.value)}
                placeholder="e.g. 3D Visualizer"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleAddDepartment();
                  }
                }}
              />
              <button
                type="button"
                className="workspace-company-submit"
                onClick={() => {
                  void handleAddDepartment();
                }}
                disabled={departmentSaving}
              >
                {departmentSaving ? 'Adding...' : 'Add Department'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="workspace-company-section">
        <div className="workspace-company-section-head">
          <div>
            <strong>Departments</strong>
            <span>{departments.length} team{departments.length === 1 ? '' : 's'} available</span>
          </div>
          {selectedDepartment ? <small className="workspace-company-section-meta">Viewing {selectedDepartment}</small> : null}
        </div>

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
            <div className="workspace-company-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
            <div className="workspace-company-member-body">
              <div className="workspace-company-member-name">{member.name}</div>
              <div className="workspace-company-member-meta">
                <span className="workspace-company-member-badge">
                  {member.department || selectedDepartment}
                </span>
                <span className="workspace-company-member-position">
                  {member.position || 'Member'}
                </span>
              </div>
            </div>
            <div className="workspace-company-member-actions">
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
                ⋮
              </button>
              {openMenuId === member.id && (
                <div className="workspace-company-menu">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuId(null);
                      void showAlert(`Chat with ${member.name} will open here.`, { title: 'Team Chat' });
                    }}
                  >
                    Chat
                  </button>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuId(null);
                      setPreviewMember(member);
                    }}
                  >
                    Info
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
