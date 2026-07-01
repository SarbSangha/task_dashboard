import React, { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useTheme } from '../../context/ThemeContext';
import { authAPI } from '../../services/api';
import './Login.css';
import './Register.css';

const FALLBACK_DEPARTMENTS = [
  'CREATIVE',
  'CONTENT',
  'CONTENT CREATOR',
  'CRACK TEAM',
  'DIGITAL',
  'GEN AI',
  'INTERNAL BRANDS',
  '3D Visualizer',
];

const Register = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    position: '',
    department: '',
  });
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [departmentOptions, setDepartmentOptions] = useState(FALLBACK_DEPARTMENTS);
  const [isThemeMenuOpen, setIsThemeMenuOpen] = useState(false);
  const themeMenuRef = useRef(null);
  const { register } = useAuth();
  const { isDarkMode, toggleTheme } = useTheme();
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;

    const loadDepartments = async () => {
      try {
        const response = await authAPI.getDepartments();
        if (!mounted) return;

        const mergedDepartments = Array.from(
          new Set([
            ...(Array.isArray(response?.departments) ? response.departments : []),
            ...FALLBACK_DEPARTMENTS,
          ])
        );

        setDepartmentOptions(mergedDepartments.sort((left, right) => left.localeCompare(right)));
      } catch {
        if (!mounted) return;
        setDepartmentOptions(FALLBACK_DEPARTMENTS);
      }
    };

    void loadDepartments();

    return () => {
      mounted = false;
    };
  }, []);

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

  const handleChange = (e) => {
    const { name, value } = e.target;

    if (name === 'position' && value === 'FACULTY') {
      setFormData({
        ...formData,
        [name]: value,
        department: '',
      });
    } else {
      setFormData({
        ...formData,
        [name]: value,
      });
    }

    if (error) setError('');
  };

  const validateForm = () => {
    if (formData.name.length < 2) {
      setError('Name must be at least 2 characters');
      return false;
    }

    if (!formData.email.includes('@')) {
      setError('Please enter a valid email');
      return false;
    }

    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters');
      return false;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return false;
    }

    if (!formData.position) {
      setError('Please select a position');
      return false;
    }

    if (formData.position !== 'FACULTY' && !formData.department) {
      setError('Please select a department');
      return false;
    }

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSuccessMessage('');

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      const result = await register(
        formData.email,
        formData.password,
        formData.name,
        formData.position,
        formData.department
      );

      if (result.success) {
        setSuccessMessage(result.message || 'Registration submitted. Wait for admin approval.');
        setTimeout(() => navigate('/login'), 2000);
      } else {
        setError(result.error || 'Registration failed');
      }
    } catch (err) {
      console.error('Registration error:', err);

      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;

        if (Array.isArray(detail)) {
          const errors = detail
            .map((entry) => {
              const field = entry.loc[entry.loc.length - 1];
              return `${field}: ${entry.msg}`;
            })
            .join(', ');
          setError(errors);
        } else {
          setError(detail);
        }
      } else {
        setError('Registration failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page register-page">
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

      <div className="login-card login-card--glass register-card">
        <div className="login-card-header register-card-header">
          <h1 className="login-title">Create Account</h1>
          <p className="login-subtitle">Join us today!</p>
        </div>

        {error && (
          <div className="login-error-card">
            <div className="login-error-header">
              <span className="login-error-icon">⚠</span>
              <span className="login-error-title">Registration Failed</span>
            </div>
            <div className="login-error-message">{error}</div>
          </div>
        )}

        {successMessage && (
          <div className="register-success-card" role="status" aria-live="polite">
            <div className="register-success-icon">✓</div>
            <div className="register-success-copy">
              <span className="register-success-title">Registration Submitted</span>
              <span className="register-success-message">{successMessage}</span>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} noValidate className="register-form">
          <div className="login-form-group">
            <label htmlFor="name" className="login-label">
              Full Name *
            </label>
            <input
              type="text"
              id="name"
              name="name"
              value={formData.name}
              onChange={handleChange}
              className="login-input"
              placeholder="John Doe"
              autoComplete="name"
            />
          </div>

          <div className="login-form-group">
            <label htmlFor="email" className="login-label">
              Email *
            </label>
            <input
              type="email"
              id="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              className="login-input"
              placeholder="your@email.com"
              autoComplete="email"
            />
          </div>

          <div className="login-form-group">
            <label htmlFor="position" className="login-label">
              Position *
            </label>
            <select
              id="position"
              name="position"
              value={formData.position}
              onChange={handleChange}
              className="login-input register-select"
            >
              <option value="">Select Position</option>
              <option value="HOD">HOD - Head of Department</option>
              <option value="FACULTY">Faculty Member</option>
              <option value="NORMAL">Normal User</option>
            </select>
            <small className="register-hint">Choose your role in the organization</small>
          </div>

          {formData.position !== 'FACULTY' && (
            <div className="login-form-group">
              <label htmlFor="department" className="login-label">
                Department *
              </label>
              <select
                id="department"
                name="department"
                value={formData.department}
                onChange={handleChange}
                className="login-input register-select"
              >
                <option value="">Select Department</option>
                {departmentOptions.map((department) => (
                  <option key={department} value={department}>
                    {department}
                  </option>
                ))}
              </select>
              <small className="register-hint">Choose your department</small>
            </div>
          )}

          <div className="login-form-group">
            <label htmlFor="password" className="login-label">
              Password *
            </label>
            <input
              type="password"
              id="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              className="login-input"
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <small className="register-hint">At least 6 characters</small>
          </div>

          <div className="login-form-group">
            <label htmlFor="confirmPassword" className="login-label">
              Confirm Password *
            </label>
            <input
              type="password"
              id="confirmPassword"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              className="login-input"
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          <button type="submit" disabled={loading} className="login-submit-button">
            {loading ? 'Creating Account...' : 'Sign Up'}
          </button>
        </form>

        <div className="login-footer">
          <span className="login-footer-text">Already have an account?</span>
          <Link to="/login" className="login-link">
            Sign In
          </Link>
        </div>
      </div>
    </div>
  );
};

export default Register;
