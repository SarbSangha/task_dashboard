import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { List } from 'react-window';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { useElementSize } from '../../../../../../hooks/useElementSize';
import { useDebouncedValue } from './useDebouncedValue';
import { usePinnedConversations } from './usePinnedConversations';
import { formatCount, formatRelativeTime, getHealthStatusMeta, normalizeApiError } from './chatgptCaptureUtils';

const CONVERSATION_PAGE_SIZE = 20;
const EVENT_TYPE_OPTIONS = [
  'conversation_opened',
  'conversation_created',
  'conversation_updated',
  'conversation_renamed',
  'conversation_archived',
  'conversation_deleted',
  'prompt_captured',
  'message_edited',
  'response_started',
  'response_completed',
  'generation_captured',
  'file_upload_detected',
  'file_download_detected',
];
const CONVERSATION_CARD_HEIGHT = 128;
const SORT_OPTIONS = [
  { key: 'recent', label: 'Most recent' },
  { key: 'messages', label: 'Most messages' },
];

function ConversationCard({ ariaAttributes, index, style, conversations, selectedConversationId, onSelect, isPinned, onTogglePin }) {
  const conversation = conversations[index];

  if (!conversation) {
    return (
      <div {...ariaAttributes} style={style} className="chatgpt-capture-conv-card-wrap">
        <div className="chatgpt-capture-conv-card loading" aria-hidden="true">
          <SkeletonBlock width="60%" height={14} />
          <SkeletonBlock width="90%" height={11} style={{ marginTop: 8 }} />
          <SkeletonBlock width="80%" height={11} style={{ marginTop: 6 }} />
        </div>
      </div>
    );
  }

  const isSelected = conversation.conversationId === selectedConversationId;
  const healthMeta = getHealthStatusMeta(conversation.captureHealth);
  const pinned = isPinned(conversation.conversationId);

  return (
    <div {...ariaAttributes} style={style} className="chatgpt-capture-conv-card-wrap">
      <button
        type="button"
        className={`chatgpt-capture-pin-btn${pinned ? ' pinned' : ''}`}
        aria-label={pinned ? 'Unpin conversation' : 'Pin conversation'}
        aria-pressed={pinned}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin(conversation.conversationId);
        }}
      >
        {pinned ? '★' : '☆'}
      </button>
      <button
        type="button"
        className={`chatgpt-capture-conv-card${isSelected ? ' selected' : ''}`}
        aria-current={isSelected ? 'true' : undefined}
        onClick={() => onSelect(conversation.conversationId, conversation.title)}
      >
        <div className="chatgpt-capture-conv-card-top">
          <span className="chatgpt-capture-conv-card-title">{conversation.title || conversation.conversationId}</span>
          <span className={`chatgpt-capture-health-dot tone-${healthMeta.tone}`} title={healthMeta.label} aria-hidden="true" />
        </div>

        {conversation.firstPromptPreview && (
          <p className="chatgpt-capture-conv-card-preview">
            <span className="chatgpt-capture-conv-card-preview-role">You:</span> {conversation.firstPromptPreview}
          </p>
        )}
        {conversation.lastResponsePreview && (
          <p className="chatgpt-capture-conv-card-preview">
            <span className="chatgpt-capture-conv-card-preview-role">ChatGPT:</span> {conversation.lastResponsePreview}
          </p>
        )}

        <div className="chatgpt-capture-conv-card-meta">
          {conversation.model && <span className="chatgpt-capture-chip">{conversation.model}</span>}
          <span>{formatCount(conversation.promptsCount + conversation.responsesCount)} msgs</span>
          {conversation.imagesCount > 0 && <span>🖼️ {conversation.imagesCount}</span>}
          {conversation.filesCount > 0 && <span>📄 {conversation.filesCount}</span>}
          <span className="chatgpt-capture-conv-card-time">{formatRelativeTime(conversation.lastSeenAt)}</span>
        </div>
      </button>
    </div>
  );
}

export default function ConversationListSidebar({ selectedConversationId, onSelectConversation, userId, userName, onBackToUsers }) {
  const { isPinned, togglePin } = usePinnedConversations();
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortKey, setSortKey] = useState('recent');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [captureVersionFilter, setCaptureVersionFilter] = useState('');
  const [extensionVersionFilter, setExtensionVersionFilter] = useState('');
  const [clientEventIdFilter, setClientEventIdFilter] = useState('');

  const [conversations, setConversations] = useState([]);
  const [conversationsTotal, setConversationsTotal] = useState(0);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [conversationsLoadingMore, setConversationsLoadingMore] = useState(false);
  const [conversationsError, setConversationsError] = useState('');

  const isAdvancedSearchActive = Boolean(
    captureVersionFilter.trim() || extensionVersionFilter.trim() || clientEventIdFilter.trim()
  );
  const [advancedResults, setAdvancedResults] = useState([]);
  const [advancedResultsTotal, setAdvancedResultsTotal] = useState(0);
  const [advancedResultsLoading, setAdvancedResultsLoading] = useState(false);
  const [advancedResultsError, setAdvancedResultsError] = useState('');

  const searchInputRef = useRef(null);
  const requestTokenRef = useRef(0);

  const baseFilters = useMemo(
    () => ({
      q: debouncedSearch.trim() || undefined,
      event_type: eventTypeFilter || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    }),
    [debouncedSearch, eventTypeFilter, dateFrom, dateTo]
  );

  const loadConversations = useCallback(
    async (offset, { append } = {}) => {
      const token = ++requestTokenRef.current;
      if (append) setConversationsLoadingMore(true);
      else setConversationsLoading(true);
      setConversationsError('');
      try {
        const response = userId
          ? await chatgptCaptureAPI.getUserConversations(userId, { ...baseFilters, limit: CONVERSATION_PAGE_SIZE, offset })
          : await chatgptCaptureAPI.listConversations({ ...baseFilters, limit: CONVERSATION_PAGE_SIZE, offset });
        if (token !== requestTokenRef.current) return;
        setConversations((prev) => (append ? [...prev, ...response.data] : response.data));
        setConversationsTotal(response.pagination?.total || 0);
      } catch (error) {
        if (token !== requestTokenRef.current) return;
        setConversationsError(normalizeApiError(error, 'Unable to load conversations.'));
      } finally {
        if (token === requestTokenRef.current) {
          setConversationsLoading(false);
          setConversationsLoadingMore(false);
        }
      }
    },
    [baseFilters, userId]
  );

  useEffect(() => {
    loadConversations(0, { append: false });
  }, [loadConversations]);

  const handleLoadMoreConversations = useCallback(() => {
    if (conversationsLoadingMore || conversations.length >= conversationsTotal) return;
    loadConversations(conversations.length, { append: true });
  }, [conversations.length, conversationsLoadingMore, conversationsTotal, loadConversations]);

  // Auto-select the first conversation once results arrive, so the center
  // panel isn't blank on first load.
  useEffect(() => {
    if (!selectedConversationId && conversations.length > 0 && !isAdvancedSearchActive) {
      onSelectConversation(conversations[0].conversationId);
    }
  }, [conversations, selectedConversationId, isAdvancedSearchActive, onSelectConversation]);

  const loadAdvancedResults = useCallback(async () => {
    setAdvancedResultsLoading(true);
    setAdvancedResultsError('');
    try {
      const response = await chatgptCaptureAPI.listEvents({
        ...baseFilters,
        user_id: userId || undefined,
        capture_version: captureVersionFilter.trim() ? Number(captureVersionFilter.trim()) : undefined,
        extension_version: extensionVersionFilter.trim() || undefined,
        client_event_id: clientEventIdFilter.trim() || undefined,
        limit: 50,
      });
      setAdvancedResults(response.data);
      setAdvancedResultsTotal(response.pagination?.total || 0);
    } catch (error) {
      setAdvancedResultsError(normalizeApiError(error, 'Unable to run this search.'));
    } finally {
      setAdvancedResultsLoading(false);
    }
  }, [baseFilters, userId, captureVersionFilter, extensionVersionFilter, clientEventIdFilter]);

  useEffect(() => {
    if (isAdvancedSearchActive) loadAdvancedResults();
  }, [isAdvancedSearchActive, loadAdvancedResults]);

  // Keyboard shortcuts: "/" focuses search, Escape clears it.
  useEffect(() => {
    const handleKeyDown = (event) => {
      const isTyping = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        searchInputRef.current?.focus();
      } else if (event.key === 'Escape' && document.activeElement === searchInputRef.current) {
        setSearchInput('');
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const sortedConversations = useMemo(() => {
    const base = sortKey !== 'messages'
      ? conversations
      : [...conversations].sort((a, b) => (b.promptsCount + b.responsesCount) - (a.promptsCount + a.responsesCount));
    // Pinned conversations float to the top of whatever the chosen sort
    // produced, same as Gmail's starred-first convention - within each group
    // (pinned / not pinned) the sort order above is preserved.
    return [...base].sort((a, b) => Number(isPinned(b.conversationId)) - Number(isPinned(a.conversationId)));
  }, [conversations, sortKey, isPinned]);

  const [listWrapRef, listSize] = useElementSize();

  const rowProps = useMemo(
    () => ({ conversations: sortedConversations, selectedConversationId, onSelect: onSelectConversation, isPinned, onTogglePin: togglePin }),
    [sortedConversations, selectedConversationId, onSelectConversation, isPinned, togglePin]
  );

  const rowCount = conversations.length < conversationsTotal ? conversations.length + 1 : conversations.length;

  const handleRowsRendered = useCallback(
    ({ stopIndex }) => {
      if (stopIndex >= rowCount - 2) handleLoadMoreConversations();
    },
    [handleLoadMoreConversations, rowCount]
  );

  return (
    <div className="chatgpt-capture-sidebar-panel">
      {userId && (
        <div className="chatgpt-capture-scoped-header">
          <button type="button" className="chatgpt-capture-back-btn" onClick={onBackToUsers}>
            ← All Users
          </button>
          <span className="chatgpt-capture-scoped-header-name">{userName ? `${userName}'s conversations` : 'Conversations'}</span>
        </div>
      )}
      <div className="chatgpt-capture-filter-bar">
        <input
          ref={searchInputRef}
          type="search"
          className="chatgpt-capture-search-input"
          aria-label="Search conversations by conversation, client event, or message id"
          placeholder="Search conversations... (press / to focus)"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
        <div className="chatgpt-capture-filter-row">
          <select
            className="chatgpt-capture-select"
            aria-label="Filter by event type"
            value={eventTypeFilter}
            onChange={(event) => setEventTypeFilter(event.target.value)}
          >
            <option value="">All event types</option>
            {EVENT_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>{type.replace(/_/g, ' ')}</option>
            ))}
          </select>
          <select
            className="chatgpt-capture-select"
            aria-label="Sort conversations"
            value={sortKey}
            onChange={(event) => setSortKey(event.target.value)}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.key} value={option.key}>{option.label}</option>
            ))}
          </select>
        </div>
        <div className="chatgpt-capture-date-filters">
          <label>
            <span>From</span>
            <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </label>
          <label>
            <span>To</span>
            <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </label>
        </div>
        <button
          type="button"
          className="chatgpt-capture-secondary-btn"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? 'Hide advanced' : 'Advanced search'}
        </button>
        {advancedOpen && (
          <div className="chatgpt-capture-advanced-filters">
            <input
              type="text"
              aria-label="Filter by capture version"
              placeholder="Capture version"
              value={captureVersionFilter}
              onChange={(event) => setCaptureVersionFilter(event.target.value)}
              inputMode="numeric"
            />
            <input
              type="text"
              aria-label="Filter by extension version"
              placeholder="Extension version"
              value={extensionVersionFilter}
              onChange={(event) => setExtensionVersionFilter(event.target.value)}
            />
            <input
              type="text"
              aria-label="Filter by client event id"
              placeholder="Client event id"
              value={clientEventIdFilter}
              onChange={(event) => setClientEventIdFilter(event.target.value)}
            />
          </div>
        )}
      </div>

      {isAdvancedSearchActive ? (
        <div className="chatgpt-capture-advanced-results">
          <span className="chatgpt-capture-panel-subhead">{advancedResultsTotal} matching event(s) - click to open its conversation</span>
          {advancedResultsError && <div className="chatgpt-capture-alert">{advancedResultsError}</div>}
          {advancedResultsLoading && (
            <div aria-hidden="true">
              {Array.from({ length: 4 }).map((_, index) => (
                <SkeletonBlock key={index} width="100%" height={40} style={{ marginBottom: 8 }} />
              ))}
            </div>
          )}
          {!advancedResultsLoading && advancedResults.map((event) => (
            <button
              key={event.id}
              type="button"
              className="chatgpt-capture-advanced-result-row"
              onClick={() => event.providerConversationId && onSelectConversation(event.providerConversationId)}
              disabled={!event.providerConversationId}
            >
              <span>{event.eventType}</span>
              <span className="chatgpt-capture-mono">{event.clientEventId}</span>
            </button>
          ))}
        </div>
      ) : (
        <>
          {conversationsError && <div className="chatgpt-capture-alert">{conversationsError}</div>}

          {!conversationsLoading && !conversationsError && conversations.length === 0 && (
            <div className="chatgpt-capture-empty-state compact">
              <strong>No conversations found</strong>
              <p>Try widening your filters, or open ChatGPT with the extension active to generate new capture events.</p>
            </div>
          )}

          {(conversations.length > 0 || conversationsLoading) && (
            <div className="chatgpt-capture-conv-list" ref={listWrapRef}>
              {listSize.width > 0 && listSize.height > 0 && (
                <List
                  className="chatgpt-capture-virtual-list"
                  rowComponent={ConversationCard}
                  rowProps={rowProps}
                  rowCount={Math.max(rowCount, conversationsLoading ? 6 : 0)}
                  rowHeight={CONVERSATION_CARD_HEIGHT}
                  onRowsRendered={handleRowsRendered}
                  overscanCount={4}
                  style={{ height: listSize.height, width: listSize.width }}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
