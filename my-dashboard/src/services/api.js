// src/services/api.js - UNIFIED API SERVICE
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const SESSION_TOKEN_STORAGE_KEY = 'rmw_session_token_v1';
const SESSION_TOKEN_REMEMBER_KEY = 'rmw_session_token_remember_v1';

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
  headers: {
    'Content-Type': 'application/json'
  }
});

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
    const response = await api.get('/api/auth/me');
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

  getDepartments: async () => {
    const response = await api.get('/api/auth/departments');
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

  getUsersByDepartment: async (departmentName, role = '') => {
    const response = await api.get(`/api/auth/department/${departmentName}/users`, {
      params: role ? { role } : {}
    });
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

  getAdminAllUsers: async () => {
    const response = await api.get('/api/admin/all-users');
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

  getDeletedUsers: async () => {
    const response = await api.get('/api/admin/deleted-users');
    return response.data;
  }
};

export const activityAPI = {
  startSession: async () => {
    const response = await api.post('/api/activity/start-session');
    return response.data;
  },

  heartbeat: async (payload) => {
    const response = await api.post('/api/activity/heartbeat', payload);
    return response.data;
  },

  updateStatus: async (payload) => {
    const response = await api.post('/api/activity/update-status', payload);
    return response.data;
  },

  endSession: async (payload = {}) => {
    const response = await api.post('/api/activity/end-session', payload);
    return response.data;
  },

  myActivity: async () => {
    const response = await api.get('/api/activity/my-activity');
    return response.data;
  },

  department: async () => {
    const response = await api.get('/api/activity/department');
    return response.data;
  },

  allUsers: async () => {
    const response = await api.get('/api/activity/all-users');
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
            path: item.path || null,
            url: item.url || null,
            mimetype: item.mimetype || item.type || null,
            size: item.size || null,
            storage: item.storage || null,
          }))
          .filter((item) => item.url || item.filename || item.originalName)
      : [];
    
    // ✅ Ensure all required fields are present
    const payload = {
      title: taskData.title || taskData.taskName || '',
      description: taskData.description || taskData.taskDetails || '',
      projectName: taskData.projectName || '',
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

  updateTask: async (taskId, formData) => {
    const response = await api.put(`/api/tasks/${taskId}`, formData);
    return response.data;
  },

  deleteTask: async (taskId) => {
    const response = await api.delete(`/api/tasks/${taskId}`);
    return response.data;
  },
  
  getInbox: async () => {
    const response = await api.get('/api/tasks/inbox');
    return response.data;
  },
  
  getOutbox: async () => {
    const response = await api.get('/api/tasks/outbox');
    return response.data;
  },

  getAllTasks: async (filters = {}) => {
    const response = await api.get('/api/tasks/all', { params: filters });
    return response.data;
  },

  getTaskAssets: async (filters = {}) => {
    const response = await api.get('/api/tasks/assets', { params: filters });
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

  startTask: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/start`, { comments });
    return response.data;
  },

  approveTask: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/approve`, { comments });
    return response.data;
  },

  needImprovement: async (taskId, comments = '') => {
    const response = await api.post(`/api/tasks/${taskId}/actions/need-improvement`, { comments });
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

  editResult: async (taskId, resultText) => {
    const response = await api.put(`/api/tasks/${taskId}/edit-result`, { result_text: resultText });
    return response.data;
  },

  forwardTask: async (taskId, payload = {}) => {
    const response = await api.post(`/api/tasks/${taskId}/actions/forward`, payload);
    return response.data;
  },

  addComment: async (taskId, comment, isInternal = false, commentType = 'general') => {
    const response = await api.post(`/api/tasks/${taskId}/comments`, {
      comment,
      comment_type: commentType,
      is_internal: isInternal
    });
    return response.data;
  },

  getComments: async (taskId, params = {}) => {
    const response = await api.get(`/api/tasks/${taskId}/comments`, { params });
    return response.data;
  },

  getNotifications: async (unreadOnly = false) => {
    const response = await api.get('/api/tasks/notifications/me', {
      params: { unread_only: unreadOnly }
    });
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
    const response = await api.get('/api/groups');
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
  uploadFiles: async (files) => {
    const formData = new FormData();
    files.forEach(file => {
      formData.append('files', file);
    });

    const response = await api.post('/upload', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
      onUploadProgress: (progressEvent) => {
        const percentCompleted = Math.round(
          (progressEvent.loaded * 100) / progressEvent.total
        );
        console.log(`Upload progress: ${percentCompleted}%`);
      },
    });

    return response.data;
  },
};

export default api;
