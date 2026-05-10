// src/components/ProtectedRoute.jsx

import React from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const ProtectedRoute = ({ children }) => {
  const { user, loading, authIssue, checkAuth } = useAuth();

  // Show loading spinner while checking authentication
  if (loading) {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        fontSize: '18px',
        background: '#f5f5f5'
      }}>
        <div>
          <div style={{ 
            width: '50px', 
            height: '50px', 
            border: '4px solid #ccc',
            borderTop: '4px solid #007bff',
            borderRadius: '50%',
            animation: 'spin 1s linear infinite',
            margin: '0 auto 20px'
          }}></div>
          <div>Loading...</div>
        </div>
        <style>{`
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    );
  }

  if (!user && authIssue?.code === 'AUTH_UNREACHABLE') {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        minHeight: '100vh',
        padding: '2rem',
        background: '#0f172a',
        color: '#e2e8f0',
      }}>
        <div style={{
          width: '100%',
          maxWidth: '480px',
          padding: '1.5rem',
          borderRadius: '18px',
          border: '1px solid rgba(96, 165, 250, 0.2)',
          background: 'rgba(15, 23, 42, 0.92)',
          boxShadow: '0 20px 45px rgba(2, 8, 23, 0.24)',
        }}>
          <h2 style={{ margin: '0 0 0.75rem', fontSize: '1.35rem' }}>Can&apos;t Reach The Login Service</h2>
          <p style={{ margin: 0, lineHeight: 1.6, color: '#94a3b8' }}>
            The dashboard could not verify your session because the auth service timed out or is temporarily unreachable.
          </p>
          <button
            type="button"
            onClick={() => checkAuth()}
            style={{
              marginTop: '1rem',
              border: 'none',
              borderRadius: '12px',
              padding: '0.8rem 1.1rem',
              background: 'linear-gradient(135deg, #2563eb, #10b981)',
              color: '#ffffff',
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            Retry Session Check
          </button>
        </div>
      </div>
    );
  }

  // Redirect to login if not authenticated
  if (!user) {
    console.log('❌ Not authenticated, redirecting to login');
    return <Navigate to="/login" replace />;
  }

  // Render protected component if authenticated
  return children;
};

export default ProtectedRoute;
