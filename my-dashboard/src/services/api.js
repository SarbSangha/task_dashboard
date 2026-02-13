// src/services/api.js
import axios from 'axios';

const API_BASE_URL = 'http://localhost:8000'; // Your FastAPI backend URL

// Create axios instance
const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Add auth token to requests
api.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('authToken');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Task API calls
export const taskAPI = {
  // Create new task
  createTask: async (formData) => {
    const response = await api.post('/api/tasks/create', formData);
    return response.data;
  },

  // Get all tasks
  getTasks: async (filters = {}) => {
    const response = await api.get('/api/tasks', { params: filters });
    return response.data;
  },

  // Get task by ID
  getTaskById: async (taskId) => {
    const response = await api.get(`/api/tasks/${taskId}`);
    return response.data;
  },

  // Update task
  updateTask: async (taskId, formData) => {
    const response = await api.put(`/api/tasks/${taskId}`, formData);
    return response.data;
  },

  // Delete task
  deleteTask: async (taskId) => {
    const response = await api.delete(`/api/tasks/${taskId}`);
    return response.data;
  },
};

// Draft API calls
// Update draftAPI in api.js

export const draftAPI = {
  // Save as draft
  saveDraft: async (draftData) => {
    const response = await api.post('/api/drafts/save', draftData);
    return response.data;
  },

  // Update draft - with fallback
  updateDraft: async (draftId, draftData) => {
    try {
      const response = await api.put(`/api/drafts/${draftId}`, draftData);
      return response.data;
    } catch (error) {
      // If 404, the draft doesn't exist, create new one
      if (error.response?.status === 404) {
        console.log('Draft not found, creating new one');
        return await draftAPI.saveDraft(draftData);
      }
      throw error;
    }
  },

  // Get all drafts
  getDrafts: async () => {
    const response = await api.get('/api/drafts/');
    return response.data;
  },

  // Get draft by ID
  getDraftById: async (draftId) => {
    const response = await api.get(`/api/drafts/${draftId}`);
    return response.data;
  },

  // Delete draft
  deleteDraft: async (draftId) => {
    const response = await api.delete(`/api/drafts/${draftId}`);
    return response.data;
  },

  // Load latest draft (from localStorage or API)
  loadLatestDraft: async () => {
    // First check localStorage
    const localDraft = localStorage.getItem('taskDraft');
    if (localDraft) {
      return { data: JSON.parse(localDraft), source: 'local' };
    }

    // Then check API
    try {
      const response = await api.get('/api/drafts/latest');
      return { data: response.data, source: 'api' };
    } catch (error) {
      return { data: null, source: null };
    }
  },
};



// File upload API
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
