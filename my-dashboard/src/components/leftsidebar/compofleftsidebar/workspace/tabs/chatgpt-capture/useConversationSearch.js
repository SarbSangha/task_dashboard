import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatgptCaptureAPI } from '../../../../../../services/api';
import { useDebouncedValue } from './useDebouncedValue';
import { usePinnedConversations } from './usePinnedConversations';
import { applyConversationFilters, DEFAULT_CONVERSATION_FILTERS } from './conversationFilterHelpers';
import { normalizeApiError } from './chatgptCaptureUtils';

const CONVERSATION_PAGE_SIZE = 20;

export const EVENT_TYPE_OPTIONS = [
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

export const SORT_OPTIONS = [
  { key: 'recent', label: 'Most recent' },
  { key: 'messages', label: 'Most messages' },
];

/**
 * All conversation search/filter/sort state and the data-fetching it drives,
 * extracted from ConversationListSidebar so the controls can render as a
 * full-width header above the list while the list itself stays in the
 * narrow sidebar column - both driven by this one shared hook.
 */
export function useConversationSearch({ userId, selectedConversationId, onSelectConversation }) {
  const { isPinned, togglePin } = usePinnedConversations();
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  const [eventTypeFilter, setEventTypeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [sortKey, setSortKey] = useState('recent');
  const [convFilters, setConvFilters] = useState(DEFAULT_CONVERSATION_FILTERS);
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

  const filtersActive = convFilters.type !== 'all' || convFilters.status !== 'any' || convFilters.time !== 'any';

  // Count every applied filter so a "narrowing is in effect" badge always has
  // an answer, even now that every control is permanently visible.
  const activeFilterCount =
    (eventTypeFilter ? 1 : 0)
    + (convFilters.type !== 'all' ? 1 : 0)
    + (convFilters.status !== 'any' ? 1 : 0)
    + (convFilters.time !== 'any' ? 1 : 0)
    + (dateFrom ? 1 : 0)
    + (dateTo ? 1 : 0)
    + (isAdvancedSearchActive ? 1 : 0);

  const handleResetAllFilters = useCallback(() => {
    setEventTypeFilter('');
    setConvFilters(DEFAULT_CONVERSATION_FILTERS);
    setDateFrom('');
    setDateTo('');
    setCaptureVersionFilter('');
    setExtensionVersionFilter('');
    setClientEventIdFilter('');
  }, []);

  const sortedConversations = useMemo(() => {
    const filtered = applyConversationFilters(conversations, convFilters);
    const base = sortKey !== 'messages'
      ? filtered
      : [...filtered].sort((a, b) => (b.promptsCount + b.responsesCount) - (a.promptsCount + a.responsesCount));
    // Pinned conversations float to the top of whatever the chosen sort
    // produced, same as Gmail's starred-first convention - within each group
    // (pinned / not pinned) the sort order above is preserved.
    return [...base].sort((a, b) => Number(isPinned(b.conversationId)) - Number(isPinned(a.conversationId)));
  }, [conversations, convFilters, sortKey, isPinned]);

  const handleFilterChange = useCallback((axis, key) => {
    setConvFilters((prev) => ({ ...prev, [axis]: key }));
  }, []);

  const hasMoreToLoad = conversations.length < conversationsTotal;
  const rowCount = sortedConversations.length + (hasMoreToLoad ? 1 : 0);

  return {
    // Search + filter controls (consumed by ConversationSearchHeader)
    searchInput,
    setSearchInput,
    searchInputRef,
    eventTypeFilter,
    setEventTypeFilter,
    dateFrom,
    setDateFrom,
    dateTo,
    setDateTo,
    sortKey,
    setSortKey,
    convFilters,
    handleFilterChange,
    advancedOpen,
    setAdvancedOpen,
    captureVersionFilter,
    setCaptureVersionFilter,
    extensionVersionFilter,
    setExtensionVersionFilter,
    clientEventIdFilter,
    setClientEventIdFilter,
    activeFilterCount,
    handleResetAllFilters,

    // List data + state (consumed by ConversationListSidebar)
    sortedConversations,
    conversations,
    conversationsTotal,
    conversationsLoading,
    conversationsLoadingMore,
    conversationsError,
    filtersActive,
    hasMoreToLoad,
    rowCount,
    handleLoadMoreConversations,
    isPinned,
    togglePin,

    // Advanced-search results (consumed by ConversationListSidebar)
    isAdvancedSearchActive,
    advancedResults,
    advancedResultsTotal,
    advancedResultsLoading,
    advancedResultsError,
  };
}
