import { useCallback, useEffect, useRef, useState } from 'react';
import { claudeCaptureAPI } from '../../../../../../services/api';
import { WorkspaceSkeleton } from '../../../../../ui/WorkspaceSkeleton';
import ClaudeConversationDetailDrawer from './ClaudeConversationDetailDrawer';
import {
  formatCount,
  formatRelativeTime,
  getConversationHealthMeta,
  groupConversationsByPerson,
  normalizeApiError,
} from './claudeCaptureUtils';
import './ClaudeCaptureCenterTab.css';

const CONVERSATION_PAGE_SIZE = 100;

/**
 * The (only) browse view of the Claude Capture Center - one group per
 * person, most recently active first, expandable to that person's
 * individual conversations. Mirrors
 * grammarly-docs-capture/GrammarlyDocsSessionsByPerson.jsx's fetch/load-more
 * shape, minus that file's extra per-document nesting level (one Claude
 * conversation is already the row - see groupConversationsByPerson).
 */
export default function ClaudeConversationsByPerson({ searchInput }) {
  const [conversations, setConversations] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expandedKeys, setExpandedKeys] = useState(() => new Set());
  const [selectedConversation, setSelectedConversation] = useState(null);
  const requestTokenRef = useRef(0);

  const loadConversations = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await claudeCaptureAPI.listConversations({
          q: (searchInput || '').trim() || undefined,
          limit: CONVERSATION_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setConversations((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load Claude conversations.'));
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
    const timer = window.setTimeout(() => loadConversations(0, { append: false }), 250);
    return () => window.clearTimeout(timer);
  }, [loadConversations]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || conversations.length >= total) return;
    loadConversations(conversations.length, { append: true });
  }, [conversations.length, loadingMore, total, loadConversations]);

  const toggleExpanded = (key) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const groups = groupConversationsByPerson(conversations);

  return (
    <div>
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && conversations.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">✳️</span>
          <strong>No Claude conversations captured yet</strong>
          <p>Open a chat at claude.ai through the dashboard launcher with the extension active - opening any existing conversation backfills its full history.</p>
        </div>
      )}

      {loading && conversations.length === 0 ? (
        <WorkspaceSkeleton variant="projects" />
      ) : conversations.length > 0 ? (
        <div className="claude-capture-person-groups">
          {groups.map((group) => {
            const isOpen = expandedKeys.has(group.key);
            return (
              <div key={group.key} className="claude-capture-person-group">
                <button
                  type="button"
                  className="claude-capture-person-group-head"
                  onClick={() => toggleExpanded(group.key)}
                  aria-expanded={isOpen}
                >
                  <span className="claude-capture-person-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="claude-capture-person-identity">
                    <strong>{group.ownerName}</strong>
                    <span className="claude-capture-person-meta">{group.ownerEmail || 'No profile on file'}</span>
                  </span>
                  <span className="claude-capture-person-stats">
                    <span className="chatgpt-capture-badge">{formatCount(group.conversationCount)} chat{group.conversationCount === 1 ? '' : 's'}</span>
                    <span className="chatgpt-capture-badge claude-capture-badge-accent">{formatCount(group.messageCount)} message{group.messageCount === 1 ? '' : 's'}</span>
                    <span className="claude-capture-person-last-active">Last active {formatRelativeTime(group.lastActiveAt ? new Date(group.lastActiveAt).toISOString() : null)}</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="claude-capture-conversation-list">
                    {group.conversations.map((conversation) => {
                      const healthMeta = getConversationHealthMeta(conversation.captureHealth);
                      return (
                        <button
                          key={conversation.id}
                          type="button"
                          className="claude-capture-conversation-row claude-capture-conversation-row-clickable"
                          onClick={() => setSelectedConversation(conversation)}
                        >
                          <span className={`claude-capture-conversation-status tone-${healthMeta.tone}`} title={healthMeta.label}>
                            {healthMeta.icon}
                          </span>
                          <span className="claude-capture-conversation-title">
                            {conversation.title || 'Untitled conversation'}
                            {conversation.lastMessagePreview && (
                              <span className="claude-capture-conversation-preview"> · {conversation.lastMessagePreview}</span>
                            )}
                          </span>
                          {conversation.modelLabel && (
                            <span className="chatgpt-capture-badge">{conversation.modelLabel}</span>
                          )}
                          <span className="chatgpt-capture-badge">
                            {formatCount((conversation.promptCount || 0) + (conversation.responseCount || 0))} msgs
                          </span>
                          <span className="claude-capture-conversation-when" title={conversation.lastActivityAt}>
                            {formatRelativeTime(conversation.lastActivityAt)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {loadingMore && <WorkspaceSkeleton variant="projects" />}
          {conversations.length < total && !loadingMore && (
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

      <ClaudeConversationDetailDrawer
        conversation={selectedConversation}
        onClose={() => setSelectedConversation(null)}
      />
    </div>
  );
}
