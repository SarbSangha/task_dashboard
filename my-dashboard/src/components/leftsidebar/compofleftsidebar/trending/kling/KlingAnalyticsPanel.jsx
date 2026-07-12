import React, { useEffect, useState } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { generationRecordsAPI, generationRecoveryAPI } from '../../../../../services/api';
import './KlingAnalyticsPanel.css';

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="kling-analytics-tooltip">
      <div className="kling-analytics-tooltip-label">{formatShortDate(label)}</div>
      <div className="kling-analytics-tooltip-value">{payload[0].value} generations</div>
    </div>
  );
}

function DepartmentTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  return (
    <div className="kling-analytics-tooltip">
      <div className="kling-analytics-tooltip-label">{point.department}</div>
      <div className="kling-analytics-tooltip-value">{point.count} generations</div>
    </div>
  );
}

export default function KlingAnalyticsPanel() {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [recoveryAudit, setRecoveryAudit] = useState(null);
  const [recoveryLoading, setRecoveryLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    (async () => {
      try {
        const response = await generationRecordsAPI.getAnalytics();
        if (!cancelled) setAnalytics(response || null);
      } catch (fetchError) {
        if (!cancelled) {
          console.error('Failed to load Kling analytics:', fetchError);
          setError('Could not load analytics right now.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setRecoveryLoading(true);
    (async () => {
      try {
        const response = await generationRecoveryAPI.listAudits({ limit: 1 });
        const audits = Array.isArray(response?.data) ? response.data : [];
        if (!cancelled) setRecoveryAudit(audits[0] || null);
      } catch (fetchError) {
        console.warn('Failed to load recovery snapshot for analytics panel:', fetchError);
      } finally {
        if (!cancelled) setRecoveryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="kling-state">Loading analytics...</div>;
  }

  if (error) {
    return <div className="kling-state kling-state-error">{error}</div>;
  }

  if (!analytics) {
    return <div className="kling-state">No analytics data available.</div>;
  }

  const { dailyGenerations, departmentUsage, topUsers, topProjects, topTags, creditsSummary } = analytics;
  const totalGenerations = dailyGenerations.reduce((sum, point) => sum + point.count, 0);

  return (
    <div className="kling-analytics-panel">
      <div className="kling-analytics-tiles">
        <div className="kling-user-profile-stat kling-user-profile-stat-accent">
          <span>{totalGenerations}</span>
          <label>Generations (30d)</label>
        </div>
        <div className="kling-user-profile-stat">
          <span>{Math.round(creditsSummary?.total || 0)}</span>
          <label>Total Credits Burned</label>
        </div>
        <div className="kling-user-profile-stat">
          <span>{Math.round(creditsSummary?.last30Days || 0)}</span>
          <label>Credits (30d)</label>
        </div>
        <div className="kling-user-profile-stat">
          <span>{topUsers.length}</span>
          <label>Active Users</label>
        </div>
      </div>

      <div className="kling-analytics-charts">
        <div className="kling-analytics-chart-card">
          <h4>Daily Generations (last 30 days)</h4>
          {dailyGenerations.length === 0 ? (
            <p className="kling-drawer-future-note">No generations captured in this window.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={dailyGenerations} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="klingDailyFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="var(--kling-chart-series-1)" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="var(--kling-chart-series-1)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--kling-chart-grid)" vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatShortDate}
                  tick={{ fill: 'var(--kling-chart-axis-text)', fontSize: 11 }}
                  axisLine={{ stroke: 'var(--kling-chart-grid)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: 'var(--kling-chart-axis-text)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="count"
                  stroke="var(--kling-chart-series-1)"
                  strokeWidth={2}
                  fill="url(#klingDailyFill)"
                />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="kling-analytics-chart-card">
          <h4>Department Usage</h4>
          {departmentUsage.length === 0 ? (
            <p className="kling-drawer-future-note">No department data available.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={departmentUsage} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--kling-chart-grid)" vertical={false} />
                <XAxis
                  dataKey="department"
                  tick={{ fill: 'var(--kling-chart-axis-text)', fontSize: 11 }}
                  axisLine={{ stroke: 'var(--kling-chart-grid)' }}
                  tickLine={false}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: 'var(--kling-chart-axis-text)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={32}
                />
                <Tooltip content={<DepartmentTooltip />} cursor={{ fill: 'var(--kling-chart-grid)' }} />
                <Bar dataKey="count" fill="var(--kling-chart-series-1)" radius={[4, 4, 0, 0]} maxBarSize={48} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      <div className="kling-analytics-ranked-lists">
        <div className="kling-drawer-section">
          <h4>Top Users</h4>
          {topUsers.length ? (
            <ul className="kling-user-profile-list">
              {topUsers.map((user) => (
                <li key={user.userId}>
                  <span>{user.name || 'Unknown user'}</span>
                  <span>{user.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kling-drawer-future-note">No data yet.</p>
          )}
        </div>

        <div className="kling-drawer-section">
          <h4>Top Projects</h4>
          {topProjects.length ? (
            <ul className="kling-user-profile-list">
              {topProjects.map((project) => (
                <li key={project.projectId}>
                  <span>{project.name}</span>
                  <span>{project.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="kling-drawer-future-note">No projects yet.</p>
          )}
        </div>

        <div className="kling-drawer-section">
          <h4>Top Tags</h4>
          {topTags.length ? (
            <div className="kling-card-tags">
              {topTags.map((tagItem) => (
                <span key={tagItem.tag} className="kling-card-tag-chip">
                  {tagItem.tag} ({tagItem.count})
                </span>
              ))}
            </div>
          ) : (
            <p className="kling-drawer-future-note">No tags used yet.</p>
          )}
        </div>
      </div>

      <div className="kling-drawer-section">
        <h4>Recovery Snapshot</h4>
        {recoveryLoading && <p className="kling-drawer-future-note">Loading recovery data...</p>}
        {!recoveryLoading && !recoveryAudit && (
          <p className="kling-drawer-future-note">No reconciliation audits have been run yet.</p>
        )}
        {!recoveryLoading && recoveryAudit && (
          <div className="kling-analytics-tiles">
            <div className="kling-user-profile-stat">
              <span>{recoveryAudit.klingCount}</span>
              <label>Kling Count</label>
            </div>
            <div className="kling-user-profile-stat">
              <span>{recoveryAudit.databaseCount}</span>
              <label>Database Count</label>
            </div>
            <div className="kling-user-profile-stat">
              <span>{recoveryAudit.missingCount}</span>
              <label>Missing</label>
            </div>
            <div className="kling-user-profile-stat">
              <span>{recoveryAudit.importedCount}</span>
              <label>Recovered</label>
            </div>
          </div>
        )}
      </div>

      <div className="kling-drawer-section kling-drawer-future">
        <h4>Visual Similarity &amp; Duplicate Reduction</h4>
        <p className="kling-drawer-future-note">Coming in a future phase — requires image embeddings.</p>
      </div>
    </div>
  );
}
