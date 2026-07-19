// Report Builder v2 — data layer.
// Runs entirely from the bundled seed (analyticsLibrary.json). No backend.
// When a backend is wired in later, replace AVAILABLE_SOURCES with a live probe.

import raw from './analyticsLibrary.json';

export const library = raw;
export const enums = raw.enums;
export const readinessBadge = raw.enums.readinessBadge || { available: '✅', needs_capture: '🟡', future: '🔴' };

// Data sources that currently have data (drives report auto-disable).
// Grounded in the real schema; latency/asset/token sources do not exist yet.
export const AVAILABLE_SOURCES = new Set([
  'users', 'user_activities', 'tasks', 'chatgpt', 'tool_usage_events',
  'generation_records', 'credit_rates', 'tools', 'credentials', 'audit',
]);

export const questionsById = Object.fromEntries((raw.questions || []).map((q) => [q.id, q]));

export const dashboards = raw.dashboards || [];
export const dashboardsById = Object.fromEntries(dashboards.map((d) => [d.id, d]));

export const reportsById = {};
dashboards.forEach((d) => (d.reports || []).forEach((r) => {
  reportsById[r.id] = { ...r, dashboardId: d.id, domain: d.domain };
}));

export const isSourceAvailable = (s) => AVAILABLE_SOURCES.has(s);
export const isQuestionAnswerable = (q) => Array.isArray(q?.dataSources) && q.dataSources.every(isSourceAvailable);
export const missingSources = (q) => (q?.dataSources || []).filter((s) => !isSourceAvailable(s));

export const resolvedQuestions = (report) =>
  (report?.questionIds || []).map((id) => questionsById[id]).filter(Boolean);

export const reportSpecCount = (report) => ({
  total: (report?.questionIds || []).length,
  specified: resolvedQuestions(report).length,
});

// A report is "available" if it has at least one specified, answerable question.
export const reportAvailable = (report) => resolvedQuestions(report).some(isQuestionAnswerable);

export const locateQuestion = (id) => {
  const q = questionsById[id];
  if (!q) return null;
  return { question: q, dashboardId: q.dashboardId, reportId: q.reportId };
};

// All distinct tags, for the tag filter.
export const allTags = Array.from(
  new Set((raw.questions || []).flatMap((q) => q.tags || []))
).sort();

// Business value derived from priority tier (T1/T2 = High, T3 = Medium, else Low).
export const questionValue = (q) => (q.priorityTier <= 2 ? 'High' : q.priorityTier === 3 ? 'Medium' : 'Low');
export const reportValue = (report) => {
  const qs = resolvedQuestions(report);
  if (!qs.length) return null;
  const minTier = Math.min(...qs.map((q) => q.priorityTier));
  return minTier <= 2 ? 'High' : minTier === 3 ? 'Medium' : 'Low';
};

// Roll a report's questions up to a single product-status for the card badge.
const STATUS_RANK = { implemented: 0, available: 1, coming_soon: 2, planned: 3, deprecated: 4 };
export const reportStatus = (report) => {
  const qs = resolvedQuestions(report);
  if (!qs.length) return 'planned';
  return qs.map((q) => q.status).sort((a, b) => STATUS_RANK[a] - STATUS_RANK[b])[0];
};

// Distinct data sources a report/dashboard needs, each flagged available or not.
export const sourceChecklist = (questions) => {
  const set = new Set(questions.flatMap((q) => q.dataSources || []));
  return Array.from(set).sort().map((s) => ({ source: s, available: isSourceAvailable(s) }));
};

// Executive landing: top reports across all dashboards — available first, then by
// best (lowest) tier and implemented-ness. Used for "Recommended reports".
export const recommendedReports = (limit = 6) => {
  const all = [];
  dashboards.forEach((d) => (d.reports || []).forEach((r) => {
    const qs = resolvedQuestions(r);
    if (!qs.length) return;
    const available = reportAvailable(r);
    const minTier = Math.min(...qs.map((q) => q.priorityTier));
    const implemented = qs.some((q) => q.status === 'implemented');
    all.push({ report: r, dashboard: d, available, minTier, implemented });
  }));
  all.sort((a, b) =>
    (b.available - a.available) || (b.implemented - a.implemented) || (a.minTier - b.minTier));
  return all.slice(0, limit);
};

export const dashboardAvailability = (d) => {
  const reports = d.reports || [];
  return { total: reports.length, available: reports.filter(reportAvailable).length };
};
