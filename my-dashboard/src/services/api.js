// src/services/api.js - UNIFIED API SERVICE
import axios from 'axios';
import { buildUploadFormData, getFileRelativePath } from '../utils/fileUploads';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const SESSION_TOKEN_STORAGE_KEY = 'rmw_session_token_v1';
const SESSION_TOKEN_REMEMBER_KEY = 'rmw_session_token_remember_v1';
const REQUEST_TIMEOUT_MS = 15000;
const AUTH_REQUEST_TIMEOUT_MS = 30000;
const BACKGROUND_REQUEST_TIMEOUT_MS = 8000;
const PRESIGN_TIMEOUT_MS = 30000;
const DIRECT_UPLOAD_CONCURRENCY = 2;
const DIRECT_UPLOAD_PART_CONCURRENCY = 3;
const LEGACY_UPLOAD_FALLBACK_MAX_BYTES = 90 * 1024 * 1024;
const DIRECT_UPLOAD_RETRY_COUNT = 2;
const DIRECT_UPLOAD_RETRY_BASE_DELAY_MS = 1200;

const canUseBrowserStorage = () => typeof window !== 'undefined';

const getStoredSessionToken = () => {
  if (!canUseBrowserStorage()) return '';
  return (
    window.localStorage.getItem(SESSION_TOKEN_STORAGE_KEY)
    || window.sessionStorage.getItem(SESSION_TOKEN_STORAGE_KEY)
    || ''
  );
};

const storeSessionToken = (token, rememberMe = false) => {
  if (!canUseBrowserStorage()) return;
  const normalized = `${token || ''}`.trim();
  window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(SESSION_TOKEN_REMEMBER_KEY);

  if (!normalized) return;

  const targetStorage = rememberMe ? window.localStorage : window.sessionStorage;
  targetStorage.setItem(SESSION_TOKEN_STORAGE_KEY, normalized);
  window.localStorage.setItem(SESSION_TOKEN_REMEMBER_KEY, rememberMe ? '1' : '0');
};

const clearStoredSessionToken = () => {
  if (!canUseBrowserStorage()) return;
  window.localStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  window.sessionStorage.removeItem(SESSION_TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(SESSION_TOKEN_REMEMBER_KEY);
};

// ==================== SINGLE AXIOS INSTANCE ====================
const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,  // ✅ Use cookies for auth
  timeout: REQUEST_TIMEOUT_MS,
  headers: {
    'Content-Type': 'application/json'
  }
});

const mergeRequestConfig = (baseConfig = {}, requestConfig = {}) => ({
  ...baseConfig,
  ...requestConfig,
  headers: {
    ...(baseConfig.headers || {}),
    ...(requestConfig.headers || {}),
  },
  params: {
    ...(baseConfig.params || {}),
    ...(requestConfig.params || {}),
  },
});

const REQUEST_CONFIG_KEYS = new Set([
  'adapter',
  'auth',
  'baseURL',
  'headers',
  'onDownloadProgress',
  'onUploadProgress',
  'params',
  'responseType',
  'signal',
  'timeout',
  'transformRequest',
  'transformResponse',
  'withCredentials',
]);

const isRequestConfigLike = (value) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).some((key) => REQUEST_CONFIG_KEYS.has(key));

const buildParamRequestConfig = (paramsOrConfig = {}, requestConfig = {}) => {
  if (isRequestConfigLike(paramsOrConfig)) {
    return paramsOrConfig;
  }

  return mergeRequestConfig({ params: paramsOrConfig }, requestConfig);
};

const isBrowserFile = (value) => typeof File !== 'undefined' && value instanceof File;

const toUploadFiles = (files = []) => files.filter((file) => isBrowserFile(file));

const buildPresignPayload = (files = []) => ({
  files: files.map((file) => ({
    name: file.name,
    size: Number.isFinite(file.size) ? file.size : 0,
    contentType: file.type || 'application/octet-stream',
    relativePath: getFileRelativePath(file) || null,
  })),
});

const emitLegacyUploadProgress = (progressEvent, onProgress) => {
  if (typeof onProgress !== 'function') return;
  const total = Math.max(progressEvent?.total || 0, 1);
  const loaded = Math.min(progressEvent?.loaded || 0, total);
  const percent = Math.min(100, Math.round((loaded * 100) / total));
  onProgress(percent, { loaded, total });
};

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const createProgressTracker = (files, { onProgress, onFileProgress } = {}) => {
  const fileTotals = files.map((file) => Math.max(file?.size || 0, 1));
  const loadedByFile = new Array(files.length).fill(0);
  const aggregateTotal = Math.max(
    fileTotals.reduce((sum, value) => sum + value, 0),
    1
  );

  const emitAggregate = (fileIndex) => {
    if (typeof onProgress !== 'function') return;
    const loaded = loadedByFile.reduce((sum, value) => sum + value, 0);
    const percent = Math.min(100, Math.round((loaded * 100) / aggregateTotal));
    onProgress(percent, { loaded, total: aggregateTotal, fileIndex });
  };

  return {
    update(fileIndex, loaded) {
      const total = fileTotals[fileIndex] || 1;
      const safeLoaded = Math.min(Math.max(loaded || 0, 0), total);
      loadedByFile[fileIndex] = safeLoaded;
      if (typeof onFileProgress === 'function') {
        onFileProgress({
          fileIndex,
          file: files[fileIndex],
          loaded: safeLoaded,
          total,
          percent: Math.min(100, Math.round((safeLoaded * 100) / total)),
        });
      }
      emitAggregate(fileIndex);
    },
    complete(fileIndex) {
      this.update(fileIndex, fileTotals[fileIndex] || 1);
    },
  };
};

const runWithConcurrency = async (tasks, concurrency = DIRECT_UPLOAD_CONCURRENCY) => {
  const results = new Array(tasks.length);
  let nextIndex = 0;

  const worker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= tasks.length) {
        return;
      }
      results[currentIndex] = await tasks[currentIndex]();
    }
  };

  const workerCount = Math.min(Math.max(concurrency, 1), tasks.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
};

const withUploadRetry = async (fn, retryCount = DIRECT_UPLOAD_RETRY_COUNT) => {
  let attempt = 0;
  let lastError = null;

  while (attempt <= retryCount) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const status = error?.response?.status;
      const isRetryableStatus = !status || status >= 500 || status === 408 || status === 429;
      if (attempt >= retryCount || !isRetryableStatus || isRequestCanceled(error)) {
        break;
      }
      const delayMs = DIRECT_UPLOAD_RETRY_BASE_DELAY_MS * (attempt + 1);
      await sleep(delayMs);
      attempt += 1;
    }
  }

  throw lastError;
};

const shouldUseLegacyUploadFallback = (files, error, options = {}) => {
  const isLocalApi = /localhost|127\.0\.0\.1/i.test(API_URL);
  if (options.allowLegacyFallback !== true && !isLocalApi) return false;
  if (options.allowLegacyFallback === false) return false;
  if (isRequestCanceled(error)) return false;
  const status = error?.response?.status;
  if ([401, 403, 422].includes(status)) return false;
  return files.every((file) => (file?.size || 0) <= LEGACY_UPLOAD_FALLBACK_MAX_BYTES);
};

const uploadFilesLegacy = async (files, options = {}) => {
  const formData = buildUploadFormData(files);
  const response = await api.post('/upload', formData, {
    headers: {
      'Content-Type': 'multipart/form-data',
    },
    signal: options.signal,
    timeout: 0,
    onUploadProgress: (progressEvent) => emitLegacyUploadProgress(progressEvent, options.onProgress),
  });

  return response.data;
};

const uploadFileDirectToR2 = async (file, target, tracker, fileIndex) => {
  const contentType = file.type || target?.headers?.['Content-Type'] || 'application/octet-stream';

  await withUploadRetry(async () => {
    await axios.put(target.uploadUrl, file, {
      headers: {
        'Content-Type': contentType,
      },
      signal: target?.signal,
      timeout: 0,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      onUploadProgress: (progressEvent) => {
        const loaded = progressEvent?.loaded ?? file.size ?? 0;
        tracker.update(fileIndex, loaded);
      },
    });
  });

  tracker.complete(fileIndex);
  return target.attachment;
};

const abortMultipartUpload = async (target) => {
  if (!target?.key || !target?.uploadId) return;
  try {
    await api.post(
      '/api/uploads/multipart/abort',
      {
        key: target.key,
        uploadId: target.uploadId,
      },
      { timeout: PRESIGN_TIMEOUT_MS }
    );
  } catch (error) {
    console.warn('Multipart upload abort failed:', error);
  }
};

const uploadFileMultipartToR2 = async (file, target, tracker, fileIndex, options = {}) => {
  const parts = Array.isArray(target?.parts) ? target.parts : [];
  const partSize = Math.max(Number(target?.partSize) || 0, 5 * 1024 * 1024);
  if (!target?.uploadId || !target?.key || parts.length === 0) {
    throw new Error(`Multipart upload target is incomplete for "${file.name}".`);
  }

  const partLoaded = new Array(parts.length).fill(0);
  const emitLoaded = () => {
    const loaded = partLoaded.reduce((sum, value) => sum + value, 0);
    tracker.update(fileIndex, loaded);
  };

  const tasks = parts.map((part, index) => async () => {
    const partNumber = Number(part?.partNumber) || (index + 1);
    const start = (partNumber - 1) * partSize;
    const end = Math.min(file.size, start + partSize);
    const blob = file.slice(start, end);
    const uploadedPart = await withUploadRetry(async () => {
      const response = await axios.put(part.uploadUrl, blob, {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        signal: options.signal,
        timeout: 0,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        onUploadProgress: (progressEvent) => {
          partLoaded[index] = Math.min(blob.size, progressEvent?.loaded ?? blob.size);
          emitLoaded();
        },
      });
      const etag = response?.headers?.etag || response?.headers?.ETag;
      if (!etag) {
        throw new Error(`Missing ETag for uploaded part ${partNumber} of "${file.name}".`);
      }
      partLoaded[index] = blob.size;
      emitLoaded();
      return {
        partNumber,
        etag,
      };
    });

    return uploadedPart;
  });

  try {
    const uploadedParts = await runWithConcurrency(
      tasks,
      options.partConcurrency || DIRECT_UPLOAD_PART_CONCURRENCY
    );
    await api.post(
      '/api/uploads/multipart/complete',
      {
        key: target.key,
        uploadId: target.uploadId,
        parts: uploadedParts,
      },
      {
        signal: options.signal,
        timeout: PRESIGN_TIMEOUT_MS,
      }
    );
    tracker.complete(fileIndex);
    return target.attachment;
  } catch (error) {
    await abortMultipartUpload(target);
    throw error;
  }
};

const buildUploadError = (error) => {
  if (isRequestCanceled(error)) {
    error.message = error?.message || 'Upload canceled.';
    return error;
  }
  if (error?.response?.data?.detail) {
    return error;
  }

  const status = error?.response?.status;
  if (status === 401) {
    error.message = 'Your session expired. Please sign in again and retry the upload.';
    return error;
  }
  if (status === 413) {
    error.message = 'Upload rejected by a proxy size limit before it reached storage.';
    return error;
  }
  if (status === 400 && !error?.response?.data?.detail && error?.message) {
    return error;
  }
  if (!status) {
    error.message = 'Direct upload to storage failed. Check the R2 bucket CORS rules for PUT requests from this dashboard origin.';
  }
  return error;
};

export const isRequestCanceled = (error) =>
  axios.isCancel(error) || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError';

api.interceptors.request.use((config) => {
  const sessionToken = getStoredSessionToken();
  if (sessionToken) {
    config.headers = config.headers || {};
    if (!config.headers['X-Session-Id']) {
      config.headers['X-Session-Id'] = sessionToken;
    }
  }
  return config;
});

// ==================== RESPONSE INTERCEPTOR ====================
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      const requestUrl = `${error.config?.url || ''}`;
      const isActivityCall = requestUrl.includes('/api/activity/');
      if (isActivityCall) {
        console.warn(`⚠️ 401 on activity endpoint (${requestUrl}) - skipping global auth redirect`);
        return Promise.reject(error);
      }

      // With HashRouter, route lives in location.hash (e.g. "#/login").
      const routePath = (window.location.hash || window.location.pathname || '')
        .replace(/^#/, '')
        .split('?')[0];
      const publicPaths = ['/login', '/register', '/forgot-password', '/reset-password'];
      if (!publicPaths.includes(routePath)) {
        clearStoredSessionToken();
        console.log(`❌ 401 Unauthorized (${requestUrl}) - redirecting to login`);
        window.location.href = '/#/login';
      }
    }
    return Promise.reject(error);
  }
);

// ==================== AUTH API ====================
export const authAPI = {
  register: async (email, password, name, position, department) => {
    const response = await api.post('/api/auth/register', { 
      email, 
      password, 
      name,
      position,
      department
    });
    return response.data;
  },

  login: async (email, password, rememberMe = false) => {
    const response = await api.post('/api/auth/login', {
      email,
      password,
      remember_me: rememberMe
    }, {
      timeout: AUTH_REQUEST_TIMEOUT_MS,
    });
    if (response.data?.sessionToken) {
      storeSessionToken(response.data.sessionToken, rememberMe);
    }
    return response.data;
  },

  logout: async () => {
    try {
      const response = await api.post('/api/auth/logout');
      return response.data;
    } finally {
      clearStoredSessionToken();
    }
  },

  getCurrentUser: async () => {
    const response = await api.get('/api/auth/me', {
      timeout: AUTH_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },

  getAvatar: async () => {
    const response = await api.get('/api/auth/avatar');
    return response.data;
  },

  uploadAvatar: async (base64Image) => {
    const response = await api.post('/api/auth/avatar', { avatar: base64Image });
    return response.data;
  },

  updateProfile: async (name, avatar) => {
    const response = await api.put('/api/auth/profile', { name, avatar });
    return response.data;
  },

  deleteAvatar: async () => {
    const response = await api.delete('/api/auth/avatar');
    return response.data;
  },

  getProfile: async () => {
    const response = await api.get('/api/auth/profile');
    return response.data;
  },

  getDepartments: async (requestConfig = {}) => {
    const response = await api.get('/api/auth/departments', requestConfig);
    return response.data;
  },

  getEmployeeIdOptions: async () => {
    const response = await api.get('/api/auth/employee-id/options');
    return response.data;
  },

  requestProfileChange: async (payload) => {
    const response = await api.post('/api/auth/profile-change/request', payload);
    return response.data;
  },

  requestPasswordChange: async (payload) => {
    const response = await api.post('/api/auth/password-change/request', payload);
    return response.data;
  },

  getLatestPasswordChange: async () => {
    const response = await api.get('/api/auth/password-change/latest');
    return response.data;
  },

  getPendingSignups: async () => {
    const response = await api.get('/api/auth/admin/pending-signups');
    return response.data;
  },

  getPendingProfileChanges: async () => {
    const response = await api.get('/api/auth/admin/pending-profile-changes');
    return response.data;
  },

  getPendingPasswordChanges: async () => {
    const response = await api.get('/api/auth/admin/pending-password-changes');
    return response.data;
  },

  reviewApprovalRequest: async (requestId, approve = true, notes = '') => {
    const response = await api.post(`/api/auth/admin/requests/${requestId}/review`, {
      approve,
      notes
    });
    return response.data;
  },

  getUsersByDepartment: async (departmentName, role = '', requestConfig = {}) => {
    const response = await api.get(
      `/api/auth/department/${departmentName}/users`,
      mergeRequestConfig(
        { params: role ? { role } : {} },
        requestConfig
      )
    );
    return response.data;
  },

  getLatestProfileChange: async () => {
    const response = await api.get('/api/auth/profile-change/latest');
    return response.data;
  },

  getAdminPendingRequests: async () => {
    const response = await api.get('/api/admin/requests/pending');
    return response.data;
  },

  reviewAdminRequest: async (requestId, approve = true, notes = '') => {
    const response = await api.post(`/api/admin/requests/${requestId}/review`, { approve, notes });
    return response.data;
  },

  getAdminAllUsers: async (requestConfig = {}) => {
    const response = await api.get('/api/admin/all-users', requestConfig);
    return response.data;
  },

  deactivateUserAccess: async (userId, reason = '') => {
    const response = await api.post(`/api/admin/deactivate-user/${userId}`, { reason });
    return response.data;
  },

  activateUserAccess: async (userId) => {
    const response = await api.post(`/api/admin/activate-user/${userId}`);
    return response.data;
  },

  deleteUserAccount: async (userId, reason = '') => {
    const response = await api.post(`/api/admin/delete-user/${userId}`, { reason });
    return response.data;
  },

  adminChangeUserPassword: async (userId, newPassword) => {
    const response = await api.post(`/api/admin/users/${userId}/password`, {
      new_password: newPassword,
    });
    return response.data;
  },

  getDeletedUsers: async () => {
    const response = await api.get('/api/admin/deleted-users');
    return response.data;
  }
};

export const activityAPI = {
  startSession: async () => {
    const response = await api.post('/api/activity/start-session', undefined, {
      timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },

  heartbeat: async (payload) => {
    const response = await api.post('/api/activity/heartbeat', payload, {
      timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },

  updateStatus: async (payload) => {
    const response = await api.post('/api/activity/update-status', payload, {
      timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },

  endSession: async (payload = {}) => {
    const response = await api.post('/api/activity/end-session', payload);
    return response.data;
  },

  myActivity: async (paramsOrConfig = {}, requestConfig = {}) => {
    const response = await api.get('/api/activity/my-activity', buildParamRequestConfig(paramsOrConfig, requestConfig));
    return response.data;
  },

  userActivity: async (userId, params = {}, requestConfig = {}) => {
    const response = await api.get(
      `/api/activity/users/${userId}`,
      mergeRequestConfig({ params }, requestConfig)
    );
    return response.data;
  },

  department: async (paramsOrConfig = {}, requestConfig = {}) => {
    const response = await api.get('/api/activity/department', buildParamRequestConfig(paramsOrConfig, requestConfig));
    return response.data;
  },

  allUsers: async (paramsOrConfig = {}, requestConfig = {}) => {
    const response = await api.get('/api/activity/all-users', buildParamRequestConfig(paramsOrConfig, requestConfig));
    return response.data;
  },

  liveStats: async () => {
    const response = await api.get('/api/activity/live-stats');
    return response.data;
  },
};

// ==================== TASK API ====================
export const taskAPI = {
  createTask: async (taskData) => {
    console.log('📤 Sending task data:', taskData);
    const normalizedLinks = Array.isArray(taskData.links)
      ? taskData.links.map((x) => `${x || ''}`.trim()).filter(Boolean)
      : [];
    const normalizedAttachments = Array.isArray(taskData.attachments)
      ? taskData.attachments
          .filter((item) => item && typeof item === 'object')
          .map((item) => ({
            filename: item.filename || item.name || null,
            originalName: item.originalName || item.name || null,
            relativePath: item.relativePath || item.webkitRelativePath || null,
            path: item.path || null,
            url: item.url || null,
            mimetype: item.mimetype || item.type || null,
            size: item.size || null,
            storage: item.storage || null,
          }))
          .filter((item) => item.url || item.filename || item.originalName)
      : [];
    const normalizedWorkflow = taskData.workflow?.enabled
      ? {
          enabled: true,
          finalApprovalRequired: Boolean(taskData.workflow?.finalApprovalRequired),
          stages: Array.isArray(taskData.workflow?.stages)
            ? taskData.workflow.stages
                .filter((stage) => stage && typeof stage === 'object')
                .map((stage, index) => ({
                  order: Number(stage.order || index + 1),
                  title: `${stage.title || ''}`.trim(),
                  description: `${stage.description || ''}`.trim() || null,
                  approvalRequired: Boolean(stage.approvalRequired),
                  assigneeIds: Array.isArray(stage.assigneeIds)
                    ? Array.from(new Set(stage.assigneeIds.map((id) => Number(id)).filter(Boolean)))
                    : [],
                }))
                .filter((stage) => stage.title && stage.assigneeIds.length > 0)
            : [],
        }
      : null;
    
    // ✅ Ensure all required fields are present
    const payload = {
      title: taskData.title || taskData.taskName || '',
      description: taskData.description || taskData.taskDetails || '',
      projectName: taskData.projectName || '',
      taskId: taskData.taskId || null,
      projectId: taskData.projectId || null,
      projectIdRaw: taskData.projectIdRaw || null,
      projectIdHex: taskData.projectIdHex || null,
      customerName: taskData.customerName || '',
      taskType: taskData.taskType || 'task',
      taskTag: taskData.taskTag || 'Audio',
      priority: taskData.priority || 'medium',
      toDepartment: taskData.toDepartment || '',
      deadline: taskData.deadline || null,
      assigneeIds: taskData.assigneeIds || [],
      reference: taskData.reference || '',
      links: normalizedLinks,
      attachments: normalizedAttachments,
      workflow: normalizedWorkflow,
    };
    
    console.log('📦 Formatted payload:', payload);
    
    try {
      const response = await api.post('/api/tasks/create', payload);
      console.log('✅ Task created:', response.data);
      return response.data;
    } catch (error) {
      console.error('❌ Task creation failed:', error.response?.data);
      throw error;
    }
  },


  getTasks: async (filters = {}) => {
    const response = await api.get('/api/tasks', { params: filters });
    return response.data;
  },

  getTaskById: async (taskId) => {
    const response = await api.get(`/api/tasks/${taskId}`);
    return response.data;
  },

  getWorkflow: async (taskId) => {
    const response = await api.get(`/api/tasks/${taskId}/workflow`);
    return response.data;
  },

  updateTask: async (taskId, formData) => {
    const response = await api.put(`/api/tasks/${taskId}`, formData);
    return response.data;
  },

  deleteTask: async (taskId) => {
    const response = await api.delete(`/api/tasks/${taskId}`);
    return response.data;
  },
  
  getInbox: async (params = {}, requestConfig = {}) => {
    const response = await api.get('/api/tasks/inbox', mergeRequestConfig({ params }, requestConfig));
    return response.data;
  },

  getInboxUnreadCount: async (requestConfig = {}) => {
    const response = await api.get(
      '/api/tasks/inbox/unread-count',
      mergeRequestConfig({ timeout: BACKGROUND_REQUEST_TIMEOUT_MS }, requestConfig)
    );
    return response.data;
  },
  
  getOutbox: async (params = {}, requestConfig = {}) => {
    const response = await api.get('/api/tasks/outbox', mergeRequestConfig({ params }, requestConfig));
    return response.data;
  },

  getAllTasks: async (filters = {}) => {
    const response = await api.get('/api/tasks/all', { params: filters });
    return response.data;
  },

  getTaskReferenceSuggestions: async (filters = {}) => {
    const response = await api.get('/api/tasks/reference-suggestions', { params: filters });
    return response.data;
  },

  getTracking: async (filters = {}, requestConfig = {}) => {
    const response = await api.get('/api/tasks/all', {
      ...requestConfig,
      params: filters,
    });
    return response.data;
  },

  getTaskAssets: async (filters = {}, requestConfig = {}) => {
    const response = await api.get('/api/tasks/assets', mergeRequestConfig({ params: filters }, requestConfig));
    return response.data;
  },

  validateProjectId: async (projectId) => {
    const response = await api.get('/api/tasks/project-id/validate', {
      params: { project_id: projectId }
    });
    return response.data;
  },

  generateProjectId: async (projectName, customerName, date = null) => {
    const response = await api.post('/api/tasks/project-id/generate', {
      project_name: projectName,
      customer_name: customerName,
      date
    });
    return response.data;
  },

  validateTaskId: async (taskId) => {
    const response = await api.get('/api/tasks/task-id/validate', {
      params: { task_id: taskId }
    });
    return response.data;
  },

  generateTaskId: async (projectName, customerName, date = null) => {
    const response = await api.post('/api/tasks/task-id/generate', {
      project_name: projectName,
      customer_name: customerName,
      date
    });
    return response.data;
  },

  getForwardTargets: async (taskId = null) => {
    const response = await api.get('/api/tasks/users/forward-targets', {
      params: taskId ? { task_id: taskId } : {}
    });
    return response.data;
  },

  assignTaskMembers: async (taskId, assigneeIds = [], comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/assign`, {
      assignee_ids: assigneeIds,
      comments
    });
    return response.data;
  },

  submitTask: async (taskId, resultTextOrPayload = '', comments = '') => {
    const payload = typeof resultTextOrPayload === 'object' && resultTextOrPayload !== null
      ? resultTextOrPayload
      : {
          result_text: resultTextOrPayload,
          comments
        };
    const response = await api.post(`/api/tasks/${taskId}/actions/submit`, payload);
    return response.data;
  },

  submitStage: async (taskId, stageId, payload = {}) => {
    const response = await api.post(`/api/tasks/${taskId}/stages/${stageId}/submit`, payload);
    return response.data;
  },

  startTask: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/start`, { comments });
    return response.data;
  },

  markSeen: async (taskId) => {
    const response = await api.post(`/api/tasks/${taskId}/actions/mark-seen`);
    return response.data;
  },

  approveTask: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/approve`, { comments });
    return response.data;
  },

  approveStage: async (taskId, stageId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/stages/${stageId}/approve`, { comments });
    return response.data;
  },

  needImprovement: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/need-improvement`, { comments });
    return response.data;
  },

  requestStageImprovement: async (taskId, stageId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/stages/${stageId}/request-improvement`, { comments });
    return response.data;
  },

  revokeTask: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/revoke`, { comments });
    return response.data;
  },

  editTask: async (taskId, payload = {}) => {
    const response = await api.put(`/api/tasks/${taskId}/edit-task`, payload);
    return response.data;
  },

  updateStage: async (taskId, stageId, payload = {}) => {
    const response = await api.patch(`/api/tasks/${taskId}/stages/${stageId}`, payload);
    return response.data;
  },

  editResult: async (taskId, resultText) => {
    const response = await api.put(`/api/tasks/${taskId}/edit-result`, { result_text: resultText });
    return response.data;
  },

  forwardTask: async (taskId, payload = {}) => {
    const response = await api.post(`/api/tasks/${taskId}/actions/forward`, payload);
    return response.data;
  },

  addComment: async (taskId, comment, isInternal = false, commentType = 'general', options = {}) => {
    const response = await api.post(`/api/tasks/${taskId}/comments`, {
      comment: typeof comment === 'string' ? comment : '',
      comment_type: commentType,
      is_internal: isInternal,
      stage_id: options.stageId || null,
      attachments: Array.isArray(options.attachments) ? options.attachments : [],
    });
    return response.data;
  },

  getComments: async (taskId, params = {}) => {
    const response = await api.get(`/api/tasks/${taskId}/comments`, { params });
    return response.data;
  },

  getNotifications: async (unreadOnly = false, requestConfig = {}) => {
    const response = await api.get(
      '/api/tasks/notifications/me',
      mergeRequestConfig({ params: { unread_only: unreadOnly } }, requestConfig)
    );
    return response.data;
  },

  getOutboxUnreadCount: async (requestConfig = {}) => {
    const response = await api.get(
      '/api/tasks/notifications/outbox-unread',
      mergeRequestConfig({ timeout: BACKGROUND_REQUEST_TIMEOUT_MS }, requestConfig)
    );
    return response.data;
  },

  getWebPushConfig: async (requestConfig = {}) => {
    const response = await api.get(
      '/api/tasks/notifications/push/config',
      mergeRequestConfig({ timeout: BACKGROUND_REQUEST_TIMEOUT_MS }, requestConfig)
    );
    return response.data;
  },

  subscribeWebPush: async (subscription, requestConfig = {}) => {
    const response = await api.post(
      '/api/tasks/notifications/push/subscribe',
      { subscription },
      mergeRequestConfig({ timeout: BACKGROUND_REQUEST_TIMEOUT_MS }, requestConfig)
    );
    return response.data;
  },

  unsubscribeWebPush: async (endpoint, requestConfig = {}) => {
    const response = await api.post(
      '/api/tasks/notifications/push/unsubscribe',
      { endpoint },
      mergeRequestConfig({ timeout: BACKGROUND_REQUEST_TIMEOUT_MS }, requestConfig)
    );
    return response.data;
  },

  markNotificationRead: async (notificationId) => {
    const response = await api.post(`/api/tasks/notifications/${notificationId}/read`);
    return response.data;
  },

  deleteNotification: async (notificationId) => {
    const response = await api.delete(`/api/tasks/notifications/${notificationId}`);
    return response.data;
  },
};

export const groupAPI = {
  listUsers: async () => {
    const response = await api.get('/api/groups/users');
    return response.data;
  },

  listGroups: async () => {
    const response = await api.get('/api/groups', {
      timeout: BACKGROUND_REQUEST_TIMEOUT_MS,
    });
    return response.data;
  },

  createGroup: async (name, memberIds = []) => {
    const response = await api.post('/api/groups', {
      name,
      member_ids: memberIds,
    });
    return response.data;
  },

  addMembers: async (groupId, memberIds = []) => {
    const response = await api.post(`/api/groups/${groupId}/members`, {
      member_ids: memberIds,
    });
    return response.data;
  },

  removeMember: async (groupId, userId) => {
    const response = await api.delete(`/api/groups/${groupId}/members/${userId}`);
    return response.data;
  },

  updateMemberRole: async (groupId, userId, role) => {
    const response = await api.patch(`/api/groups/${groupId}/members/${userId}/role`, { role });
    return response.data;
  },

  listMessages: async (groupId) => {
    const response = await api.get(`/api/groups/${groupId}/messages`);
    return response.data;
  },

  sendMessage: async (groupId, messageOrPayload) => {
    const payload = typeof messageOrPayload === 'object' && messageOrPayload !== null
      ? messageOrPayload
      : { message: messageOrPayload };
    const response = await api.post(`/api/groups/${groupId}/messages`, payload);
    return response.data;
  },
};

export const directMessageAPI = {
  listUsers: async () => {
    const response = await api.get('/api/direct-messages/users');
    return response.data;
  },

  listConversations: async () => {
    const response = await api.get('/api/direct-messages/conversations');
    return response.data;
  },

  listMessages: async (userId) => {
    const response = await api.get(`/api/direct-messages/conversations/${userId}/messages`);
    return response.data;
  },

  sendMessage: async (userId, messageOrPayload) => {
    const payload = typeof messageOrPayload === 'object' && messageOrPayload !== null
      ? messageOrPayload
      : { message: messageOrPayload };
    const response = await api.post(`/api/direct-messages/conversations/${userId}/messages`, payload);
    return response.data;
  },
};

const realtimeSubscribers = new Map();
let realtimeSubscriberSeq = 0;
let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeIdleCloseTimer = null;
let realtimeHeartbeatTimer = null;
let realtimeBackoffMs = 1000;
const REALTIME_MAX_BACKOFF_MS = 30000;
const REALTIME_HEARTBEAT_MS = 25000;

const buildRealtimeWsUrl = () => {
  const baseUrl = `${API_URL.replace(/^http/i, 'ws')}/api/tasks/ws/notifications`;
  const sessionToken = getStoredSessionToken();
  if (!sessionToken) return baseUrl;
  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}session_token=${encodeURIComponent(sessionToken)}`;
};

const broadcastRealtime = (kind, payload) => {
  realtimeSubscribers.forEach((handlers) => {
    try {
      if (kind === 'message' && typeof handlers.onMessage === 'function') handlers.onMessage(payload);
      if (kind === 'open' && typeof handlers.onOpen === 'function') handlers.onOpen();
      if (kind === 'close' && typeof handlers.onClose === 'function') handlers.onClose(payload);
      if (kind === 'error' && typeof handlers.onError === 'function') handlers.onError(payload);
    } catch (err) {
      console.warn('Realtime subscriber callback failed:', err);
    }
  });
};

const clearRealtimeTimers = () => {
  if (realtimeReconnectTimer) {
    window.clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }
  if (realtimeIdleCloseTimer) {
    window.clearTimeout(realtimeIdleCloseTimer);
    realtimeIdleCloseTimer = null;
  }
  if (realtimeHeartbeatTimer) {
    window.clearInterval(realtimeHeartbeatTimer);
    realtimeHeartbeatTimer = null;
  }
};

const scheduleRealtimeReconnect = () => {
  if (realtimeReconnectTimer || realtimeSubscribers.size === 0) return;
  const delay = realtimeBackoffMs;
  realtimeReconnectTimer = window.setTimeout(() => {
    realtimeReconnectTimer = null;
    ensureRealtimeSocket();
  }, delay);
  realtimeBackoffMs = Math.min(realtimeBackoffMs * 2, REALTIME_MAX_BACKOFF_MS);
};

const ensureRealtimeHeartbeat = () => {
  if (realtimeHeartbeatTimer) return;
  realtimeHeartbeatTimer = window.setInterval(() => {
    if (!realtimeSocket || realtimeSocket.readyState !== WebSocket.OPEN) return;
    try {
      realtimeSocket.send('ping');
    } catch {
      // no-op
    }
  }, REALTIME_HEARTBEAT_MS);
};

const ensureRealtimeSocket = () => {
  if (typeof window === 'undefined') return;
  if (realtimeSubscribers.size === 0) return;
  if (realtimeSocket && (realtimeSocket.readyState === WebSocket.OPEN || realtimeSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearRealtimeTimers();
  const socket = new WebSocket(buildRealtimeWsUrl());
  realtimeSocket = socket;

  socket.onopen = () => {
    realtimeBackoffMs = 1000;
    ensureRealtimeHeartbeat();
    broadcastRealtime('open');
  };

  socket.onmessage = (event) => {
    try {
      const payload = JSON.parse(event.data);
      broadcastRealtime('message', payload);
    } catch (error) {
      console.warn('Invalid websocket payload:', error);
    }
  };

  socket.onerror = (event) => {
    broadcastRealtime('error', event);
  };

  socket.onclose = (event) => {
    if (realtimeSocket === socket) {
      realtimeSocket = null;
    }
    if (realtimeHeartbeatTimer) {
      window.clearInterval(realtimeHeartbeatTimer);
      realtimeHeartbeatTimer = null;
    }
    broadcastRealtime('close', event);
    scheduleRealtimeReconnect();
  };
};

export const subscribeRealtimeNotifications = ({ onMessage, onOpen, onClose, onError } = {}) => {
  const subscriberId = ++realtimeSubscriberSeq;
  realtimeSubscribers.set(subscriberId, { onMessage, onOpen, onClose, onError });
  if (realtimeIdleCloseTimer) {
    window.clearTimeout(realtimeIdleCloseTimer);
    realtimeIdleCloseTimer = null;
  }
  ensureRealtimeSocket();

  return () => {
    realtimeSubscribers.delete(subscriberId);
    if (realtimeSubscribers.size > 0) return;

    clearRealtimeTimers();
    realtimeIdleCloseTimer = window.setTimeout(() => {
      if (realtimeSubscribers.size > 0) return;
      if (realtimeSocket && realtimeSocket.readyState <= WebSocket.OPEN) {
        realtimeSocket.close();
      }
      realtimeSocket = null;
    }, 3000);
  };
};

export const createNotificationsSocket = ({ onMessage, onOpen, onClose, onError } = {}) => {
  const unsubscribe = subscribeRealtimeNotifications({ onMessage, onOpen, onClose, onError });
  return {
    close: () => unsubscribe(),
    get readyState() {
      return realtimeSocket ? realtimeSocket.readyState : WebSocket.CLOSED;
    },
  };
};

// ==================== DRAFT API ====================
export const draftAPI = {
  saveDraft: async (draftData) => {
    const response = await api.post('/api/drafts/save', draftData);
    return response.data;
  },

  updateDraft: async (draftId, draftData) => {
    try {
      const response = await api.put(`/api/drafts/${draftId}`, draftData);
      return response.data;
    } catch (error) {
      if (error.response?.status === 404) {
        console.log('Draft not found, creating new one');
        return await draftAPI.saveDraft(draftData);
      }
      throw error;
    }
  },

  getDrafts: async () => {
    const response = await api.get('/api/drafts/');
    return response.data;
  },

  getDraftById: async (draftId) => {
    const response = await api.get(`/api/drafts/${draftId}`);
    return response.data;
  },

  deleteDraft: async (draftId) => {
    const response = await api.delete(`/api/drafts/${draftId}`);
    return response.data;
  },

  loadLatestDraft: async () => {
    const localDraft = localStorage.getItem('taskDraft');
    if (localDraft) {
      return { data: JSON.parse(localDraft), source: 'local' };
    }

    try {
      const response = await api.get('/api/drafts/latest');
      return { data: response.data, source: 'api' };
    } catch (error) {
      return { data: null, source: null };
    }
  },
};

// ==================== FILE API ====================
export const fileAPI = {
  uploadFiles: async (files, options = {}) => {
    const filesToUpload = toUploadFiles(files);
    if (filesToUpload.length === 0) {
      return {
        success: true,
        message: 'No valid files to upload',
        data: [],
        storage: 'r2',
      };
    }

    try {
      const prepareResponse = await api.post(
        '/api/uploads/presign',
        buildPresignPayload(filesToUpload),
        {
          signal: options.signal,
          timeout: PRESIGN_TIMEOUT_MS,
        }
      );

      const uploadTargets = Array.isArray(prepareResponse?.data?.data)
        ? prepareResponse.data.data
        : [];

      if (uploadTargets.length !== filesToUpload.length) {
        throw new Error('Upload preparation returned an unexpected number of targets.');
      }

      const tracker = createProgressTracker(filesToUpload, options);
      const tasks = filesToUpload.map((file, index) => async () => {
        const target = uploadTargets[index];
        if (!target?.attachment) {
          throw new Error(`Upload target is missing for "${file.name}".`);
        }
        if (target?.strategy === 'multipart') {
          return uploadFileMultipartToR2(file, target, tracker, index, options);
        }
        if (!target?.uploadUrl) {
          throw new Error(`Upload URL is missing for "${file.name}".`);
        }
        return uploadFileDirectToR2(file, { ...target, signal: options.signal }, tracker, index);
      });

      const data = await runWithConcurrency(
        tasks,
        options.concurrency || DIRECT_UPLOAD_CONCURRENCY
      );

      return {
        success: true,
        message: `${data.length} file(s) uploaded successfully`,
        data,
        storage: 'r2',
      };
    } catch (error) {
      if (shouldUseLegacyUploadFallback(filesToUpload, error, options)) {
        try {
          return await uploadFilesLegacy(filesToUpload, options);
        } catch (legacyError) {
          throw buildUploadError(legacyError);
        }
      }
      throw buildUploadError(error);
    }
  },
};

// ==================== IT PROFILE / TOOL VAULT API ====================
export const itToolsAPI = {
  listTools: async (requestConfig = {}) => {
    const response = await api.get('/api/it-tools/tools', requestConfig);
    return response.data;
  },

  createTool: async (payload) => {
    const response = await api.post('/api/it-tools/tools', payload);
    return response.data;
  },

  updateTool: async (toolId, payload) => {
    const response = await api.patch(`/api/it-tools/tools/${toolId}`, payload);
    return response.data;
  },

  deleteTool: async (toolId) => {
    const response = await api.delete(`/api/it-tools/tools/${toolId}`);
    return response.data;
  },

  listCredentials: async (toolId) => {
    const response = await api.get(`/api/it-tools/tools/${toolId}/credentials`);
    return response.data;
  },

  getToolCredentials: async (toolId) => {
    const response = await api.get(`/api/it-tools/tools/${toolId}/credentials`);
    return response.data;
  },

  getMailboxConfig: async (toolId) => {
    const response = await api.get(`/api/it-tools/${toolId}/mailbox`);
    return response.data;
  },

  upsertMailboxConfig: async (toolId, payload) => {
    const response = await api.post(`/api/it-tools/${toolId}/mailbox`, payload);
    return response.data;
  },

  deleteMailboxConfig: async (toolId) => {
    const response = await api.delete(`/api/it-tools/${toolId}/mailbox`);
    return response.data;
  },

  testMailboxConfig: async (toolId) => {
    const response = await api.post(`/api/it-tools/${toolId}/mailbox/test`);
    return response.data;
  },

  upsertCredential: async (toolId, payload) => {
    const response = await api.post(`/api/it-tools/tools/${toolId}/credentials`, payload);
    return response.data;
  },

  launchTool: async (toolId) => {
    const response = await api.post(`/api/it-tools/tools/${toolId}/launch`);
    return response.data;
  },
};

export default api;
