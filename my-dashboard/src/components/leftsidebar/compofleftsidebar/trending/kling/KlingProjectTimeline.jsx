import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { generationProjectsAPI } from '../../../../../services/api';
import { UserAvatar } from '../../../../common/UserAvatar';
import { formatGenerationDate } from './klingMedia';
import './KlingProjectTimeline.css';

const EVENT_LABELS = {
  project_created: 'created the project',
  generation_assigned: 'added a generation to the project',
  generation_removed: 'removed a generation from the project',
  generation_favorited: 'favorited a generation in the project',
  generation_unfavorited: 'unfavorited a generation in the project',
  generation_tagged: 'tagged a generation',
  generation_untagged: 'removed a tag from a generation',
};

function describeEvent(event) {
  const base = EVENT_LABELS[event.eventType] || event.eventType;
  if (event.description && (event.eventType === 'generation_tagged' || event.eventType === 'generation_untagged' || event.eventType === 'project_created')) {
    return `${base}: "${event.description}"`;
  }
  return base;
}

export default function KlingProjectTimeline({ projectId, projectName, onClose }) {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!projectId) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await generationProjectsAPI.getTimeline(projectId, { limit: 100, offset: 0 });
        if (!cancelled) setEvents(Array.isArray(response?.data) ? response.data : []);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load project timeline:', fetchError);
          setError('Could not load the project timeline right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  if (!projectId) return null;

  return createPortal(
    <div className="kling-timeline-overlay" onClick={onClose}>
      <div
        className="kling-timeline-shell"
        role="dialog"
        aria-modal="true"
        aria-label="Project timeline"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="kling-timeline-header">
          <div>
            <h3>Project Timeline</h3>
            <p>{projectName}</p>
          </div>
          <button type="button" className="kling-timeline-close" onClick={onClose} aria-label="Close">
            &times;
          </button>
        </div>

        <div className="kling-timeline-body">
          {error && <div className="kling-state kling-state-error">{error}</div>}
          {!error && loading && <div className="kling-state">Loading timeline...</div>}
          {!error && !loading && events.length === 0 && (
            <div className="kling-state">No activity recorded for this project yet.</div>
          )}
          {!error && !loading && events.length > 0 && (
            <ul className="kling-timeline-list">
              {events.map((event) => (
                <li key={event.id} className="kling-timeline-item">
                  <UserAvatar avatar={event.actorAvatar} name={event.actorName || 'Unknown user'} size={28} />
                  <div className="kling-timeline-item-body">
                    <p>
                      <strong>{event.actorName || 'Unknown user'}</strong> {describeEvent(event)}
                    </p>
                    <span className="kling-timeline-item-time">{formatGenerationDate(event.createdAt)}</span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
