// src/context/AuthContext.jsx - ADD useAuth HOOK

import React, { createContext, useState, useEffect, useContext, useCallback, useRef } from 'react';
import { activityAPI, authAPI } from '../services/api';
import useActivityTracker from '../hooks/useActivityTracker';
import { cleanupWebPushSubscription } from '../utils/webPush';

export const AuthContext = createContext();
const AUTH_BOOTSTRAP_CACHE_MS = 10000;
const AUTH_BOOTSTRAP_RETRY_COUNT = 2;
const AUTH_BOOTSTRAP_RETRY_DELAY_MS = 900;
let authBootstrapPromise = null;
let authBootstrapCachedResult = null;
let authBootstrapCachedAt = 0;

const isNetworkLikeError = (error) =>
  !error?.response && (
    error?.code === 'ECONNABORTED'
    || error?.code === 'ERR_NETWORK'
    || error?.message?.toLowerCase?.().includes('timeout')
  );

const resetAuthBootstrapCache = () => {
  authBootstrapPromise = null;
  authBootstrapCachedResult = null;
  authBootstrapCachedAt = 0;
};

const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const getCurrentUserWithRetry = async () => {
  let attempt = 0;
  let lastError = null;

  while (attempt < AUTH_BOOTSTRAP_RETRY_COUNT) {
    try {
      return await authAPI.getCurrentUser();
    } catch (error) {
      lastError = error;
      if (!isNetworkLikeError(error) || attempt === AUTH_BOOTSTRAP_RETRY_COUNT - 1) {
        throw error;
      }
      await wait(AUTH_BOOTSTRAP_RETRY_DELAY_MS);
      attempt += 1;
    }
  }

  throw lastError;
};

// ✅ ADD THIS: Custom hook to use auth context
export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authIssue, setAuthIssue] = useState(null);
  const noAvatarUserIdsRef = useRef(new Set());
  const handleActivityAuthFailure = useCallback(() => {
    noAvatarUserIdsRef.current.clear();
    setUser(null);
  }, []);
  const activity = useActivityTracker({
    enabled: !!user,
    onAuthFailure: handleActivityAuthFailure,
  });

  // Check authentication on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const fetchAndPatchAvatar = useCallback(async (currentUser) => {
    if (!currentUser?.id) return;
    if (currentUser.avatar) return;
    if (noAvatarUserIdsRef.current.has(currentUser.id)) return;

    try {
      const response = await authAPI.getAvatar();
      if (response?.userId !== currentUser.id) return;

      if (!response?.hasAvatar || !response?.avatar) {
        noAvatarUserIdsRef.current.add(currentUser.id);
        return;
      }

      setUser((prev) => {
        if (!prev || prev.id !== currentUser.id) return prev;
        return { ...prev, avatar: response.avatar };
      });
    } catch {
      // Non-fatal. The app can continue with initials/avatar fallback.
    }
  }, []);

  const checkAuth = async () => {
    console.log('🔍 Checking authentication...');
    try {
      const now = Date.now();
      let response = null;

      if (authBootstrapCachedResult && (now - authBootstrapCachedAt) < AUTH_BOOTSTRAP_CACHE_MS) {
        response = authBootstrapCachedResult;
      } else {
        if (!authBootstrapPromise) {
          authBootstrapPromise = getCurrentUserWithRetry()
            .then((result) => {
              authBootstrapCachedResult = result;
              authBootstrapCachedAt = Date.now();
              return result;
            })
            .finally(() => {
              authBootstrapPromise = null;
            });
        }
        response = await authBootstrapPromise;
      }

      if (response.success && response.user) {
        setUser(response.user);
        setAuthIssue(null);
        void fetchAndPatchAvatar(response.user);
        console.log('✅ User authenticated:', response.user.email);
      } else {
        console.log('ℹ️ No active session');
        noAvatarUserIdsRef.current.clear();
        setUser(null);
        setAuthIssue(null);
      }
    } catch (error) {
      if (isNetworkLikeError(error)) {
        console.warn('⚠️ Auth check failed because the auth service is unreachable or timed out.');
        setAuthIssue({
          code: 'AUTH_UNREACHABLE',
          message: 'Cannot reach the login service right now.',
        });
      } else {
        console.log('ℹ️ No active session');
        setAuthIssue(null);
      }
      noAvatarUserIdsRef.current.clear();
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  const normalizeApiError = (detail, fallbackMessage = 'Request failed') => {
    if (Array.isArray(detail)) {
      return {
        message: detail.map((err) => err.msg).join(', '),
        code: null,
        reason: null,
        nextAction: null,
      };
    }

    if (typeof detail === 'string') {
      return {
        message: detail,
        code: null,
        reason: null,
        nextAction: null,
      };
    }

    if (detail && typeof detail === 'object') {
      return {
        message: detail.message || detail.msg || fallbackMessage,
        code: detail.code || null,
        reason: detail.reason || null,
        nextAction: detail.nextAction || null,
      };
    }

    return {
      message: fallbackMessage,
      code: null,
      reason: null,
      nextAction: null,
    };
  };

  const login = async (email, password, rememberMe = false) => {
    console.log('🔐 Logging in:', email);
    try {
      const response = await authAPI.login(email, password, rememberMe);
      
      if (response.success && response.user) {
        resetAuthBootstrapCache();
        setUser(response.user);
        void fetchAndPatchAvatar(response.user);
        try {
          localStorage.removeItem('rmw_activity_auth_block_until_v1');
        } catch {
          // no-op
        }
        setAuthIssue(null);
        console.log('✅ Login successful:', response.user.email);
        return { success: true };
      } else {
        console.error('❌ Login failed: Invalid response format');
        return { 
          success: false, 
          error: 'Invalid response from server' 
        };
      }
    } catch (error) {
      console.error('❌ Login error:', error);
      if (!error.response) {
        return {
          success: false,
          error: 'Network error',
          errorDetails: {
            message: 'Cannot reach the login service right now. Check the API URL, CORS, worker route, and backend health.',
            code: 'NETWORK_ERROR',
            reason: null,
            nextAction: 'Try again in a moment. If it keeps failing, inspect the browser Network tab for the /api/auth/login request.',
          },
        };
      }
      const errorInfo = normalizeApiError(
        error.response?.data?.detail,
        error.message || 'Login failed'
      );

      return { 
        success: false, 
        error: errorInfo.message,
        errorDetails: errorInfo,
      };
    }
  };

  const register = async (email, password, name, position, department) => {
    console.log('📝 Registering:', email);
    try {
      const response = await authAPI.register(email, password, name, position, department);
      
      if (response.success) {
        console.log('✅ Registration successful');
        return { success: true, pendingApproval: true, message: response.message };
      } else {
        return { 
          success: false, 
          error: 'Registration failed' 
        };
      }
    } catch (error) {
      console.error('❌ Registration error:', error);
      
      let errorMessage = 'Registration failed';
      
      if (error.response?.data?.detail) {
        const detail = error.response.data.detail;
        
        if (Array.isArray(detail)) {
          errorMessage = detail.map(err => err.msg).join(', ');
        } else if (typeof detail === 'string') {
          errorMessage = detail;
        } else if (typeof detail === 'object' && detail.msg) {
          errorMessage = detail.msg;
        }
      } else if (error.message) {
        errorMessage = error.message;
      }
      
      return { 
        success: false, 
        error: errorMessage 
      };
    }
  };

  const logout = async () => {
    console.log('👋 Logging out...');
    try {
      await cleanupWebPushSubscription({
        removeServerSubscription: true,
        removeBrowserSubscription: true,
      }).catch(() => {});
      await activityAPI.endSession({
        status: 'OFFLINE',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      await authAPI.logout();
      resetAuthBootstrapCache();
      noAvatarUserIdsRef.current.clear();
      setUser(null);
      setAuthIssue(null);
      console.log('✅ Logout successful');
    } catch (error) {
      console.error('❌ Logout error:', error);
      resetAuthBootstrapCache();
      noAvatarUserIdsRef.current.clear();
      setUser(null);
      setAuthIssue(null);
    }
  };

  const updateUser = useCallback((patch) => {
    setUser((currentUser) => {
      if (!currentUser) {
        return currentUser;
      }

      const nextPatch = typeof patch === 'function' ? patch(currentUser) : patch;
      if (!nextPatch || typeof nextPatch !== 'object') {
        return currentUser;
      }

      return {
        ...currentUser,
        ...nextPatch,
      };
    });
  }, []);

  const clearAvatarCache = useCallback((userId = null) => {
    if (userId) {
      noAvatarUserIdsRef.current.delete(userId);
      return;
    }
    if (user?.id) {
      noAvatarUserIdsRef.current.delete(user.id);
    }
  }, [user?.id]);

  const value = {
    user,
    loading,
    authIssue,
    login,
    logout,
    register,
    checkAuth,
    updateUser,
    clearAvatarCache,
    activity
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
