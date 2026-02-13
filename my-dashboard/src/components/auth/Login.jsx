import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {e.preventDefault();
    setError('');
    setLoading(true);

    try {
      // Check if "Keep me logged in" is enabled
      const rememberMe = localStorage.getItem('keepLoggedIn') === 'true';
      
      await login(email, password, rememberMe);
      navigate('/');
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid email or password');
    } finally {
      setLoading(false);
    }};

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Welcome Back</h1>
        <p style={styles.subtitle}>Sign in to your dashboard</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              style={styles.input}
              placeholder="your@email.com"
              autoComplete="email"
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={styles.input}
              placeholder="••••••••"
              autoComplete="current-password"
            />
          </div>

          {/* Remember Me Checkbox */}
          <div style={styles.checkboxGroup}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                style={styles.checkbox}
              />
              <span style={styles.checkboxText}>Keep me logged in (30 days)</span>
            </label>
          </div>

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? 'Signing in...' : 'Sign In'}
          </button>

          {/* Forgot Password Link */}
          <div style={styles.forgotPassword}>
            <Link to="/forgot-password" style={styles.linkSmall}>
              Forgot Password?
            </Link>
          </div>
        </form>

        <div style={styles.footer}>
          <span style={styles.footerText}>Don't have an account?</span>
          <Link to="/register" style={styles.link}>Sign Up</Link>
        </div>
      </div>
    </div>
  );
}

const styles = {
  container: { 
    display: 'flex', 
    justifyContent: 'center', 
    alignItems: 'center', 
    minHeight: '100vh', 
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' 
  },
  card: { 
    background: 'white', 
    padding: '40px', 
    borderRadius: '12px', 
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)', 
    width: '400px',
    maxWidth: '90%'
  },
  title: { 
    margin: '0 0 10px 0', 
    fontSize: '28px', 
    color: '#333',
    fontWeight: '700'
  },
  subtitle: { 
    color: '#666', 
    marginBottom: '30px', 
    fontSize: '14px' 
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
    boxSizing: 'border-box'
  },
  checkboxGroup: {
    marginBottom: '20px'
  },
  checkboxLabel: {
    display: 'flex',
    alignItems: 'center',
    cursor: 'pointer'
  },
  checkbox: {
    width: '18px',
    height: '18px',
    marginRight: '8px',
    cursor: 'pointer'
  },
  checkboxText: {
    fontSize: '14px',
    color: '#555'
  },
  button: { 
    width: '100%', 
    padding: '14px', 
    background: '#667eea', 
    color: 'white', 
    border: 'none', 
    borderRadius: '6px', 
    cursor: 'pointer', 
    fontSize: '16px',
    fontWeight: '600',
    transition: 'background 0.3s'
  },
  error: { 
    background: '#fee', 
    color: '#c33', 
    padding: '12px', 
    borderRadius: '6px', 
    marginBottom: '20px',
    fontSize: '14px',
    border: '1px solid #fcc'
  },
  forgotPassword: {
    textAlign: 'center',
    marginTop: '15px'
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
