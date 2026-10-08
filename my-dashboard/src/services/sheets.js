// src/services/sheets.js
// Sheets section: registered Google Sheets and their content requests.
// See backend/routers/sheets_router.py. Seeing the section is the "Sheets"
// Section Access grant; which sheets a person sees is the per-sheet assignment.

import api from './api';

const TIMEOUT_MS = 60000;

const clean = (params = {}) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== false));

export const sheetsAPI = {
  list: async () => (await api.get('/api/sheets', { timeout: TIMEOUT_MS })).data,
  get: async (id) => (await api.get(`/api/sheets/${id}`, { timeout: TIMEOUT_MS })).data,
  inspect: async (url) => (await api.post('/api/sheets/inspect', { url }, { timeout: 120000 })).data,
  create: async (payload) => (await api.post('/api/sheets', payload, { timeout: 120000 })).data,
  update: async (id, payload) => (await api.patch(`/api/sheets/${id}`, payload, { timeout: TIMEOUT_MS })).data,
  remove: async (id) => (await api.delete(`/api/sheets/${id}`, { timeout: TIMEOUT_MS })).data,
  setMembers: async (id, userIds) => (await api.put(`/api/sheets/${id}/members`, { userIds }, { timeout: TIMEOUT_MS })).data,
  sync: async (id) => (await api.post(`/api/sheets/${id}/sync`, {}, { timeout: 120000 })).data,
  // Admin Queue -> Sheet Access: per-sheet, per-person permissions.
  accessOverview: async () => (await api.get('/api/sheets/access', { timeout: TIMEOUT_MS })).data,
  setAccess: async (id, userId, access) =>
    (await api.put(`/api/sheets/${id}/access/${userId}`, access, { timeout: TIMEOUT_MS })).data,
  people: async () => (await api.get('/api/sheets/people', { timeout: TIMEOUT_MS })).data,
  setGoogleEmail: async (userId, googleEmail) =>
    (await api.put(`/api/sheets/people/${userId}/google-email`, { googleEmail }, { timeout: TIMEOUT_MS })).data,
  overview: async (id, tab) => (await api.get(`/api/sheets/${id}/overview`, { params: clean({ tab }), timeout: TIMEOUT_MS })).data,
  requests: async (id, params = {}) =>
    (await api.get(`/api/sheets/${id}/requests`, { params: clean(params), timeout: TIMEOUT_MS })).data,
  request: async (id, requestId) => (await api.get(`/api/sheets/${id}/requests/${requestId}`, { timeout: TIMEOUT_MS })).data,
  requestsCsv: async (id, params = {}) =>
    api.get(`/api/sheets/${id}/requests.csv`, { params: clean(params), responseType: 'blob', timeout: 300000 }),
  eventsCsv: async (id, params = {}) =>
    api.get(`/api/sheets/${id}/events.csv`, { params: clean(params), responseType: 'blob', timeout: 300000 }),

  // keyword_ranking sheets
  rankingOverview: async (id, tab) =>
    (await api.get(`/api/sheets/${id}/ranking/overview`, { params: clean({ tab }), timeout: TIMEOUT_MS })).data,
  rankingKeywords: async (id, params = {}) =>
    (await api.get(`/api/sheets/${id}/ranking/keywords`, { params: clean(params), timeout: TIMEOUT_MS })).data,
  rankingKeyword: async (id, keywordId) =>
    (await api.get(`/api/sheets/${id}/ranking/keywords/${keywordId}`, { timeout: TIMEOUT_MS })).data,
  rankingRuns: async (id, tab) =>
    (await api.get(`/api/sheets/${id}/ranking/runs`, { params: clean({ tab }), timeout: TIMEOUT_MS })).data,
  rankingAlerts: async (id, tab) =>
    (await api.get(`/api/sheets/${id}/ranking/alerts`, { params: clean({ tab }), timeout: TIMEOUT_MS })).data,
  rankingContributors: async (id, tab) =>
    (await api.get(`/api/sheets/${id}/ranking/contributors`, { params: clean({ tab }), timeout: TIMEOUT_MS })).data,
  rankingKeywordsCsv: async (id, params = {}) =>
    api.get(`/api/sheets/${id}/ranking/keywords.csv`, { params: clean(params), responseType: 'blob', timeout: 300000 }),
  rankingHistoryCsv: async (id, params = {}) =>
    api.get(`/api/sheets/${id}/ranking/history.csv`, { params: clean(params), responseType: 'blob', timeout: 300000 }),
};

export default sheetsAPI;
