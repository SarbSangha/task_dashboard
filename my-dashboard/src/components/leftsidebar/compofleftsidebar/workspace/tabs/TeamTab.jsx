import React, { useState } from 'react';
import { useCustomDialogs } from '../../../../common/CustomDialogs';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  formatDateTimeIndia,
  formatSeconds,
  useWorkspaceTeamDirectory,
} from '../workspaceTabData';

export default function TeamTab() {
  const { showAlert } = useCustomDialogs();
  const { members, loading, isRefreshing, myDepartment, isHodUser, activityByUser, cacheStatus } = useWorkspaceTeamDirectory();
  const [openMenuId, setOpenMenuId] = useState(null);
  const [infoMember, setInfoMember] = useState(null);

  return (
    <div className="tab-content">
      <div className="content-header">
        <h3>Team Members ({myDepartment || 'Department'})</h3>
      </div>
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
            <div className="team-member-card" key={member.id}>
              <div className="member-avatar">{member.name?.[0]?.toUpperCase() || 'U'}</div>
              <div className="member-info">
                <div className="member-name">{member.name}</div>
                <div className="member-role">{member.department}</div>
                <div className="member-role">{member.position}</div>
              </div>
              <div className="outbox-card-menu-wrap" style={{ marginLeft: 'auto' }}>
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
        <>
          <div
            className="admin-queue-overlay"
            onClick={() => setInfoMember(null)}
            style={{ zIndex: 1400 }}
          />
          <div
            className="admin-queue-panel"
            style={{ zIndex: 1401, width: 'min(560px, 92vw)', height: 'auto', maxHeight: '80vh' }}
          >
            <div className="admin-queue-header">
              <h3>Member Info</h3>
              <button onClick={() => setInfoMember(null)}>✕</button>
            </div>
            <div className="admin-queue-content" style={{ gridTemplateColumns: '1fr', gap: '10px' }}>
              <div className="admin-queue-item">
                <p><strong>Name:</strong> {infoMember.name}</p>
                <p><strong>Department:</strong> {infoMember.department}</p>
                <p><strong>Position:</strong> {infoMember.position}</p>
                <p><strong>Status:</strong> {activityByUser[infoMember.id]?.status || 'OFFLINE'}</p>
                <p><strong>Login Time:</strong> {formatDateTimeIndia(activityByUser[infoMember.id]?.loginTime)}</p>
                <p><strong>Session Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.totalSessionDuration || 0)}</p>
                <p><strong>Active Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.activeTime || 0)}</p>
                <p><strong>Idle Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.idleTime || 0)}</p>
                <p><strong>Away Duration:</strong> {formatSeconds(activityByUser[infoMember.id]?.awayTime || 0)}</p>
                <p><strong>Last Seen:</strong> {formatDateTimeIndia(activityByUser[infoMember.id]?.lastSeen)}</p>
                <p><strong>Heartbeat Count:</strong> {activityByUser[infoMember.id]?.heartbeatCount ?? 0}</p>
                <p><strong>Productivity:</strong> {activityByUser[infoMember.id]?.productivity ?? 0}%</p>
                <p><strong>Tasks Done Today:</strong> {activityByUser[infoMember.id]?.tasksDone ?? 0}</p>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
