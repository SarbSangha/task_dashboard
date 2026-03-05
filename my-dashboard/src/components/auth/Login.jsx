// src/components/auth/Login.jsx
import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
// import './Login.css'; // ✅ Import CSS file

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setErrorDetails(null);
    setLoading(true);

    if (!email || !password) {
      setError('Please fill in all fields');
      setLoading(false);
      return;
    }

    try {
      const result = await login(email, password, rememberMe);
      
      if (result.success) {
        // Save rememberMe preference to localStorage to sync with profile/security menu
        localStorage.setItem('keepLoggedIn', rememberMe.toString());
        console.log('✅ Redirecting to dashboard...');
        navigate('/dashboard');
      } else {
        const fallbackMessage = result.error || 'Login failed';
        setError(fallbackMessage);
        setErrorDetails(
          result.errorDetails || {
            message: fallbackMessage,
            code: null,
            reason: null,
            nextAction: null,
          }
        );
      }
    } catch (err) {
      console.error('Unexpected error:', err);
      setError('An unexpected error occurred');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={{ marginBottom: '30px' }}>
          <h2 style={styles.title}>Welcome Back</h2>
          <p style={styles.subtitle}>Sign in to continue to your dashboard</p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div style={styles.errorCard}>
              <div style={styles.errorHeader}>
                <span style={styles.errorIcon}>⚠</span>
                <span style={styles.errorTitle}>
                  {errorDetails?.code === 'ACCOUNT_PENDING_APPROVAL' ? 'Approval Pending' : 'Login Failed'}
                </span>
              </div>
              <div style={styles.errorMessage}>{errorDetails?.message || error}</div>
              {errorDetails?.reason && (
                <div style={styles.errorReason}>
                  <strong>Reason:</strong> {errorDetails.reason}
                </div>
              )}
              {errorDetails?.nextAction && (
                <div style={styles.errorHint}>{errorDetails.nextAction}</div>
              )}
            </div>
          )}

          <div style={styles.formGroup}>
            <label htmlFor="email" style={styles.label}>Email / Username</label>
            <input
              type="text"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email or username"
              required
              disabled={loading}
              style={styles.input}
            />
          </div>

          <div style={styles.formGroup}>
            <label htmlFor="password" style={styles.label}>Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              minLength={6}
              disabled={loading}
              style={styles.input}
            />
          </div>

          <div style={styles.optionsRow}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={loading}
                style={{ marginRight: '8px', cursor: 'pointer' }}
              />
              <span style={{ fontSize: '14px', color: '#555' }}>Remember me</span>
            </label>
            <Link to="/forgot-password" style={styles.linkSmall}>
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={loading}
            style={{
              ...styles.button,
              opacity: loading ? 0.7 : 1,
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? '⏳ Signing in...' : 'Sign In'}
          </button>
        </form>

        <div style={styles.footer}>
          <span style={styles.footerText}>Don't have an account?</span>
          <Link to="/register" style={styles.link}>Sign up</Link>
        </div>
      </div>
    </div>
  );
};

const styles = {
  container: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    padding: '20px'
  },
  card: {
    background: 'white',
    padding: '40px',
    borderRadius: '12px',
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)',
    width: '400px',
    maxWidth: '100%'
  },
  title: {
    margin: '0 0 10px 0',
    fontSize: '28px',
    color: '#333',
    fontWeight: '700'
  },
  subtitle: {
    color: '#666',
    fontSize: '14px',
    margin: 0
  },
  formGroup: {
    marginBottom: '20px'
  },
  label: {
    display: 'block',
    marginBottom: '8px',
    color: '#333',
    fontWeight: '500',
    fontSize: '14px'
  },
  input: {
    width: '100%',
    padding: '12px',
    border: '1px solid #ddd',
    borderRadius: '6px',
    fontSize: '14px',
    boxSizing: 'border-box',
    outline: 'none',
    transition: 'border-color 0.3s'
  },
  optionsRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px'
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer'
  },
  button: {
    width: '100%',
    padding: '14px',
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    color: 'white',
    border: 'none',
    borderRadius: '6px',
    fontSize: '16px',
    fontWeight: '600',
    transition: 'all 0.3s',
    marginTop: '5px'
  },
  errorCard: {
    background: 'linear-gradient(180deg, #fff8f8 0%, #fff2f2 100%)',
    color: '#7f1d1d',
    padding: '14px',
    borderRadius: '10px',
    marginBottom: '20px',
    border: '1px solid #fecaca',
    boxShadow: '0 4px 16px rgba(185, 28, 28, 0.12)'
  },
  errorHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '6px'
  },
  errorIcon: {
    width: '20px',
    height: '20px',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    background: '#ef4444',
    color: '#fff',
    fontSize: '12px',
    fontWeight: 700
  },
  errorTitle: {
    fontSize: '14px',
    fontWeight: 700,
    color: '#991b1b'
  },
  errorMessage: {
    fontSize: '14px',
    lineHeight: 1.4
  },
  errorReason: {
    marginTop: '8px',
    fontSize: '13px',
    lineHeight: 1.4,
    color: '#7f1d1d',
    background: '#fee2e2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    padding: '8px 10px'
  },
  errorHint: {
    marginTop: '8px',
    fontSize: '12px',
    color: '#9f1239'
  },
  linkSmall: {
    color: '#667eea',
    textDecoration: 'none',
    fontSize: '13px'
  },
  footer: {
    marginTop: '25px',
    textAlign: 'center',
    paddingTop: '20px',
    borderTop: '1px solid #eee'
  },
  footerText: {
    color: '#666',
    fontSize: '14px',
    marginRight: '8px'
  },
  link: {
    color: '#667eea',
    textDecoration: 'none',
    fontWeight: '600',
    fontSize: '14px'
  }
};

export default Login;
