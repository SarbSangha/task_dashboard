import React from 'react';

export default function KlingFilterBar({
  searchInput,
  onSearchInputChange,
  departmentFilter,
  departmentOptions,
  onDepartmentChange,
  modelFilter,
  modelOptions,
  onModelChange,
  resolutionFilter,
  resolutionOptions,
  onResolutionChange,
  ownershipFilter,
  onOwnershipChange,
  favoritesOnly,
  onToggleFavoritesOnly,
  tagFilter,
  tagOptions,
  onTagFilterChange,
  datePreset,
  datePresets,
  onDatePresetChange,
  sortBy,
  onSortChange,
  projectFilter,
  onClearProjectFilter,
  collectionFilter,
  onClearCollectionFilter,
  onViewTimeline,
  allDepartmentsValue,
  allModelsValue,
  allResolutionsValue,
  allOwnershipValue,
}) {
  return (
    <div className="kling-filter-bar">
      <div className="kling-filter-bar-row">
        <input
          className="trendings-search kling-search"
          placeholder='Search prompts, models, users, projects... (try department:Marketing status:resolved)'
          value={searchInput}
          onChange={(event) => onSearchInputChange(event.target.value)}
        />
        {projectFilter && (
          <div className="kling-active-project-chip">
            <span>Project: {projectFilter.name}</span>
            <button type="button" className="kling-active-chip-timeline" onClick={onViewTimeline}>
              View Timeline
            </button>
            <button type="button" onClick={onClearProjectFilter} aria-label="Clear project filter">
              &times;
            </button>
          </div>
        )}
        {collectionFilter && (
          <div className="kling-active-project-chip">
            <span>Collection: {collectionFilter.name}</span>
            <button type="button" onClick={onClearCollectionFilter} aria-label="Clear collection filter">
              &times;
            </button>
          </div>
        )}
      </div>

      <div className="trendings-select-filters kling-select-filters">
        <label className="trendings-filter-select-wrap">
          <span className="trendings-filter-select-label">Department</span>
          <select
            className="trendings-filter-select"
            value={departmentFilter}
            onChange={(event) => onDepartmentChange(event.target.value)}
          >
            {departmentOptions.map((department) => (
              <option key={department} value={department}>
                {department === allDepartmentsValue ? 'All Departments' : department}
              </option>
            ))}
          </select>
        </label>

        <label className="trendings-filter-select-wrap">
          <span className="trendings-filter-select-label">Model</span>
          <select
            className="trendings-filter-select"
            value={modelFilter}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value={allModelsValue}>All Models</option>
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>

        <label className="trendings-filter-select-wrap">
          <span className="trendings-filter-select-label">Resolution</span>
          <select
            className="trendings-filter-select"
            value={resolutionFilter}
            onChange={(event) => onResolutionChange(event.target.value)}
          >
            <option value={allResolutionsValue}>All Resolutions</option>
            {resolutionOptions.map((resolution) => (
              <option key={resolution} value={resolution}>
                {resolution}
              </option>
            ))}
          </select>
        </label>

        <label className="trendings-filter-select-wrap">
          <span className="trendings-filter-select-label">Ownership</span>
          <select
            className="trendings-filter-select"
            value={ownershipFilter}
            onChange={(event) => onOwnershipChange(event.target.value)}
          >
            <option value={allOwnershipValue}>All</option>
            <option value="resolved">Resolved</option>
            <option value="unknown">Unknown</option>
          </select>
        </label>

        <label className="trendings-filter-select-wrap">
          <span className="trendings-filter-select-label">Date</span>
          <select
            className="trendings-filter-select"
            value={datePreset}
            onChange={(event) => onDatePresetChange(event.target.value)}
          >
            {datePresets.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
        </label>

        <label className="trendings-filter-select-wrap">
          <span className="trendings-filter-select-label">Tag</span>
          <input
            className="trendings-filter-select kling-tag-filter-input"
            list="kling-tag-filter-options"
            placeholder="Any tag"
            value={tagFilter}
            onChange={(event) => onTagFilterChange(event.target.value)}
          />
          <datalist id="kling-tag-filter-options">
            {tagOptions.map((tagOption) => (
              <option key={tagOption} value={tagOption} />
            ))}
          </datalist>
        </label>
      </div>

      <div className="trendings-sort-group kling-toggle-group">
        <button
          type="button"
          className={`trendings-sort-btn ${favoritesOnly ? 'active' : ''}`}
          onClick={onToggleFavoritesOnly}
        >
          &#9733; Favorites
        </button>
        <button
          type="button"
          className={`trendings-sort-btn ${sortBy === 'latest' ? 'active' : ''}`}
          onClick={() => onSortChange('latest')}
        >
          Latest
        </button>
        <button
          type="button"
          className={`trendings-sort-btn ${sortBy === 'oldest' ? 'active' : ''}`}
          onClick={() => onSortChange('oldest')}
        >
          Oldest
        </button>
        <button
          type="button"
          className={`trendings-sort-btn ${sortBy === 'credits' ? 'active' : ''}`}
          onClick={() => onSortChange('credits')}
        >
          Most Credits
        </button>
      </div>
    </div>
  );
}
