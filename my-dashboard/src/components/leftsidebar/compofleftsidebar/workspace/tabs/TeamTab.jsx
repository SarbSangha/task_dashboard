import { useState } from 'react';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  useWorkspaceTeamDirectory,
} from '../workspaceTabData';
import CompanyMemberPreview from '../CompanyMemberPreview';
import './TeamTab.css';

export default function TeamTab() {
  const { showAlert } = useCustomDialogs();
  const { members, loading, isRefreshing, myDepartment, isHodUser, activityByUser, cacheStatus } = useWorkspaceTeamDirectory();
  const [openMenuId, setOpenMenuId] = useState(null);
  const [infoMember, setInfoMember] = useState(null);

  return (
    <div className="tab-content workspace-team">
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
        <div className="workspace-team-grid">
          {members.length === 0 && (
            <div className="workspace-team-card workspace-team-empty">
              No members found in your department.
            </div>
          )}
          {members.map((member) => (
            <div
              className={`workspace-team-card ${isHodUser ? 'workspace-team-card-clickable' : ''}`}
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
              <div className="workspace-team-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
              <div className="workspace-team-member">
                <div className="workspace-team-name">{member.name}</div>
                <div className="workspace-team-meta">
                  <span className="workspace-team-badge">{member.department}</span>
                  <span className="workspace-team-position">{member.position}</span>
                </div>
              </div>
              <div
                className="workspace-team-actions"
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  className="workspace-team-menu-button"
                  aria-label={`Open actions for ${member.name}`}
                  aria-expanded={openMenuId === member.id}
                  onClick={() => setOpenMenuId(openMenuId === member.id ? null : member.id)}
                >
                  ⋮
                </button>
                {openMenuId === member.id && (
                  <div className="workspace-team-menu">
                    <button
                      type="button"
                      onClick={() => {
                        setOpenMenuId(null);
                        void showAlert(`Chat with ${member.name} will open here.`, { title: 'Team Chat' });
                      }}
                    >
                      Chat
                    </button>
                    {isHodUser && (
                      <button
                        type="button"
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
