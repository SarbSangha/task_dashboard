// src/components/auth/Login.jsx
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import './Login.css';

const Login = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [errorDetails, setErrorDetails] = useState(null);
  const [loading, setLoading] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const { login } = useAuth();
  const { isDarkMode, toggleTheme } = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isThemeMenuOpen) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (!themeMenuRef.current?.contains(event.target)) {
        setIsThemeMenuOpen(false);
      }
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setIsThemeMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isThemeMenuOpen]);

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
    <div className="login-page">
      <div className="login-wordmark-background" aria-hidden="true">
        <span className="login-wordmark-letter login-wordmark-letter--left">R</span>
        <span className="login-wordmark-letter login-wordmark-letter--center">M</span>
        <span className="login-wordmark-letter login-wordmark-letter--right">W</span>
      </div>

      <div className="login-theme-panel" ref={themeMenuRef}>
        <button
          type="button"
          className="login-theme-trigger"
          aria-label="Open appearance settings"
          aria-expanded={isThemeMenuOpen}
          onClick={() => setIsThemeMenuOpen((open) => !open)}
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14 12.94a7.43 7.43 0 0 0 .06-.94 7.43 7.43 0 0 0-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.45 7.45 0 0 0-1.63-.94L14.4 2.81a.5.5 0 0 0-.49-.41h-3.82a.5.5 0 0 0-.49.41l-.36 2.55c-.58.23-1.12.55-1.62.94l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.88a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94L2.83 14.56a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.39 1.04.71 1.62.94l.36 2.55a.5.5 0 0 0 .49.41h3.82a.5.5 0 0 0 .49-.41l.36-2.55c.59-.23 1.13-.55 1.63-.94l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z" />
          </svg>
        </button>

        {isThemeMenuOpen && (
          <div className="login-theme-popover">
            <div className="login-theme-popover-header">
              <span>Appearance</span>
            </div>
            <button
              type="button"
              className="login-theme-toggle"
              onClick={toggleTheme}
              aria-label={`Switch to ${isDarkMode ? 'light' : 'dark'} theme`}
            >
              <div className="login-theme-toggle-copy">
                <span className="login-theme-toggle-title">Theme</span>
                <span className="login-theme-toggle-value">
                  {isDarkMode ? 'Dark mode' : 'Light mode'}
                </span>
              </div>
              <span className={`login-theme-switch ${isDarkMode ? 'is-on' : ''}`} aria-hidden="true">
                <span className="login-theme-switch-thumb" />
              </span>
            </button>
          </div>
        )}
      </div>

      <div className="login-card login-card--glass">
        <div className="login-card-header">
          <h2 className="login-title">Welcome Back</h2>
          <p className="login-subtitle">Sign in to continue to your dashboard</p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="login-error-card">
              <div className="login-error-header">
                <span className="login-error-icon">⚠</span>
                <span className="login-error-title">
                  {errorDetails?.code === 'ACCOUNT_PENDING_APPROVAL' ? 'Approval Pending' : 'Login Failed'}
                </span>
              </div>
              <div className="login-error-message">{errorDetails?.message || error}</div>
              {errorDetails?.reason && (
                <div className="login-error-reason">
                  <strong>Reason:</strong> {errorDetails.reason}
                </div>
              )}
              {errorDetails?.nextAction && (
                <div className="login-error-hint">{errorDetails.nextAction}</div>
              )}
            </div>
          )}

          <div className="login-form-group">
            <label htmlFor="email" className="login-label">Email</label>
            <input
              type="text"
              id="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="Enter your email"
              required
              disabled={loading}
              className="login-input"
            />
          </div>

          <div className="login-form-group">
            <label htmlFor="password" className="login-label">Password</label>
            <input
              type="password"
              id="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              required
              minLength={6}
              disabled={loading}
              className="login-input"
            />
          </div>

          <div className="login-options-row">
            <label className="login-checkbox-label">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={loading}
                className="login-checkbox"
              />
              <span className="login-checkbox-text">Remember me</span>
            </label>
            <Link to="/forgot-password" className="login-link-small">
              Forgot password?
            </Link>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="login-submit-button"
          >
            {loading ? '⏳ Signing in...' : 'Sign In'}
          </button>
        </form>

        <div className="login-footer">
          <span className="login-footer-text">Don't have an account?</span>
          <Link to="/register" className="login-link">Sign up</Link>
        </div>
      </div>
    </div>
  );
};

export default Login;
