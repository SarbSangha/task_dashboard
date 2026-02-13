import React, { useState, useEffect } from 'react';
import { useKeepLoggedIn } from './KeepLoggedInManager';
import './LoginSecurityPanel.css';

const LoginSecurityPanel = ({ isOpen, onClose }) => {
  const { isEnabled, toggle } = useKeepLoggedIn();
  const [message, setMessage] = useState('');

  if (!isOpen) return null;

  const handleToggle = () => {
    const newValue = toggle();
    
    // Show feedback message
    setMessage(
      newValue 
        ? '✓ You will stay logged in for 30 days' 
        : '✓ Session will expire in 24 hours'
    );
    
    // Clear message after 3 seconds
    setTimeout(() => setMessage(''), 3000);
  };

 return (
  <>
    {/* Overlay */}
    <div 
      className="login-security-overlay"
      onClick={onClose}
    />

    {/* Panel */}
    <div className="login-security-panel">
      
      {/* Header */}
      <div className="login-security-header">
        <h2>Login & Security</h2>
        <button 
          onClick={onClose}
          className="close-btn"
        >
          {/* Close SVG */}
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      {/* Success Message */}
      {message && (
        <div className="message message-success">
          {message}
        </div>
      )}

      {/* Content */}
      <div className="login-security-content">
        
        {/* Keep Me Logged In Section */}
        <div className="security-card">
          <div className="card-icon checkbox-icon">
            <input
              type="checkbox"
              id="keepLoggedIn"
              checked={isEnabled}
              onChange={handleToggle}
              className="custom-checkbox"
            />
          </div>
          <div className="card-content">
            <label 
              htmlFor="keepLoggedIn" 
              className="card-title"
              style={{ cursor: 'pointer', display: 'block' }}
            >
              Keep me logged in
            </label>
            {/* <p className="card-description">
              Stay signed in for 30 days. 
            </p> */}
            <div className="card-status">
              {isEnabled ? (
                <span className="status-badge active">
                  {/* Check SVG */}
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ marginRight: "6px" }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Active - Expires in 30 days
                </span>
              ) : (
                <span className="status-badge inactive">
                  Session expires in 24 hours
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Forgot Password Section */}
        <div className="security-card">
          <div className="card-icon lock-icon">
            {/* Lock SVG */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
          </div>
          <div className="card-content">
            <div className="card-title">
              Forgot Password / Recovery
            </div>
            {/* <p className="card-description">
              Reset your password or recover your account access
            </p> */}
          </div>
        </div>

        {/* System Status Section */}
        <div className="security-card">
          <div className="card-icon status-icon">
            {/* Check Circle SVG */}
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="10" />
              <polyline points="9 12 12 15 16 9" />
            </svg>
          </div>
          <div className="card-content">
            <div className="card-title">
              System Status
            </div>
            <p className="card-description">
              All systems operational
            </p>
          </div>
        </div>

      </div>

      {/* Footer */}
      <div className="login-security-footer">
        <span className="footer-icon">
          {/* Lightbulb SVG */}
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M9 18h6" />
            <path d="M10 22h4" />
            <path d="M12 2a7 7 0 0 0-4 12c.6.6 1 1.4 1 2h6c0-.6.4-1.4 1-2a7 7 0 0 0-4-12z" />
          </svg>
        </span>
        <p className="footer-text">
          Your security is our priority. Enable all features for maximum protection.
        </p>
      </div>

    </div>
  </>
);

};

export default LoginSecurityPanel;