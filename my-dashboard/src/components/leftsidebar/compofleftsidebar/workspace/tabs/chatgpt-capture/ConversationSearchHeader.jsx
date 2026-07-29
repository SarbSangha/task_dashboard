import ConversationFilters from './ConversationFilters';
import { EVENT_TYPE_OPTIONS, SORT_OPTIONS } from './useConversationSearch';

/**
 * Full-width search/filter header for the ChatGPT Capture conversation list -
 * moved up out of the narrow sidebar column so every control (search, sort,
 * event type, type/status/time, date range, advanced search) has room to sit
 * permanently visible instead of behind a collapsible "Filters" toggle.
 * Purely controlled: all state and handlers come from useConversationSearch.
 */
export default function ConversationSearchHeader({
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
}) {
  return (
    <div className="cgpt-search-header">
      <div className="cgpt-search-header-row">
        <input
          ref={searchInputRef}
          type="search"
          className="chatgpt-capture-search-input"
          aria-label="Search conversations by conversation, client event, or message id"
          placeholder="Search conversations... (press / to focus)"
          value={searchInput}
          onChange={(event) => setSearchInput(event.target.value)}
        />
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
        <label className="cgpt-search-header-date">
          <span>From</span>
          <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
        </label>
        <label className="cgpt-search-header-date">
          <span>To</span>
          <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
        </label>
        {activeFilterCount > 0 && (
          <button type="button" className="chatgpt-capture-filter-clear" onClick={handleResetAllFilters}>
            Clear all filters ({activeFilterCount})
          </button>
        )}
      </div>

      <div className="cgpt-search-header-row">
        <ConversationFilters filters={convFilters} onChange={handleFilterChange} />
        <button
          type="button"
          className="chatgpt-capture-secondary-btn"
          onClick={() => setAdvancedOpen((prev) => !prev)}
          aria-expanded={advancedOpen}
        >
          {advancedOpen ? 'Hide advanced' : 'Advanced search'}
        </button>
      </div>

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
  );
}
