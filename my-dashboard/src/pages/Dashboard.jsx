import React, { useRef } from 'react';
import Topnavbar from '../components/navbar/top/Topnavbar';
import FunctionalMenu from '../components/leftsidebar/Leftside';
import AIAssistant from '../components/aiAssistant/AIAssistant';
import RMWHero from '../components/hero/RMWHero';
import useBackgroundRealtimeAlerts from '../hooks/useBackgroundRealtimeAlerts';

const Dashboard = () => {
  const trackingRef = useRef(null);
  useBackgroundRealtimeAlerts();

  const handleStartTrack = () => {
    if (trackingRef.current) {
      trackingRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  };

  return (
    <div className="App">
      <Topnavbar />

      <FunctionalMenu />
      <AIAssistant />
      <RMWHero onStartTrack={handleStartTrack} />
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
};

export default Dashboard;
