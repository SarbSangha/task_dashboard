import React, { useState } from 'react';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  useWorkspaceTeamDirectory,
} from '../workspaceTabData';
import CompanyMemberPreview from '../CompanyMemberPreview';

export default function TeamTab() {
  const { showAlert } = useCustomDialogs();
  const { members, loading, isRefreshing, myDepartment, isHodUser, activityByUser, cacheStatus } = useWorkspaceTeamDirectory();
  const [openMenuId, setOpenMenuId] = useState(null);
  const [infoMember, setInfoMember] = useState(null);

  return (
    <div className="tab-content">
      <CacheStatusBanner
        showingCached={cacheStatus.showingCached}
        isRefreshing={isRefreshing}
        cachedAt={cacheStatus.cachedAt}
        liveUpdatedAt={cacheStatus.liveUpdatedAt}
        refreshingLabel="Refreshing team directory..."
        liveLabel="Team directory is up to date"
        cachedLabel="Showing cached team directory"
      />
      {loading ? (
        <WorkspaceSkeleton variant="team" />
      ) : (
        <div className="team-grid">
          {members.length === 0 && <div className="team-member-card">No members found in your department.</div>}
          {members.map((member) => (
            <div
              className={`team-member-card ${isHodUser ? 'team-member-card-clickable' : ''}`}
              key={member.id}
              role={isHodUser ? 'button' : undefined}
              tabIndex={isHodUser ? 0 : undefined}
              onClick={() => {
                if (isHodUser) setInfoMember(member);
              }}
              onKeyDown={(event) => {
                if (!isHodUser) return;
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setInfoMember(member);
                }
              }}
            >
              <div className="member-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
              <div className="member-info">
                <div className="member-name">{member.name}</div>
                <div className="member-role">{member.department}</div>
                <div className="member-role">{member.position}</div>
              </div>
              <div className="outbox-card-menu-wrap" style={{ marginLeft: 'auto' }} onClick={(event) => event.stopPropagation()}>
                <button className="outbox-card-menu-btn" onClick={() => setOpenMenuId(openMenuId === member.id ? null : member.id)}>⋮</button>
                {openMenuId === member.id && (
                  <div className="outbox-card-menu">
                    <button
                      onClick={() => {
                        setOpenMenuId(null);
                        void showAlert(`Chat with ${member.name} will open here.`, { title: 'Team Chat' });
                      }}
                    >
                      Chat
                    </button>
                    {isHodUser && (
                      <button
                        onClick={() => {
                          setOpenMenuId(null);
                          setInfoMember(member);
                        }}
                      >
                        Info
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {infoMember && (
        <CompanyMemberPreview
          isOpen={!!infoMember}
          member={infoMember}
          selectedDepartment={myDepartment}
          activity={activityByUser[infoMember.id] || null}
          onClose={() => setInfoMember(null)}
        />
      )}
    </div>
  );
}
