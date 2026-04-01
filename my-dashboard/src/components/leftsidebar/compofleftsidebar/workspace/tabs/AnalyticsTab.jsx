import React, { useState } from 'react';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  formatTrendText,
  useWorkspaceAnalytics,
} from '../workspaceTabData';

export default function AnalyticsTab() {
  const [filterKey, setFilterKey] = useState('today');
  const {
    loading,
    tasksLoading,
    isRefreshing,
    taskError,
    cacheStatus,
    analyticsData,
    error,
    activeFilter,
    filters,
  } = useWorkspaceAnalytics(filterKey);

  return (
    <div className="tab-content">
      <div className="content-header analytics-header">
        <div className="analytics-header-copy">
          <h3>Analytics Dashboard</h3>
          <p className="analytics-subtitle">
            Live performance for the logged-in user, filtered by {activeFilter.label.toLowerCase()} activity.
          </p>
        </div>
        <div className="analytics-filter-group">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`analytics-filter-btn ${filterKey === filter.key ? 'active' : ''}`}
              onClick={() => setFilterKey(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </div>

      <CacheStatusBanner
        showingCached={cacheStatus.showingCached}
        isRefreshing={isRefreshing}
        cachedAt={cacheStatus.cachedAt}
        liveUpdatedAt={cacheStatus.liveUpdatedAt}
        refreshingLabel="Refreshing latest analytics source data..."
        liveLabel="Analytics source data is up to date"
        cachedLabel="Showing cached analytics source data"
      />

      {taskError && <div className="team-member-card">{taskError}</div>}
      {error && <div className="team-member-card">{error}</div>}

      {(loading || tasksLoading) ? (
        <WorkspaceSkeleton variant="analytics" />
      ) : (
        <div className="analytics-grid">
          <div className="analytics-card">
            <h4>Task Completion Rate</h4>
            <div className="analytics-value">{`${analyticsData.completionRate}%`}</div>
            <div className={`analytics-trend ${analyticsData.completionTrend.direction}`}>
              {formatTrendText(analyticsData.completionTrend, '%', analyticsData.comparisonLabel)}
            </div>
          </div>
          <div className="analytics-card">
            <h4>Average Task Duration</h4>
            <div className="analytics-value">{`${analyticsData.averageTaskDuration} days`}</div>
            <div className={`analytics-trend ${analyticsData.durationTrend.direction}`}>
              {formatTrendText(analyticsData.durationTrend, ' days', analyticsData.comparisonLabel)}
            </div>
          </div>
          <div className="analytics-card">
            <h4>User Productivity</h4>
            <div className="analytics-value">{`${analyticsData.productivityScore}%`}</div>
            <div className={`analytics-trend ${analyticsData.productivityTrend.direction}`}>
              {formatTrendText(analyticsData.productivityTrend, '%', analyticsData.comparisonLabel)}
            </div>
          </div>
          <div className="analytics-card analytics-card-wide">
            <h4>{activeFilter.label} Snapshot</h4>
            <div className="analytics-mini-grid">
              <div className="analytics-mini-stat">
                <span>Total Tasks</span>
                <strong>{analyticsData.totalTasks}</strong>
              </div>
              <div className="analytics-mini-stat">
                <span>Completed</span>
                <strong>{analyticsData.completedTasks}</strong>
              </div>
              <div className="analytics-mini-stat">
                <span>Active</span>
                <strong>{analyticsData.activeTasks}</strong>
              </div>
            </div>
            {!analyticsData.totalTasks && (
              <p className="analytics-empty-state">
                No user tasks were updated in this time range yet. Switch the filter to see another period.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
