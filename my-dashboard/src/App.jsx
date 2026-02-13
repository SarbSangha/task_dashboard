import React, { useRef } from 'react';
import './App.css';

import Topnavbar from './components/navbar/top/Topnavbar';
import FunctionalMenu from './components/leftsidebar/Leftside';
import AIAssistant from './components/aiAssistant/AIAssistant';
import RMWHero from './components/hero/RMWHero';

import { useAuth } from './context/AuthContext';

function App() {
  const { user } = useAuth();

  const trackingRef = useRef(null);

  const handleStartTrack = () => {
    if (trackingRef.current) {
      trackingRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };


  return (
    <div className="App">

      {/* Top Navbar */}
      <Topnavbar />

      {/* Optional: user info + logout (can move this into Topnavbar later) */}
      <div
        style={{
          padding: '12px 20px',
          background: '#f5f5f5',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }}
      >
        <div>
          <strong>Welcome, {user?.name}</strong>
          <div style={{ fontSize: '13px', color: '#666' }}>
            {user?.email}
          </div>
        </div>
      </div>

      {/* Left Sidebar */}
      <FunctionalMenu />

      {/* AI Assistant */}
      <AIAssistant />

      {/* Hero Section */}
      <RMWHero onStartTrack={handleStartTrack} />

      {/* Main Content Area */}
      <main className="App-content" ref={trackingRef}>
        <div className="content-container">
          <h1>Global Tracking System</h1>
          <p>Welcome to your dashboard. Select a menu item to get started.</p>

          <div className="placeholder-content">
            <div className="placeholder-card">
              <h3>Quick Stats</h3>
              <p>Your content will appear here</p>
            </div>

            <div className="placeholder-card">
              <h3>Recent Activity</h3>
              <p>Your content will appear here</p>
            </div>

            <div className="placeholder-card">
              <h3>Notifications</h3>
              <p>Your content will appear here</p>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

export default App;
