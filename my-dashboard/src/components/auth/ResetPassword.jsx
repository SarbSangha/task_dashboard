import React, { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import axios from 'axios';

export function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

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
      await axios.post('http://127.0.0.1:8000/api/auth/reset-password', {
        token,
        new_password: password
      });
      alert('Password reset successfully! Please login.');
      navigate('/login');
    } catch (err) {
      setError(err.response?.data?.detail || 'Invalid or expired token');
    } finally {
      setLoading(false);
    }
  };

  if (!token) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <h1 style={styles.title}>Invalid Link</h1>
          <p>This password reset link is invalid.</p>
          <Link to="/forgot-password" style={styles.link}>Request a new link</Link>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Create New Password</h1>
        <p style={styles.subtitle}>Enter your new password</p>

        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleSubmit}>
          <div style={styles.formGroup}>
            <label style={styles.label}>New Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={styles.input}
              placeholder="••••••••"
              minLength={6}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              style={styles.input}
              placeholder="••••••••"
            />
          </div>

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
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
  button: { 
    width: '100%', 
    padding: '14px', 
    background: '#667eea', 
    color: 'white', 
    border: 'none', 
    borderRadius: '6px', 
    cursor: 'pointer', 
    fontSize: '16px',
    fontWeight: '600'
  },
  error: { 
    background: '#fee', 
    color: '#c33', 
    padding: '12px', 
    borderRadius: '6px', 
    marginBottom: '20px',
    fontSize: '14px'
  },
  link: {
    color: '#667eea',
    textDecoration: 'none'
  }
};
