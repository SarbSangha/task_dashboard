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
    const savedPreference = localStorage.getItem('keepLoggedIn') === 'true';
    setIsEnabled(savedPreference);
  }, []);

  const toggle = () => {
    const newValue = !isEnabled;
    setIsEnabled(newValue);
    localStorage.setItem('keepLoggedIn', newValue.toString());
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
