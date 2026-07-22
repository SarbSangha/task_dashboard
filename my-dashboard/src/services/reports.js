// src/services/reports.js
// Reports / Business Intelligence API client.
// Reuses the shared axios instance (cookie auth + baseURL) from api.js.

import api from './api';

const REPORTS_TIMEOUT_MS = 30000;

const withParams = (params = {}, requestConfig = {}) => ({
  ...requestConfig,
  params: { ...(requestConfig.params || {}), ...params },
  timeout: requestConfig.timeout || REPORTS_TIMEOUT_MS,
});

export const reportsAPI = {
  filters: async (requestConfig = {}) => {
    const res = await api.get('/api/reports/filters', { timeout: REPORTS_TIMEOUT_MS, ...requestConfig });
    return res.data;
  },

  executive: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/executive', withParams(params, requestConfig));
    return res.data;
  },

  klingSummary: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/kling/summary', withParams(params, requestConfig));
    return res.data;
  },

  klingTrends: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/kling/trends', withParams(params, requestConfig));
    return res.data;
  },

  klingUsers: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/kling/users', withParams(params, requestConfig));
    return res.data;
  },

  klingAccounts: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/kling/accounts', withParams(params, requestConfig));
    return res.data;
  },

  klingTiming: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/kling/timing', withParams(params, requestConfig));
    return res.data;
  },

  klingFunnel: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/kling/funnel', withParams(params, requestConfig));
    return res.data;
  },

  chatgptSummary: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/chatgpt/summary', withParams(params, requestConfig));
    return res.data;
  },

  chatgptTrends: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/chatgpt/trends', withParams(params, requestConfig));
    return res.data;
  },

  chatgptUserTimeline: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/chatgpt/user-timeline', withParams(params, requestConfig));
    return res.data;
  },

  chatgptConversations: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/chatgpt/conversations', withParams(params, requestConfig));
    return res.data;
  },

  chatgptConversationMessages: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/chatgpt/conversation-messages', withParams(params, requestConfig));
    return res.data;
  },

  chatgptUsers: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/chatgpt/users', withParams(params, requestConfig));
    return res.data;
  },

  costSummary: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/cost/summary', withParams(params, requestConfig));
    return res.data;
  },

  costBreakdown: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/cost/breakdown', withParams(params, requestConfig));
    return res.data;
  },

  usersSummary: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/summary', withParams(params, requestConfig));
    return res.data;
  },

  usersActivityTrends: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/activity-trends', withParams(params, requestConfig));
    return res.data;
  },

  usersRetention: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/retention', withParams(params, requestConfig));
    return res.data;
  },

  usersActive: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/active', withParams(params, requestConfig));
    return res.data;
  },

  usersContributors: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/contributors', withParams(params, requestConfig));
    return res.data;
  },

  userGenerationTimeline: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/generation-timeline', withParams(params, requestConfig));
    return res.data;
  },

  userTimeline: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/timeline', withParams(params, requestConfig));
    return res.data;
  },

  userDay: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/day', withParams(params, requestConfig));
    return res.data;
  },

  usersPowerUsers: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/users/power-users', withParams(params, requestConfig));
    return res.data;
  },

  promptsSummary: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/summary', withParams(params, requestConfig));
    return res.data;
  },

  promptsContributors: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/contributors', withParams(params, requestConfig));
    return res.data;
  },

  promptsUserTimeline: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/user-timeline', withParams(params, requestConfig));
    return res.data;
  },

  promptsList: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/list', withParams(params, requestConfig));
    return res.data;
  },

  promptDetail: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/detail', withParams(params, requestConfig));
    return res.data;
  },

  promptsTrends: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/trends', withParams(params, requestConfig));
    return res.data;
  },

  promptsGolden: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/golden', withParams(params, requestConfig));
    return res.data;
  },

  promptsEngineers: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/prompts/engineers', withParams(params, requestConfig));
    return res.data;
  },

  tasksSummary: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/tasks/summary', withParams(params, requestConfig));
    return res.data;
  },

  tasksContributors: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/tasks/contributors', withParams(params, requestConfig));
    return res.data;
  },

  tasksTrends: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/tasks/trends', withParams(params, requestConfig));
    return res.data;
  },

  tasksBottlenecks: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/tasks/bottlenecks', withParams(params, requestConfig));
    return res.data;
  },

  tasksAiImpact: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/tasks/ai-impact', withParams(params, requestConfig));
    return res.data;
  },

  recommendations: async (params = {}, requestConfig = {}) => {
    const res = await api.get('/api/reports/recommendations', withParams(params, requestConfig));
    return res.data;
  },

  // ---- Credit rate admin (per Kling account) ----
  creditRatesList: async (requestConfig = {}) =>
    (await api.get('/api/reports/credit-rates', { timeout: REPORTS_TIMEOUT_MS, ...requestConfig })).data,
  creditRatesHistory: async (credentialId, requestConfig = {}) =>
    (await api.get('/api/reports/credit-rates/history', withParams(credentialId != null ? { credentialId } : {}, requestConfig))).data,
  creditRateUpsert: async (payload) =>
    (await api.post('/api/reports/credit-rates', payload, { timeout: REPORTS_TIMEOUT_MS })).data,
  creditRateDelete: async (rateId) =>
    (await api.delete(`/api/reports/credit-rates/${rateId}`, { timeout: REPORTS_TIMEOUT_MS })).data,

  // ---- Distribution layer ----
  emailSettings: async () => (await api.get('/api/reports/settings/email')).data,
  emailSettingsSave: async (payload) =>
    (await api.put('/api/reports/settings/email', payload, { timeout: REPORTS_TIMEOUT_MS })).data,
  emailSettingsTest: async (to) =>
    (await api.post('/api/reports/settings/email/test', { to }, { timeout: REPORTS_TIMEOUT_MS })).data,

  distributionCapabilities: async () => (await api.get('/api/reports/distribution/capabilities')).data,

  saveReport: async (payload) => (await api.post('/api/reports/library', payload, { timeout: REPORTS_TIMEOUT_MS })).data,
  listReports: async () => (await api.get('/api/reports/library')).data,
  getReport: async (id) => (await api.get(`/api/reports/library/${id}`)).data,
  deleteReport: async (id) => (await api.delete(`/api/reports/library/${id}`)).data,

  // One-click executive workbook (multi-sheet .xlsx). Returns the raw axios
  // blob response so callers can hand it to downloadBlobResponse(). Given a
  // longer timeout — the workbook is rendered server-side from live data.
  aiWorkbook: async (params = {}, requestConfig = {}) =>
    api.get('/api/reports/ai-workbook.xlsx', { params, responseType: 'blob', timeout: 120000, ...requestConfig }),

  exportSavedReport: async (id, format) =>
    api.get(`/api/reports/library/${id}/export`, { params: { format }, responseType: 'blob', timeout: REPORTS_TIMEOUT_MS }),
  exportAdhoc: async (payload) =>
    api.post('/api/reports/library/export', payload, { responseType: 'blob', timeout: REPORTS_TIMEOUT_MS }),

  createSchedule: async (payload) => (await api.post('/api/reports/schedules', payload, { timeout: REPORTS_TIMEOUT_MS })).data,
  listSchedules: async () => (await api.get('/api/reports/schedules')).data,
  deleteSchedule: async (id) => (await api.delete(`/api/reports/schedules/${id}`)).data,
  runDueSchedules: async () => (await api.post('/api/reports/schedules/run-due', {}, { timeout: REPORTS_TIMEOUT_MS })).data,

  listAudit: async () => (await api.get('/api/reports/audit')).data,
};

// Trigger a browser download from an axios blob response.
export const downloadBlobResponse = (res, fallbackName = 'report') => {
  const disp = res.headers?.['content-disposition'] || '';
  const match = /filename="?([^"]+)"?/.exec(disp);
  const name = match ? match[1] : fallbackName;
  const url = window.URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.URL.revokeObjectURL(url);
};

export default reportsAPI;
