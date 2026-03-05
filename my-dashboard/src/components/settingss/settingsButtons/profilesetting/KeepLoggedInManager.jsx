import React, { useState, useEffect } from 'react';

export const KeepLoggedInManager = ({ onToggle }) => {
  const [isEnabled, setIsEnabled] = useState(false);

  // Load saved preference on mount
  useEffect(() => {
    const savedPreference = localStorage.getItem('keepLoggedIn') === 'true';
    setIsEnabled(savedPreference);
  }, []);

  const handleToggle = () => {
    const newValue = !isEnabled;
    setIsEnabled(newValue);
    
    // Save to localStorage
    localStorage.setItem('keepLoggedIn', newValue.toString());
    
    // Trigger storage event for other components
    window.dispatchEvent(new Event('keepLoggedInChanged'));
    
    // Notify parent component
    if (onToggle) {
      onToggle(newValue);
    }
  };

  return {
    isEnabled,
    toggle: handleToggle
  };
};

// Hook to use in your components
export const useKeepLoggedIn = () => {
  const [isEnabled, setIsEnabled] = useState(false);

  useEffect(() => {
    // Load initial value
    const savedPreference = localStorage.getItem('keepLoggedIn') === 'true';
    setIsEnabled(savedPreference);

    // Listen for storage changes from other tabs/windows
    const handleStorageChange = (e) => {
      if (e.key === 'keepLoggedIn') {
        setIsEnabled(e.newValue === 'true');
      }
    };

    // Listen for custom event from same component
    const handleKeepLoggedInChanged = () => {
      const savedPreference = localStorage.getItem('keepLoggedIn') === 'true';
      setIsEnabled(savedPreference);
    };

    window.addEventListener('storage', handleStorageChange);
    window.addEventListener('keepLoggedInChanged', handleKeepLoggedInChanged);

    return () => {
      window.removeEventListener('storage', handleStorageChange);
      window.removeEventListener('keepLoggedInChanged', handleKeepLoggedInChanged);
    };
  }, []);

  const toggle = () => {
    const newValue = !isEnabled;
    setIsEnabled(newValue);
    localStorage.setItem('keepLoggedIn', newValue.toString());
    
    // Trigger custom event to notify other components in same tab
    window.dispatchEvent(new Event('keepLoggedInChanged'));
    
    return newValue;
  };

  const isRememberMeEnabled = () => {
    return localStorage.getItem('keepLoggedIn') === 'true';
  };

  return {
    isEnabled,
    toggle,
    isRememberMeEnabled
  };
};
