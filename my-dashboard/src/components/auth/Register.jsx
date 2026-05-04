// src/components/auth/Register.jsx - FIXED

import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { authAPI } from '../../services/api';

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

// ✅ CHANGED: Use const instead of export function
const Register = () => {
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    password: '',
    confirmPassword: '',
    position: '',
    department: ''
  });
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [departmentOptions, setDepartmentOptions] = useState(FALLBACK_DEPARTMENTS);
  const { register } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;

    const loadDepartments = async () => {
      try {
        const response = await authAPI.getDepartments();
        if (!mounted) return;

        const mergedDepartments = Array.from(new Set([
          ...(Array.isArray(response?.departments) ? response.departments : []),
          ...FALLBACK_DEPARTMENTS,
        ]));

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

  const handleChange = (e) => {
    const { name, value } = e.target;
    
    // Clear department when switching to FACULTY
    if (name === 'position' && value === 'FACULTY') {
      setFormData({
        ...formData,
        [name]: value,
        department: ''
      });
    } else {
      setFormData({
        ...formData,
        [name]: value
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

    // Department is required only if position is not FACULTY
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
        console.log('Registration submitted!');
        setSuccessMessage(result.message || 'Registration submitted. Wait for admin approval.');
        setTimeout(() => navigate('/login'), 2000);
      } else {
        setError(result.error || 'Registration failed');
      }
    } catch (err) {
      console.error('❌ Registration error:', err);
      
      if (err.response?.data?.detail) {
        const detail = err.response.data.detail;
        
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
        {successMessage && <div style={styles.success}>✓ {successMessage}</div>}

        <form onSubmit={handleSubmit} noValidate>
          <div style={styles.formGroup}>
            <label style={styles.label}>Full Name *</label>
            <input
              type="text"
              name="name"
              value={formData.name}
              onChange={handleChange}
              style={styles.input}
              placeholder="John Doe"
              autoComplete="name"
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Email *</label>
            <input
              type="email"
              name="email"
              value={formData.email}
              onChange={handleChange}
              style={styles.input}
              placeholder="your@email.com"
              autoComplete="email"
            />
          </div>

          <div style={styles.formGroup}>
            <label htmlFor="position" style={styles.label}>
              Position *
            </label>
            <select
              id="position"
              name="position"
              value={formData.position}
              onChange={handleChange}
              style={styles.select}
            >
              <option value="">Select Position</option>
              <option value="HOD">HOD - Head of Department</option>
              <option value="FACULTY">Faculty Member</option>
              <option value="NORMAL">Normal User</option>
            </select>
            <small style={styles.hint}>Choose your role in the organization</small>
          </div>

          {formData.position !== 'FACULTY' && (
            <div style={styles.formGroup}>
              <label htmlFor="department" style={styles.label}>
                Department *
              </label>
              <select
                id="department"
                name="department"
                value={formData.department}
                onChange={handleChange}
                style={styles.select}
              >
                <option value="">Select Department</option>
                {departmentOptions.map((department) => (
                  <option key={department} value={department}>
                    {department}
                  </option>
                ))}
              </select>
              <small style={styles.hint}>Choose your department</small>
            </div>
          )}

          <div style={styles.formGroup}>
            <label style={styles.label}>Password *</label>
            <input
              type="password"
              name="password"
              value={formData.password}
              onChange={handleChange}
              style={styles.input}
              placeholder="••••••••"
              autoComplete="new-password"
            />
            <small style={styles.hint}>At least 6 characters</small>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.label}>Confirm Password *</label>
            <input
              type="password"
              name="confirmPassword"
              value={formData.confirmPassword}
              onChange={handleChange}
              style={styles.input}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </div>

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

        <div style={styles.footer}>
          <span style={styles.footerText}>Already have an account?</span>
          <Link to="/login" style={styles.link}>Sign In</Link>
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
    border: '1px solid #fcc'
  },
  success: {
    background: '#ecfdf3',
    color: '#166534',
    padding: '12px',
    borderRadius: '6px',
    marginBottom: '20px',
    fontSize: '14px',
    border: '1px solid #bbf7d0'
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

// ✅ ADD THIS AT THE END
export default Register;
