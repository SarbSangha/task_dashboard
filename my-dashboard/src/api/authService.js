// authService.js - FIXED VERSION
import axios from 'axios';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const api = axios.create({
  baseURL: API_URL,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

export const authAPI = {
  register: async (email, password, name, position) => {
    const response = await api.post('/api/auth/register', { 
      email, 
      password, 
      name,
      position 
    });
    return response.data;
  },

  login: async (email, password, rememberMe = false) => {
    const response = await api.post('/api/auth/login', {
      email,
      password,
      remember_me: rememberMe
    });
    return response.data;  // ← Return the user data
  },

  logout: async () => {
    const response = await api.post('/api/auth/logout');
    return response.data;
  },

  getCurrentUser: async () => {
    const response = await api.get('/api/auth/me');
    return response.data;
  },

  uploadAvatar: async (base64Image) => {
    const response = await api.post('/api/user/avatar', { avatar: base64Image });
    return response.data;
  },

  updateProfile: async (name, avatar) => {
    const response = await api.put('/api/user/profile', { name, avatar });
    return response.data;
  },

  deleteAvatar: async () => {
    const response = await api.delete('/api/user/avatar');
    return response.data;
  },

  getProfile: async () => {
    const response = await api.get('/api/user/profile');
    return response.data;
  }
};

// Interceptor for 401 errors
api.interceptors.response.use(
  response => response,
  error => {
    if (error.response?.status === 401) {
      // Only redirect if not on login/register pages
      const publicPaths = ['/login', '/register', '/forgot-password', '/reset-password'];
      if (!publicPaths.includes(window.location.pathname)) {
        console.log('❌ 401 Unauthorized - redirecting to login');
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default api;
