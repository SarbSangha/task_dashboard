import React, { useState } from 'react';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import { authAPI } from '../../../../../services/api';
import CompanyMemberPreview from '../CompanyMemberPreview';
import { useWorkspaceCompanyDirectory } from '../workspaceTabData';

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
      <div className="tab-content">
        <div className="content-header">
          <h3>Company Directory</h3>
        </div>
        <WorkspaceSkeleton variant="company" />
      </div>
    );
  }

  if (!canViewCompany) {
    return (
      <div className="tab-content">
        <h3>Company</h3>
        <p>Admin or faculty access is required to view the company directory.</p>
      </div>
    );
  }

  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Company Directory</h3>
      </div>
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
        <div className="company-department-toolbar">
          <div className="company-department-create">
            <div className="company-department-create-copy">
              <strong>Add Department</strong>
              <span>Create a new team once and reuse it everywhere.</span>
            </div>
            <div className="company-department-create-controls">
              <input
                className="company-department-input"
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
                className="company-department-submit"
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

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '10px', marginBottom: '14px' }}>
        {departments.map((dept) => (
          <button
            key={dept}
            className="add-btn"
            style={{
              textAlign: 'left',
              opacity: selectedDepartment === dept ? 1 : 0.8,
              border: selectedDepartment === dept ? '1px solid rgba(255,255,255,0.35)' : undefined,
            }}
            onClick={() => {
              void selectDepartment(dept);
            }}
          >
            {dept}
          </button>
        ))}
      </div>

      <div className="team-grid">
        {members.length === 0 && <div className="team-member-card">No members found in selected department.</div>}
        {members.map((member) => (
          <div
            className="team-member-card company-member-card"
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
            <div className="member-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
            <div className="member-info">
              <div className="member-name">{member.name}</div>
              <div className="member-role">{member.department || selectedDepartment}</div>
              <div className="member-role">{member.position || 'Member'}</div>
            </div>
            <div className="outbox-card-menu-wrap" style={{ marginLeft: 'auto' }}>
              <button
                className="outbox-card-menu-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenMenuId(openMenuId === member.id ? null : member.id);
                }}
              >
                ⋮
              </button>
              {openMenuId === member.id && (
                <div className="outbox-card-menu">
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenMenuId(null);
                      void showAlert(`Chat with ${member.name} will open here.`, { title: 'Team Chat' });
                    }}
                  >
                    Chat
                  </button>
                  <button
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
