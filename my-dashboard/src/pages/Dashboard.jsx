import React, { useRef } from 'react';
import Topnavbar from '../components/navbar/top/Topnavbar';
import FunctionalMenu from '../components/leftsidebar/Leftside';
import AIAssistant from '../components/aiAssistant/AIAssistant';
import RMWHero from '../components/hero/RMWHero';
import useBackgroundRealtimeAlerts from '../hooks/useBackgroundRealtimeAlerts';
import useWebPushNotifications from '../hooks/useWebPushNotifications';

const PUSH_STATUS_META = {
  active: { label: 'Active', color: '#047857', background: '#d1fae5' },
  checking: { label: 'Checking', color: '#92400e', background: '#fef3c7' },
  permission_required: { label: 'Needs Permission', color: '#92400e', background: '#fef3c7' },
  permission_denied: { label: 'Blocked', color: '#b91c1c', background: '#fee2e2' },
  server_disabled: { label: 'Server Off', color: '#1d4ed8', background: '#dbeafe' },
  unsupported: { label: 'Unsupported', color: '#6b7280', background: '#f3f4f6' },
  inactive: { label: 'Inactive', color: '#6b7280', background: '#f3f4f6' },
  error: { label: 'Error', color: '#b91c1c', background: '#fee2e2' },
};

const Dashboard = () => {
  const trackingRef = useRef(null);
  useBackgroundRealtimeAlerts();
  const pushStatus = useWebPushNotifications();
  const pushMeta = PUSH_STATUS_META[pushStatus?.code] || PUSH_STATUS_META.checking;

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

            <div className="placeholder-card">
              <h3>Push Status</h3>
              <p>{pushStatus?.detail || 'Checking browser push status...'}</p>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  marginTop: '12px',
                  padding: '6px 12px',
                  borderRadius: '999px',
                  fontSize: '0.85rem',
                  fontWeight: 700,
                  color: pushMeta.color,
                  background: pushMeta.background,
                }}
              >
                {pushMeta.label}
              </span>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default Dashboard;
