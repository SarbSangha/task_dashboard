import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { generationRecordsAPI } from '../../../../../services/api';
import { UserAvatar } from '../../../../common/UserAvatar';
import { formatGenerationDate, truncateText } from './klingMedia';
import './KlingUserProfile.css';

export default function KlingUserProfile({ userId, onClose, onOpenGeneration }) {
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [recentGenerations, setRecentGenerations] = useState([]);
  const [recentLoading, setRecentLoading] = useState(false);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await generationRecordsAPI.getUserProfile(userId);
        if (!cancelled) setProfile(response?.data || null);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load user profile:', fetchError);
          setError('Could not load this user profile right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    if (!userId) return undefined;
    let cancelled = false;
    setRecentLoading(true);
    (async () => {
      try {
        const response = await generationRecordsAPI.search({ owner_user_id: userId, limit: 8, sort: 'latest' });
        if (!cancelled) setRecentGenerations(Array.isArray(response?.data) ? response.data : []);
      } catch (fetchError) {
        console.warn('Failed to load recent generations for user profile:', fetchError);
      } finally {
        if (!cancelled) setRecentLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!userId) return null;

  return createPortal(
    <div className="kling-timeline-overlay" onClick={onClose}>
      <div
        className="kling-user-profile-shell"
        role="dialog"
        aria-modal="true"
        aria-label="User profile"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kling-timeline-header">
          <h3>User Profile</h3>
          <button type="button" className="kling-timeline-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="kling-timeline-body">
          {error && <div className="kling-state kling-state-error">{error}</div>}
          {!error && loading && <div className="kling-state">Loading profile...</div>}

          {!error && !loading && profile && (
            <>
              <div className="kling-user-profile-header">
                <UserAvatar avatar={profile.avatar} name={profile.name || 'Unknown user'} size={56} />
                <div>
                  <h4>{profile.name || 'Unknown user'}</h4>
                  <p>{profile.department || 'No department'}</p>
                </div>
              </div>

              <div className="kling-user-profile-stats">
                <div className="kling-user-profile-stat kling-user-profile-stat-accent">
                  <span>{profile.totalGenerations}</span>
                  <label>Total Generations</label>
                </div>
                <div className="kling-user-profile-stat">
                  <span>{profile.imageCount}</span>
                  <label>Images</label>
                </div>
                <div className="kling-user-profile-stat">
                  <span>{profile.videoCount}</span>
                  <label>Videos</label>
                </div>
                <div className="kling-user-profile-stat">
                  <span>{Math.round(profile.creditsBurned || 0)}</span>
                  <label>Credits Used</label>
                </div>
              </div>

              {profile.topModel && (
                <p className="kling-user-profile-note">Most used model: <strong>{profile.topModel}</strong></p>
              )}

              <div className="kling-drawer-section">
                <h4>Top Projects</h4>
                {profile.topProjects?.length ? (
                  <ul className="kling-user-profile-list">
                    {profile.topProjects.map((project) => (
                      <li key={project.projectId}>
                        <span>{project.name}</span>
                        <span>{project.count}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="kling-drawer-future-note">No projects yet.</p>
                )}
              </div>

              <div className="kling-drawer-section">
                <h4>Top Tags</h4>
                {profile.topTags?.length ? (
                  <div className="kling-card-tags">
                    {profile.topTags.map((tagItem) => (
                      <span key={tagItem.tag} className="kling-card-tag-chip">
                        {tagItem.tag} ({tagItem.count})
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="kling-drawer-future-note">No tags used yet.</p>
                )}
              </div>

              <div className="kling-drawer-section">
                <h4>Recent Activity</h4>
                {recentLoading && <p className="kling-drawer-future-note">Loading recent generations...</p>}
                {!recentLoading && recentGenerations.length === 0 && (
                  <p className="kling-drawer-future-note">No recent generations.</p>
                )}
                {!recentLoading && recentGenerations.length > 0 && (
                  <ul className="kling-user-profile-list">
                    {recentGenerations.map((generation) => (
                      <li
                        key={generation.id}
                        className="kling-user-profile-list-clickable"
                        onClick={() => onOpenGeneration?.(generation)}
                      >
                        <span>{truncateText(generation.promptText, 60) || 'No prompt captured'}</span>
                        <span>{formatGenerationDate(generation.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
