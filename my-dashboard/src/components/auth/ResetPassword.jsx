import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import axios from 'axios';
import { useTheme } from '../../context/ThemeContext';
import { useCustomDialogs } from '../common/CustomDialogs';
import './Login.css';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

export function ResetPassword() {
  const { showAlert } = useCustomDialogs();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const { isDarkMode, toggleTheme } = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    if (!isThemeMenuOpen) return undefined;

    const handlePointerDown = (e) => {
      if (!themeMenuRef.current?.contains(e.target)) setIsThemeMenuOpen(false);
    };
    const handleEscape = (e) => {
      if (e.key === 'Escape') setIsThemeMenuOpen(false);
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

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setLoading(true);
    try {
      await axios.post(`${API_BASE}/api/auth/reset-password`, {
        token,
        new_password: password,
      });
      await showAlert('Password reset successfully! Please login.', { title: 'Success' });
      navigate('/login');
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid or expired token');
    } finally {
      setLoading(false);
    }
  };

  const ThemePanel = (
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
  );

  const Wordmark = (
    <div className="login-wordmark-background" aria-hidden="true">
      <span className="login-wordmark-letter login-wordmark-letter--left">R</span>
      <span className="login-wordmark-letter login-wordmark-letter--center">M</span>
      <span className="login-wordmark-letter login-wordmark-letter--right">W</span>
    </div>
  );

  if (!token) {
    return (
      <div className="login-page">
        {Wordmark}
        {ThemePanel}
        <div className="login-card login-card--glass">
          <div className="login-card-header">
            <h1 className="login-title">Invalid Link</h1>
            <p className="login-subtitle">This password reset link is invalid or has expired.</p>
          </div>
          <div className="login-footer">
            <Link to="/forgot-password" className="login-link">Request a new link</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="login-page">
      {Wordmark}
      {ThemePanel}

      <div className="login-card login-card--glass">
        <div className="login-card-header">
          <h1 className="login-title">Create New Password</h1>
          <p className="login-subtitle">Enter your new password below</p>
        </div>

        {error && (
          <div className="login-error-card">
            <div className="login-error-header">
              <span className="login-error-icon">⚠</span>
              <span className="login-error-title">Error</span>
            </div>
            <div className="login-error-message">{error}</div>
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div className="login-form-group">
            <label htmlFor="rp-password" className="login-label">New Password</label>
            <input
              type="password"
              id="rp-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={loading}
              minLength={6}
              className="login-input"
              placeholder="••••••••"
            />
          </div>

          <div className="login-form-group">
            <label htmlFor="rp-confirm" className="login-label">Confirm Password</label>
            <input
              type="password"
              id="rp-confirm"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              disabled={loading}
              className="login-input"
              placeholder="••••••••"
            />
          </div>

          <button type="submit" disabled={loading} className="login-submit-button">
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>

        <div className="login-footer">
          <Link to="/login" className="login-link">← Back to Login</Link>
        </div>
      </div>
    </div>
  );
}
