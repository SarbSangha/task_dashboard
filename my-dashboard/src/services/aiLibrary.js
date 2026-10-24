// src/services/aiLibrary.js
// AI Library: drag-and-drop uploads straight to the connected Google Drive.
// Gated per user by the "ai_library" Section Access grant; see
// backend/routers/ai_library_router.py. The file bytes go to Drive directly
// (utils/driveResumableUpload.js) - only metadata goes through these calls.

import api from './api';

const TIMEOUT_MS = 30000;

const clean = (params = {}) =>
  Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export const aiLibraryAPI = {
  status: async () => (await api.get('/api/ai-library/status', { timeout: TIMEOUT_MS })).data,
  connectUrl: async () => (await api.get('/api/ai-library/google/connect', { timeout: TIMEOUT_MS })).data,
  disconnect: async () => (await api.post('/api/ai-library/google/disconnect', null, { timeout: TIMEOUT_MS })).data,

  // Folder creation on Drive can take a few round trips the first time a
  // day / user / client is used, so this gets a longer timeout.
  createUpload: async (payload) => (await api.post('/api/ai-library/uploads', payload, { timeout: 60000 })).data,
  completeUpload: async (uploadId, driveFileId) =>
    (await api.post(`/api/ai-library/uploads/${uploadId}/complete`, { driveFileId }, { timeout: TIMEOUT_MS })).data,
  failUpload: async (uploadId, error) =>
    (await api.post(`/api/ai-library/uploads/${uploadId}/fail`, { error }, { timeout: TIMEOUT_MS })).data,

  list: async (params = {}) =>
    (await api.get('/api/ai-library/uploads', { params: clean(params), timeout: TIMEOUT_MS })).data,
  options: async () => (await api.get('/api/ai-library/uploads/options', { timeout: TIMEOUT_MS })).data,
};

export default aiLibraryAPI;
