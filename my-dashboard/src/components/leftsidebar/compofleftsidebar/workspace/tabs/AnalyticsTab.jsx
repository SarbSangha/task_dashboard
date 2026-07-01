import { useState } from 'react';
import CacheStatusBanner from '../../../../common/CacheStatusBanner';
import { WorkspaceSkeleton } from '../../../../ui/WorkspaceSkeleton';
import {
  formatTrendText,
  useWorkspaceAnalytics,
} from '../workspaceTabData';
import './AnalyticsTab.css';

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
    <div className="tab-content workspace-analytics">
      <div className="workspace-analytics-status-row">
        <div className="workspace-analytics-filter-group">
          {filters.map((filter) => (
            <button
              key={filter.key}
              type="button"
              className={`workspace-analytics-filter-btn ${filterKey === filter.key ? 'active' : ''}`}
              onClick={() => setFilterKey(filter.key)}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <CacheStatusBanner
          showingCached={cacheStatus.showingCached}
          isRefreshing={isRefreshing}
          cachedAt={cacheStatus.cachedAt}
          liveUpdatedAt={cacheStatus.liveUpdatedAt}
          refreshingLabel="Refreshing latest analytics source data..."
          liveLabel="Analytics source data is up to date"
          cachedLabel="Showing cached analytics source data"
          className="cache-status-banner--header"
        />
      </div>

      {taskError && <div className="workspace-analytics-alert">{taskError}</div>}
      {error && <div className="workspace-analytics-alert">{error}</div>}

      {(loading || tasksLoading) ? (
        <WorkspaceSkeleton variant="analytics" />
      ) : (
        <div className="workspace-analytics-grid">
          <div className="workspace-analytics-card">
            <h4>Task Completion Rate</h4>
            <div className="workspace-analytics-value">{`${analyticsData.completionRate}%`}</div>
            <div className={`workspace-analytics-trend ${analyticsData.completionTrend.direction}`}>
              {formatTrendText(analyticsData.completionTrend, '%', analyticsData.comparisonLabel)}
            </div>
          </div>
          <div className="workspace-analytics-card">
            <h4>Average Task Duration</h4>
            <div className="workspace-analytics-value">{`${analyticsData.averageTaskDuration} days`}</div>
            <div className={`workspace-analytics-trend ${analyticsData.durationTrend.direction}`}>
              {formatTrendText(analyticsData.durationTrend, ' days', analyticsData.comparisonLabel)}
            </div>
          </div>
          <div className="workspace-analytics-card">
            <h4>User Productivity</h4>
            <div className="workspace-analytics-value">{`${analyticsData.productivityScore}%`}</div>
            <div className={`workspace-analytics-trend ${analyticsData.productivityTrend.direction}`}>
              {formatTrendText(analyticsData.productivityTrend, '%', analyticsData.comparisonLabel)}
            </div>
          </div>
          <div className="workspace-analytics-card workspace-analytics-card-wide">
            <h4>{activeFilter.label} Snapshot</h4>
            <div className="workspace-analytics-mini-grid">
              <div className="workspace-analytics-mini-stat">
                <span>Total Tasks</span>
                <strong>{analyticsData.totalTasks}</strong>
              </div>
              <div className="workspace-analytics-mini-stat">
                <span>Completed</span>
                <strong>{analyticsData.completedTasks}</strong>
              </div>
              <div className="workspace-analytics-mini-stat">
                <span>Active</span>
                <strong>{analyticsData.activeTasks}</strong>
              </div>
            </div>
            {!analyticsData.totalTasks && (
              <p className="workspace-analytics-empty-state">
                No user tasks were updated in this time range yet. Switch the filter to see another period.
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
