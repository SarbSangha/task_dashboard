// Analytics-about-analytics. Instruments the Report Builder itself so we learn
// which reports/questions are actually valuable. No backend yet: routes to an
// optional global hook, else debug-logs in dev. Swap the hook for a real sink later.
export const track = (event, payload = {}) => {
  try {
    if (typeof window !== 'undefined' && typeof window.__analyticsTrack === 'function') {
      window.__analyticsTrack(event, { ...payload, ts: Date.now() });
    } else if (import.meta?.env?.DEV) {
      console.debug('[analytics-library]', event, payload);
    }
  } catch {
    /* never let instrumentation break the UI */
  }
};

// Lightweight recent-reports memory (localStorage), for the executive landing page.
const RECENT_KEY = 'rbv2.recentReports';
export const pushRecent = (reportId) => {
  try {
    const prev = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => x !== reportId);
    localStorage.setItem(RECENT_KEY, JSON.stringify([reportId, ...prev].slice(0, 6)));
  } catch { /* ignore */ }
};
export const getRecent = () => {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
};
