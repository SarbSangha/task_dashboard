// AuthContext.jsx - COMPLETE FIXED VERSION
import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

const AuthContext = createContext();

const API_URL = 'http://localhost:8000/api/auth';

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);

  // Check authentication on mount
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      console.log('🔍 Checking authentication...');
      
      const response = await axios.get(`${API_URL}/me`, {
        withCredentials: true
      });

      console.log('✅ Auth check response:', response.data);

      if (response.data && response.data.id) {
        setUser(response.data);
        setIsAuthenticated(true);
        console.log('✅ User authenticated:', response.data.email);
      }
    } catch (error) {
      console.log('ℹ️ No active session');
      setUser(null);
      setIsAuthenticated(false);
    } finally {
      setLoading(false);
    }
  };

  const login = async (email, password, rememberMe = false) => {
    try {
      console.log('🔐 Logging in:', email);
      
      const response = await axios.post(
        `${API_URL}/login`,
        {
          email,
          password,
          remember_me: rememberMe
        },
        {
          withCredentials: true,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ Login response:', response.data);

      // Backend returns user object directly
      if (response.data && response.data.id) {
        setUser(response.data);
        setIsAuthenticated(true);
        console.log('✅ User logged in:', response.data.email);
        
        if (rememberMe) {
          localStorage.setItem('isAuthenticated', 'true');
        }
        
        return response.data;
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      console.error('❌ Login error:', error.response?.data || error.message);
      setUser(null);
      setIsAuthenticated(false);
      localStorage.removeItem('isAuthenticated');
      throw error;
    }
  };

  const register = async (email, password, name, position) => {
    try {
      console.log('📝 Registering:', email);
      
      const response = await axios.post(
        `${API_URL}/register`,
        {
          email,
          password,
          name,
          position
        },
        {
          withCredentials: true,
          headers: {
            'Content-Type': 'application/json'
          }
        }
      );

      console.log('✅ Register response:', response.data);

      if (response.data && response.data.id) {
        setUser(response.data);
        setIsAuthenticated(true);
        console.log('✅ User registered:', response.data.email);
        return response.data;
      } else {
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      console.error('❌ Registration error:', error.response?.data || error.message);
      setUser(null);
      setIsAuthenticated(false);
      throw error;
    }
  };

  const logout = async () => {
    try {
      console.log('👋 Logging out...');
      
      await axios.post(`${API_URL}/logout`, {}, {
        withCredentials: true
      });

      setUser(null);
      setIsAuthenticated(false);
      localStorage.removeItem('isAuthenticated');
      
      console.log('✅ Logged out successfully');
    } catch (error) {
      console.error('❌ Logout error:', error);
      // Still clear local state even if API call fails
      setUser(null);
      setIsAuthenticated(false);
      localStorage.removeItem('isAuthenticated');
    }
  };

  const value = {
    user,
    isAuthenticated,
    loading,
    login,
    register,
    logout,
    checkAuth
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
