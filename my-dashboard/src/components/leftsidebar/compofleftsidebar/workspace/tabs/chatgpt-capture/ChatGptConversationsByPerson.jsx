import { useCallback, useEffect, useRef, useState } from 'react';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { WorkspaceSkeleton } from '../../../../../ui/WorkspaceSkeleton';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ChatGptConversationDetailDrawer from './ChatGptConversationDetailDrawer';
import { formatCount, formatRelativeTime, getConversationHealthMeta, normalizeApiError } from './chatgptCaptureUtils';

const USER_PAGE_SIZE = 40;
const CONVERSATIONS_PER_PERSON = 100;

/**
 * The (only) browse view of the ChatGPT Capture Center - one collapsible
 * group per person, most-recently active first, expandable to that person's
 * individual conversations. Adopted from
 * claude-capture/ClaudeConversationsByPerson.jsx.
 *
 * ChatGPT's unfiltered /conversations endpoint carries no owner attribution
 * (see backend providers/chatgpt/queries.py's list_conversations - it groups
 * raw events, and 54 of 119 captured conversations have no ConversationRecord
 * at all), so the person groups come from /users (which does the person
 * rollup with the mid-thread fallback) and each group lazy-loads its own
 * conversations from /users/{id}/conversations on first expand.
 */
export default function ChatGptConversationsByPerson({ searchInput }) {
  const [users, setUsers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState(() => new Set());
  // userId -> { loading, error, items, total }
  const [conversationsByUser, setConversationsByUser] = useState(() => new Map());
  const [selectedConversationId, setSelectedConversationId] = useState(null);
  const requestTokenRef = useRef(0);

  const loadUsers = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      setError('');
      try {
        const response = await chatgptCaptureAPI.listUsers({
          q: (searchInput || '').trim() || undefined,
          sort: 'recent',
          limit: USER_PAGE_SIZE,
          offset,
        });
        if (token !== requestTokenRef.current) return;
        setUsers((prev) => (append ? [...prev, ...response.data] : response.data));
        setTotal(response.pagination?.total || 0);
      } catch (fetchError) {
        if (token !== requestTokenRef.current) return;
        setError(normalizeApiError(fetchError, 'Unable to load ChatGPT users.'));
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
    const timer = window.setTimeout(() => {
      setExpandedIds(new Set());
      setConversationsByUser(new Map());
      loadUsers(0, { append: false });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [loadUsers]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || users.length >= total) return;
    loadUsers(users.length, { append: true });
  }, [users.length, loadingMore, total, loadUsers]);

  const loadConversationsForUser = useCallback(async (userId) => {
    setConversationsByUser((prev) => {
      const next = new Map(prev);
      next.set(userId, { loading: true, error: '', items: [], total: 0 });
      return next;
    });
    try {
      const response = await chatgptCaptureAPI.getUserConversations(userId, { limit: CONVERSATIONS_PER_PERSON });
      setConversationsByUser((prev) => {
        const next = new Map(prev);
        next.set(userId, {
          loading: false,
          error: '',
          items: response.data || [],
          total: response.pagination?.total || (response.data || []).length,
        });
        return next;
      });
    } catch (fetchError) {
      setConversationsByUser((prev) => {
        const next = new Map(prev);
        next.set(userId, {
          loading: false,
          error: normalizeApiError(fetchError, 'Unable to load this person’s conversations.'),
          items: [],
          total: 0,
        });
        return next;
      });
    }
  }, []);

  const toggleExpanded = useCallback(
    (userId) => {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        if (next.has(userId)) {
          next.delete(userId);
        } else {
          next.add(userId);
          if (!conversationsByUser.has(userId)) loadConversationsForUser(userId);
        }
        return next;
      });
    },
    [conversationsByUser, loadConversationsForUser]
  );

  return (
    <div>
      {error && <div className="chatgpt-capture-alert">{error}</div>}

      {!loading && !error && users.length === 0 && (
        <div className="chatgpt-capture-empty-state">
          <span className="chatgpt-capture-empty-icon" aria-hidden="true">💬</span>
          <strong>No ChatGPT conversations captured yet</strong>
          <p>Open a chat at chatgpt.com through the dashboard launcher with the extension active - conversations show up here grouped by person.</p>
        </div>
      )}

      {loading && users.length === 0 ? (
        <WorkspaceSkeleton variant="projects" />
      ) : users.length > 0 ? (
        <div className="cgpt-person-groups">
          {users.map((user) => {
            const isOpen = expandedIds.has(user.userId);
            const bucket = conversationsByUser.get(user.userId);
            return (
              <div key={user.userId} className="cgpt-person-group">
                <button
                  type="button"
                  className="cgpt-person-group-head"
                  onClick={() => toggleExpanded(user.userId)}
                  aria-expanded={isOpen}
                >
                  <span className="cgpt-person-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                  <span className="cgpt-person-identity">
                    <strong>{user.name || 'Unattributed'}</strong>
                    <span className="cgpt-person-meta">{user.email || user.department || 'No profile on file'}</span>
                  </span>
                  <span className="cgpt-person-stats">
                    {user.hasUnresolvedConversations && (
                      <span
                        className="chatgpt-capture-badge tone-warning"
                        title="Some of this person's conversations couldn't be confirmed as theirs (captured mid-thread rather than at creation) - counts are a best-effort attribution."
                      >
                        Unconfirmed
                      </span>
                    )}
                    <span className="chatgpt-capture-badge">{formatCount(user.conversationsCount)} chat{user.conversationsCount === 1 ? '' : 's'}</span>
                    <span className="chatgpt-capture-badge cgpt-person-badge-accent">{formatCount(user.messagesCount)} message{user.messagesCount === 1 ? '' : 's'}</span>
                    <span className="cgpt-person-last-active">Last active {formatRelativeTime(user.lastActiveAt)}</span>
                  </span>
                </button>

                {isOpen && (
                  <div className="cgpt-person-conversation-list">
                    {bucket?.loading && (
                      <div style={{ padding: '12px 16px 12px 44px' }}>
                        <SkeletonBlock width="60%" height={12} />
                        <SkeletonBlock width="40%" height={12} style={{ marginTop: 8 }} />
                      </div>
                    )}
                    {bucket?.error && (
                      <div className="chatgpt-capture-alert" style={{ margin: '10px 16px' }}>{bucket.error}</div>
                    )}
                    {bucket && !bucket.loading && !bucket.error && bucket.items.length === 0 && (
                      <div style={{ padding: '12px 16px 12px 44px', fontSize: 12, color: 'var(--color-text-secondary)' }}>
                        No conversations captured for this person yet.
                      </div>
                    )}
                    {bucket?.items.map((conversation) => {
                      const healthMeta = getConversationHealthMeta(conversation.captureHealth);
                      const preview = conversation.lastResponsePreview || conversation.firstPromptPreview;
                      const msgs = (conversation.promptsCount || 0) + (conversation.responsesCount || 0);
                      return (
                        <button
                          key={conversation.conversationId}
                          type="button"
                          className="cgpt-person-conversation-row"
                          onClick={() => setSelectedConversationId(conversation.conversationId)}
                        >
                          <span className={`cgpt-person-conversation-status tone-${healthMeta.tone}`} title={healthMeta.label}>
                            {healthMeta.icon}
                          </span>
                          <span className="cgpt-person-conversation-title">
                            {conversation.title || 'Untitled conversation'}
                            {preview && <span className="cgpt-person-conversation-preview"> · {preview}</span>}
                          </span>
                          {conversation.model && <span className="chatgpt-capture-badge">{conversation.model}</span>}
                          <span className="chatgpt-capture-badge">{formatCount(msgs)} msgs</span>
                          <span className="cgpt-person-conversation-when" title={conversation.lastSeenAt}>
                            {formatRelativeTime(conversation.lastSeenAt)}
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
          {users.length < total && !loadingMore && (
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

      <ChatGptConversationDetailDrawer
        conversationId={selectedConversationId}
        onClose={() => setSelectedConversationId(null)}
      />
    </div>
  );
}
