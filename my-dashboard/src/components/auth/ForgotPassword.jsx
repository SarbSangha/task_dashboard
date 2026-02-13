import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import axios from 'axios';

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setMessage('');
    setLoading(true);

    try {
      const response = await axios.post('http://127.0.0.1:8000/api/auth/forgot-password', {
        email
      });
      setMessage(response.data.message);
      setEmail('');
    } catch (err) {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Reset Password</h1>
        <p style={styles.subtitle}>Enter your email to receive a reset link</p>

        {message && <div style={styles.success}>{message}</div>}
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

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? 'Sending...' : 'Send Reset Link'}
          </button>
        </form>

        <div style={styles.footer}>
          <Link to="/login" style={styles.link}>← Back to Login</Link>
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
  success: { 
    background: '#d4edda', 
    color: '#155724', 
    padding: '12px', 
    borderRadius: '6px', 
    marginBottom: '20px',
    fontSize: '14px',
    border: '1px solid #c3e6cb'
  },
  error: { 
    background: '#fee', 
    color: '#c33', 
    padding: '12px', 
    borderRadius: '6px', 
    marginBottom: '20px',
    fontSize: '14px'
  },
  footer: {
    marginTop: '25px',
    textAlign: 'center'
  },
  link: {
    color: '#667eea',
    textDecoration: 'none',
    fontSize: '14px'
  }
};
