import React, { useState, useCallback } from 'react';
import Topnavbar from '../components/navbar/top/Topnavbar';
import FunctionalMenu from '../components/leftsidebar/Leftside';
import AIAssistant from '../components/aiAssistant/AIAssistant';
import AIHubHome from '../components/home/AIHubHome';
import useBackgroundRealtimeAlerts from '../hooks/useBackgroundRealtimeAlerts';
import useWebPushNotifications from '../hooks/useWebPushNotifications';

const PUSH_STATUS_LABELS = {
  active: 'Active',
  checking: 'Checking',
  permission_required: 'Needs permission',
  permission_denied: 'Blocked',
  server_disabled: 'Server off',
  unsupported: 'Unsupported',
  inactive: 'Inactive',
  error: 'Error',
};

const Dashboard = () => {
  useBackgroundRealtimeAlerts();
  const pushStatus = useWebPushNotifications();
  const pushCode = PUSH_STATUS_LABELS[pushStatus?.code] ? pushStatus.code : 'checking';
  const pushMeta = { code: pushCode, label: PUSH_STATUS_LABELS[pushCode] };

  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);

  const handleHamburgerClick = useCallback(() => {
    setIsMobileMenuOpen((v) => !v);
  }, []);

  const handleMobileMenuClose = useCallback(() => {
    setIsMobileMenuOpen(false);
  }, []);

  return (
    <div className="App">
      <Topnavbar onHamburgerClick={handleHamburgerClick} isMobileMenuOpen={isMobileMenuOpen} />

      <FunctionalMenu isMobileOpen={isMobileMenuOpen} onMobileClose={handleMobileMenuClose} />
      <AIAssistant />
      <main className="App-content">
        <AIHubHome pushMeta={pushMeta} pushDetail={pushStatus?.detail} />
      </main>
    </div>
  );
};

export default Dashboard;
