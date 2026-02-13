import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export function Register() {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    position: '' // User position/role
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { register } = useAuth();
  const navigate = useNavigate();

  const handleChange = (e) => {
    setFormData({
      ...formData,
      [e.target.name]: e.target.value
    });
    // Clear error when user types
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

    return true;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!validateForm()) {
      return;
    }

    setLoading(true);

    try {
      // Pass all required data to register function
      await register(
        formData.email, 
        formData.password, 
        formData.name, 
        formData.position
      );
      
      console.log('✅ Registration successful!');
      navigate('/');
    } catch (err) {
      console.error('❌ Registration error:', err);
      
      // Handle different error types
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        
        // If detail is array (Pydantic validation errors)
        if (Array.isArray(detail)) {
          const errors = detail.map(e => {
            const field = e.loc[e.loc.length - 1];
            return `${field}: ${e.msg}`;
          }).join(', ');
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
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Create Account</h1>
        <p style={styles.subtitle}>Join us today!</p>

        {error && <div style={styles.error}>⚠️ {error}</div>}

        <form onSubmit={handleSubmit}>
          {/* Full Name */}
          <div style={styles.formGroup}>
            <label style={styles.label}>Full Name *</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              required
              style={styles.input}
              placeholder="John Doe"
              autoComplete="name"
              minLength={2}
            />
          </div>

          {/* Email */}
          <div style={styles.formGroup}>
            <label style={styles.label}>Email *</label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              required
              style={styles.input}
              placeholder="your@email.com"
              autoComplete="email"
            />
          </div>

          {/* Position - Dropdown */}
          <div style={styles.formGroup}>
            <label htmlFor="position" style={styles.label}>
              Position *
            </label>
            <select
              id="position"
              name="position"
              value={formData.position}
              onChange={handleChange}
              required
              style={styles.select}
            >
              <option value="">Select Position</option>
              <option value="HOD">HOD - Head of Department</option>
              <option value="FACULTY">Faculty Member</option>
              <option value="NORMAL">Normal User</option>
            </select>
            <small style={styles.hint}>Choose your role in the organization</small>
          </div>

          {/* Password */}
          <div style={styles.formGroup}>
            <label style={styles.label}>Password *</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              required
              style={styles.input}
              placeholder="••••••••"
              autoComplete="new-password"
              minLength={6}
            />
            <small style={styles.hint}>At least 6 characters</small>
          </div>

          {/* Confirm Password */}
          <div style={styles.formGroup}>
            <label style={styles.label}>Confirm Password *</label>
            <input
              type="password"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              required
              style={styles.input}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

          {/* Submit Button */}
          <button 
            type="submit" 
            disabled={loading} 
            style={{
              ...styles.button,
              opacity: loading ? 0.6 : 1,
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            {loading ? '⏳ Creating Account...' : '✨ Sign Up'}
          </button>
        </form>

        {/* Footer */}
        <div style={styles.footer}>
          <span style={styles.footerText}>Already have an account?</span>
          <Link to="/login" style={styles.link}>Sign In</Link>
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
    background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    padding: '20px'
  },
  card: { 
    background: 'white', 
    padding: '40px', 
    borderRadius: '12px', 
    boxShadow: '0 10px 40px rgba(0,0,0,0.2)', 
    width: '450px',
    maxWidth: '100%'
  },
  title: { 
    margin: '0 0 10px 0', 
    fontSize: '28px', 
    color: '#333',
    fontWeight: '700',
    textAlign: 'center'
  },
  subtitle: { 
    color: '#666', 
    marginBottom: '30px', 
    fontSize: '14px',
    textAlign: 'center'
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
    transition: 'border-color 0.3s',
    outline: 'none'
  },
  select: { 
    width: '100%', 
    padding: '12px', 
    border: '1px solid #ddd', 
    borderRadius: '6px', 
    fontSize: '14px',
    boxSizing: 'border-box',
    transition: 'border-color 0.3s',
    outline: 'none',
    backgroundColor: 'white',
    cursor: 'pointer'
  },
  hint: {
    display: 'block',
    marginTop: '5px',
    fontSize: '12px',
    color: '#999'
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
    transition: 'all 0.3s',
    marginTop: '10px'
  },
  error: { 
    background: '#fee', 
    color: '#c33', 
    padding: '12px', 
    borderRadius: '6px', 
    marginBottom: '20px',
    fontSize: '14px',
    border: '1px solid #fcc',
    animation: 'shake 0.3s'
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
    fontSize: '14px',
    transition: 'color 0.3s'
  }
};
