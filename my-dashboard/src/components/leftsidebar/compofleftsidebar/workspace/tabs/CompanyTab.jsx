import React, { useState } from 'react';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import CompanyMemberPreview from '../CompanyMemberPreview';
import { useWorkspaceCompanyDirectory } from '../workspaceTabData';

export default function CompanyTab() {
  const { showAlert } = useCustomDialogs();
  const {
    loading,
    isRefreshing,
    canViewCompany,
    departments,
    selectedDepartment,
    members,
    activityByUser,
    cacheStatus,
    selectDepartment,
  } = useWorkspaceCompanyDirectory();
  const [openMenuId, setOpenMenuId] = useState(null);
  const [previewMember, setPreviewMember] = useState(null);

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
