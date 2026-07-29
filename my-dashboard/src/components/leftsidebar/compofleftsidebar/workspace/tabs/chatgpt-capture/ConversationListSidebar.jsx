import { useCallback, useMemo } from 'react';
import { List } from 'react-window';
import { SkeletonBlock } from '../../../../../ui/Skeleton';
import ConversationCard from './ConversationCard';
import { useElementSize } from '../../../../../../hooks/useElementSize';

// Sized for the compact card layout (icon+title row, up to a 2-line preview,
// time row) now that the message/image/file counts and tags moved behind the
// card's own ⋮ menu - the old 150px was tuned for that footer row and left a
// large empty gap under shorter cards once it was removed.
const CONVERSATION_CARD_HEIGHT = 120;

/**
 * The conversation list column itself - search/filter/sort state and the
 * fetching it drives now live in useConversationSearch (shared with
 * ConversationSearchHeader, which renders above this as a full-width bar).
 * This component only owns the virtualized list + advanced-search results.
 */
export default function ConversationListSidebar({
  selectedConversationId,
  onSelectConversation,
  userId,
  userName,
  onBackToUsers,
  search,
}) {
  const {
    sortedConversations,
    conversations,
    conversationsLoading,
    conversationsError,
    filtersActive,
    hasMoreToLoad,
    rowCount,
    handleLoadMoreConversations,
    isPinned,
    togglePin,
    handleResetAllFilters,
    isAdvancedSearchActive,
    advancedResults,
    advancedResultsTotal,
    advancedResultsLoading,
    advancedResultsError,
  } = search;

  const rowProps = useMemo(
    () => ({ conversations: sortedConversations, selectedConversationId, onSelect: onSelectConversation, isPinned, onTogglePin: togglePin, userName: userId ? userName : undefined }),
    [sortedConversations, selectedConversationId, onSelectConversation, isPinned, togglePin, userId, userName]
  );

  const handleRowsRendered = useCallback(
    ({ stopIndex }) => {
      if (stopIndex >= rowCount - 2) handleLoadMoreConversations();
    },
    [handleLoadMoreConversations, rowCount]
  );

  const [listWrapRef, listSize] = useElementSize();

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
              <span className="chatgpt-capture-empty-icon" aria-hidden="true">🗂️</span>
              <strong>No conversations captured yet</strong>
              <p>Open ChatGPT with the extension active, or widen your search, and captured conversations will appear here.</p>
            </div>
          )}

          {!conversationsLoading && conversations.length > 0 && sortedConversations.length === 0 && !hasMoreToLoad && filtersActive && (
            <div className="chatgpt-capture-empty-state compact">
              <strong>No conversations match these filters</strong>
              <p>Clear the filters, or scroll to load more conversations.</p>
              <button type="button" className="chatgpt-capture-secondary-btn" onClick={handleResetAllFilters}>
                Clear filters
              </button>
            </div>
          )}

          {(conversations.length > 0 || conversationsLoading) && !(conversations.length > 0 && sortedConversations.length === 0 && !hasMoreToLoad) && (
            <div className="chatgpt-capture-conv-list" ref={listWrapRef}>
              <List
                className="chatgpt-capture-virtual-list"
                rowComponent={ConversationCard}
                rowProps={rowProps}
                rowCount={Math.max(rowCount, conversationsLoading ? 6 : 0)}
                rowHeight={CONVERSATION_CARD_HEIGHT}
                onRowsRendered={handleRowsRendered}
                overscanCount={4}
                defaultHeight={480}
                style={{ height: listSize.height || '100%', width: listSize.width || '100%' }}
              />
            </div>
          )}
        </>
      )}
    </div>
  );
}
