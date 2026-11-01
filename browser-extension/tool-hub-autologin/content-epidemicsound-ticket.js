// content-epidemicsound-ticket.js - runs at document_start on epidemicsound.com,
// before any of the site's own code.
//
// The dashboard hands the launch ticket over in the URL
// (#rmw_extension_ticket=...). content-epidemicsound.js only runs at
// document_idle, and by then Epidemic Sound's own scripts may already have
// rewritten the URL or sent the tab on to login.epidemicsound.com (a different
// origin, so sessionStorage doesn't follow) - the ticket is gone and the tab
// is treated as "not launched from the dashboard". Whether the site gets there
// first depends on how fast the machine loads the page, which is why it
// worked on some computers (Windows) and not others (reported on a Mac,
// 2026-10-30).
//
// So: read the ticket here, keep it where content-epidemicsound.js looks
// (sessionStorage rmw_extension_ticket), and activate the launch for this tab
// right away. The launch then belongs to the tab itself, so it survives any
// later redirect; content-epidemicsound.js's own activation with the same
// ticket is a no-op (activateLaunchForTab returns the existing record).
(function captureEpidemicSoundLaunchTicketEarly() {
  if (window.top !== window) return;
  let ticket = '';
  try {
    ticket = `${new URLSearchParams(window.location.search || '').get('rmw_extension_ticket') || ''}`.trim()
      || `${new URLSearchParams(`${window.location.hash || ''}`.replace(/^#/, '')).get('rmw_extension_ticket') || ''}`.trim();
  } catch {}
  if (!ticket) return;

  try { window.sessionStorage.setItem('rmw_extension_ticket', ticket); } catch {}
  try {
    chrome.runtime.sendMessage({
      type: 'TOOL_HUB_LAUNCH_TIMELINE', toolSlug: 'epidemic-sound', at: Date.now(),
      step: 'launch ticket received at page start',
    }, () => { void chrome.runtime.lastError; });
  } catch {}
  try {
    chrome.runtime.sendMessage({
      type: 'TOOL_HUB_ACTIVATE_LAUNCH',
      toolSlug: 'epidemic-sound',
      hostname: window.location.hostname,
      pageUrl: window.location.href,
      extensionTicket: ticket,
    }, () => { void chrome.runtime.lastError; });
  } catch {}
})();
