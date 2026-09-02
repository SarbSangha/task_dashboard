import { useCallback, useEffect, useRef, useState } from 'react';
import { grammarlyDocsCaptureAPI } from '../../../../../../services/api';
import { WorkspaceSkeleton } from '../../../../../ui/WorkspaceSkeleton';
import GrammarlyDocsSessionDetailDrawer from './GrammarlyDocsSessionDetailDrawer';
import {
  formatAbsoluteTime,
  formatCount,
  formatDuration,
  formatRelativeTime,
  getSessionStatusMeta,
  groupSessionsByPerson,
  normalizeApiError,
} from './grammarlyDocsCaptureUtils';
import './GrammarlyDocsCaptureCenterTab.css';

const SESSION_PAGE_SIZE = 100;

/**
 * The (only) browse view of the Grammarly Docs Capture Center - one group
 * per person, heaviest total time first, expandable to that person's
 * individual doc sessions. Mirrors splice-capture/SpliceDownloadsBrowser.jsx's
 * fetch/load-more shape, with a client-side grouping pass on top
 * (groupSessionsByPerson - see grammarlyDocsCaptureUtils.js) since there is
 * no dedicated by-person aggregate endpoint yet, just the flat, filterable
 * GET /sessions list.
 */
export default function GrammarlyDocsSessionsByPerson({ searchInput }) {
  const [sessions, setSessions] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  // Separate expand state for doc rows nested under a person (see
  // groupSessionsByDoc's own comment on why one doc_id can hold several
  // session/page visits) - keyed by the doc group's own key, which stays
  // unique across different people since it's just docId (or the no-doc
  // singleton fallback), same as expandedKeys' person-scoped keys never
  // colliding across people.
  const [expandedDocKeys, setExpandedDocKeys] = useState(() => new Set());
  const [selectedSession, setSelectedSession] = useState(null);
  const [selectedSessionLoading, setSelectedSessionLoading] = useState(false);
  const requestTokenRef = useRef(0);
  const detailRequestTokenRef = useRef(0);

  // The /sessions LIST response deliberately omits contentText (see backend
  // router.py's include_content=False comment) - opening a row shows
  // whatever summary fields it already has immediately, then fetches the
  // single-session detail endpoint for the full content text.
  const handleSelectSession = useCallback(async (summarySession) => {
    setSelectedSession(summarySession);
    const token = ++detailRequestTokenRef.current;
    setSelectedSessionLoading(true);
    try {
      const response = await grammarlyDocsCaptureAPI.getSession(summarySession.id);
      if (token !== detailRequestTokenRef.current) return;
      setSelectedSession(response.data);
    } catch {
      // Detail fetch failing is non-fatal - the drawer still shows the
      // summary fields it already had, just without content text.
    } finally {
      if (token === detailRequestTokenRef.current) setSelectedSessionLoading(false);
    }
  }, []);

  // Escape closes the detail drawer, matching DeveloperToolsDrawer's own
  // standard overlay/drawer convention.
  useEffect(() => {
    if (!selectedSession) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSelectedSession(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedSession]);

  const loadSessions = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await grammarlyDocsCaptureAPI.listSessions({
          q: (searchInput || '').trim() || undefined,
          limit: SESSION_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setSessions((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load Grammarly doc sessions.'));
      } finally {
        if (token === requestTokenRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [searchInput]
  );

  useEffect(() => {
    const timer = window.setTimeout(() => loadSessions(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadSessions]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || sessions.length >= total) return;
    loadSessions(sessions.length, { append: true });
  }, [sessions.length, loadingMore, total, loadSessions]);

  const toggleExpanded = (key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleDocExpanded = (key) => {
    setExpandedDocKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groups = groupSessionsByPerson(sessions);

  return (
    <div>
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && sessions.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">📝</span>
          <strong>No Grammarly doc sessions captured yet</strong>
          <p>Open a doc at coda.grammarly.com through the dashboard launcher with the extension active.</p>
        </div>
      )}

      {loading && sessions.length === 0 ? (
        <WorkspaceSkeleton variant="projects" />
      ) : sessions.length > 0 ? (
        <div className="grammarly-docs-person-groups">
          {groups.map((group) => {
            const isOpen = expandedKeys.has(group.key);
            return (
              <div key={group.key} className="grammarly-docs-person-group">
                <button
                  type="button"
                  className="grammarly-docs-person-group-head"
                  onClick={() => toggleExpanded(group.key)}
                  aria-expanded={isOpen}
                >
                  <span className="grammarly-docs-person-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="grammarly-docs-person-identity">
                    <strong>{group.ownerName}</strong>
                    <span className="grammarly-docs-person-meta">
                      {[group.ownerEmployeeId, group.ownerDepartment].filter(Boolean).join(' · ') || 'No profile on file'}
                    </span>
                  </span>
                  <span className="grammarly-docs-person-stats">
                    <span className="chatgpt-capture-badge">{formatCount(group.docCount)} doc{group.docCount === 1 ? '' : 's'}</span>
                    <span className="chatgpt-capture-badge">{formatCount(group.sessionCount)} session{group.sessionCount === 1 ? '' : 's'}</span>
                    <span className="chatgpt-capture-badge grammarly-docs-badge-accent">{formatDuration(group.totalDurationSeconds)} total</span>
                    <span className="grammarly-docs-person-last-active">Last active {formatRelativeTime(group.lastActiveAt ? new Date(group.lastActiveAt).toISOString() : null)}</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="grammarly-docs-session-list">
                    {group.docs.map((doc) => {
                      // A document with a single visit renders and behaves
                      // exactly like the old flat per-session row (clicking
                      // it opens that session directly) - the extra
                      // expand-to-see-pages affordance only appears once
                      // there's actually more than one visit to expand into,
                      // so a normal one-off doc open doesn't grow an
                      // unnecessary extra click. See groupSessionsByDoc's own
                      // comment for why one doc_id can hold several sessions
                      // (tab-switch re-opens, or Coda's own multi-page docs
                      // sharing one doc_id across pages).
                      const hasMultipleVisits = doc.sessionCount > 1;
                      const docOpen = expandedDocKeys.has(doc.key);
                      const latestSession = doc.sessions[0];
                      const latestStatusMeta = getSessionStatusMeta(latestSession.status);
                      return (
                        <div key={doc.key} className="grammarly-docs-doc-group">
                          <button
                            type="button"
                            className="grammarly-docs-session-row grammarly-docs-session-row-clickable grammarly-docs-doc-row"
                            onClick={() => (hasMultipleVisits ? toggleDocExpanded(doc.key) : handleSelectSession(latestSession))}
                            aria-expanded={hasMultipleVisits ? docOpen : undefined}
                          >
                            {hasMultipleVisits ? (
                              <span className="grammarly-docs-person-caret" aria-hidden="true">{docOpen ? '▾' : '▸'}</span>
                            ) : (
                              <span className={`grammarly-docs-session-status tone-${latestStatusMeta.tone}`} title={latestStatusMeta.label}>
                                {latestStatusMeta.icon}
                              </span>
                            )}
                            <span className="grammarly-docs-session-title">
                              {doc.docTitle || 'Untitled doc'}
                              {/* A single-visit doc names its one page inline (no expand
                                  step to find out) - a multi-visit doc leaves page names
                                  to the expanded rows below instead, where each visit gets
                                  its own line. */}
                              {!hasMultipleVisits && latestSession.pageName && (
                                <span className="grammarly-docs-session-author"> · {latestSession.pageName}</span>
                              )}
                              {doc.docAuthor && <span className="grammarly-docs-session-author"> · by {doc.docAuthor}</span>}
                            </span>
                            {hasMultipleVisits && (
                              <span className="chatgpt-capture-badge">{doc.sessionCount} visits</span>
                            )}
                            {doc.linkedClientName && (
                              <span className="chatgpt-capture-badge grammarly-docs-badge-accent">{doc.linkedClientName}</span>
                            )}
                            <span className="grammarly-docs-session-when" title={formatAbsoluteTime(doc.lastActiveAt ? new Date(doc.lastActiveAt).toISOString() : null)}>
                              {formatRelativeTime(doc.lastActiveAt ? new Date(doc.lastActiveAt).toISOString() : null)}
                            </span>
                            <span className="grammarly-docs-session-duration">
                              {formatDuration(doc.totalDurationSeconds)}
                            </span>
                          </button>

                          {hasMultipleVisits && docOpen && (
                            <div className="grammarly-docs-session-list grammarly-docs-session-list-nested">
                              {doc.sessions.map((session) => {
                                const statusMeta = getSessionStatusMeta(session.status);
                                return (
                                  <button
                                    key={session.id}
                                    type="button"
                                    className="grammarly-docs-session-row grammarly-docs-session-row-clickable grammarly-docs-session-row-nested"
                                    onClick={() => handleSelectSession(session)}
                                  >
                                    <span className={`grammarly-docs-session-status tone-${statusMeta.tone}`} title={statusMeta.label}>
                                      {statusMeta.icon}
                                    </span>
                                    <span className="grammarly-docs-session-title">
                                      {session.pageName || 'Main page'}
                                      {session.linkedClientName && <span className="grammarly-docs-session-author"> · {session.linkedClientName}</span>}
                                    </span>
                                    <span className="grammarly-docs-session-when" title={formatAbsoluteTime(session.startedAt)}>
                                      {formatRelativeTime(session.startedAt)}
                                    </span>
                                    <span className="grammarly-docs-session-duration">
                                      {session.durationSeconds != null ? formatDuration(session.durationSeconds) : '—'}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {loadingMore && <WorkspaceSkeleton variant="projects" />}
          {sessions.length < total && !loadingMore && (
            <button
              type="button"
              className="chatgpt-capture-secondary-btn"
              style={{ width: '100%', marginTop: 12 }}
              onClick={handleLoadMore}
            >
              Load more
            </button>
          )}
        </div>
      ) : null}

      <GrammarlyDocsSessionDetailDrawer
        session={selectedSession}
        loading={selectedSessionLoading}
        onClose={() => setSelectedSession(null)}
      />
    </div>
  );
}
