// src/services/sheetActivity.js
// Google Sheet edit history (Sheets -> Sheet Activity). Gated per user by the
// "sheet_activity" Section Access grant; see backend/routers/sheet_activity_router.py.

import api from './api';

const TIMEOUT_MS = 30000;

const clean = (params = {}) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const sheetActivityAPI = {
  list: async (params = {}) =>
    (await api.get('/api/sheet-activity', { params: clean(params), timeout: TIMEOUT_MS })).data,
  summary: async (params = {}) =>
    (await api.get('/api/sheet-activity/summary', { params: clean(params), timeout: TIMEOUT_MS })).data,
  options: async () => (await api.get('/api/sheet-activity/options', { timeout: TIMEOUT_MS })).data,
  exportCsv: async (params = {}) =>
    api.get('/api/sheet-activity/export.csv', { params: clean(params), responseType: 'blob', timeout: 300000 }),
};

export default sheetActivityAPI;
