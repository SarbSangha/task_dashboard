// src/main.jsx

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import './index.css';

// Panels load their code on first open. A tab left open across a deploy asks
// for files the new build replaced; reload once to pick the new build up
// (at most once a minute, so a real outage cannot loop the page).
window.addEventListener('vite:preloadError', (event) => {
  try {
    const last = Number(sessionStorage.getItem('rmw_chunk_reload_at') || 0);
    if (Date.now() - last < 60_000) return;
    sessionStorage.setItem('rmw_chunk_reload_at', String(Date.now()));
  } catch {
    // storage blocked: still reload once
  }
  event.preventDefault();
  window.location.reload();
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
  
);
