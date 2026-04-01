// src/context/AuthContext.jsx - ADD useAuth HOOK

import React, { createContext, useState, useEffect, useContext, useCallback } from 'react';
import { activityAPI, authAPI } from '../services/api';
import useActivityTracker from '../hooks/useActivityTracker';

export const AuthContext = createContext();

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
  const handleActivityAuthFailure = useCallback(() => {
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

  const checkAuth = async () => {
    console.log('🔍 Checking authentication...');
    try {
      const response = await authAPI.getCurrentUser();
      if (response.success && response.user) {
        setUser(response.user);
        console.log('✅ User authenticated:', response.user.email);
      } else {
        console.log('ℹ️ No active session');
        setUser(null);
      }
    } catch (error) {
      console.log('ℹ️ No active session');
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
        setUser(response.user);
        try {
          localStorage.removeItem('rmw_activity_auth_block_until_v1');
        } catch {
          // no-op
        }
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
      await activityAPI.endSession({
        status: 'OFFLINE',
        timestamp: new Date().toISOString(),
      }).catch(() => {});
      await authAPI.logout();
      setUser(null);
      console.log('✅ Logout successful');
    } catch (error) {
      console.error('❌ Logout error:', error);
      setUser(null);
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

  const value = {
    user,
    loading,
    login,
    logout,
    register,
    checkAuth,
    updateUser,
    activity
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
