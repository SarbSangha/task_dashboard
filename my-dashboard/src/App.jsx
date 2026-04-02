// src/App.jsx - FIXED WITH ROUTES

import React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import './App.css';

// Auth Components
import Login from './components/auth/Login';
import Register from './components/auth/Register';

// Protected Components
import Dashboard from './pages/Dashboard';
import ProtectedRoute from './components/ProtectedRoute';

// Context
import { AuthProvider } from './context/AuthContext';
import { CustomDialogProvider } from './components/common/CustomDialogs';
import { queryClient } from './lib/queryClient';

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <AuthProvider>
          <CustomDialogProvider>
            <Routes>
              {/* Public Routes */}
              <Route path="/login" element={<Login />} />
              <Route path="/register" element={<Register />} />
              
              {/* Protected Routes */}
              <Route 
                path="/dashboard/*" 
                element={
                  <ProtectedRoute>
                    <Dashboard />
                  </ProtectedRoute>
                } 
              />
              
              {/* Default Route */}
              <Route path="/" element={<Navigate to="/dashboard" replace />} />
              
              {/* 404 Route */}
              <Route path="*" element={<Navigate to="/dashboard" replace />} />
            </Routes>
          </CustomDialogProvider>
        </AuthProvider>
      </HashRouter>
      {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}

export default App;
