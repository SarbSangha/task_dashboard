// content-recent-clients.js — "Recent" clients for every tool's Client picker.
//
// The client list (GET /api/clients/active) is one admin-curated list shared by
// every tool, and long enough that people scroll for the same few clients each
// time. The server marks the caller's last few picks across all tools with
// recentRank (1 = most recent; see backend utils/client_gate.py
// get_recent_client_ids), and each content-*-task-modal.js uses arrange() to
// list them in a "Recent" group above "All clients".
//
// Deliberately not remembered in the browser: one Chrome profile is often
// shared by several people, and the server knows who is actually logged in.
// Loaded just before each task modal in manifest.json; the modals call it
// through globalThis.rmwRecentClients?. so a picker still works without it.

(() => {
  const HEADING_MARKER = '__rmwRecentHeading';

  function recentRank(item) {
    const rank = Number(item?.recentRank);
    return Number.isFinite(rank) && rank > 0 ? rank : null;
  }

  // The picker's items in display order. With no search typed and some
  // recent clients in the list, that is a "Recent" heading, those clients
  // (most recent first), an "All clients" heading, then every client in the
  // usual order - recent ones included, so the full list is always complete.
  // Headings are { [HEADING_MARKER]: label } entries for the caller's loop to
  // render with heading(). While searching it is just the matches, unchanged.
  function arrange(items, isSearching) {
    if (isSearching) return items;
    const recent = items.filter((item) => recentRank(item) != null)
      .sort((a, b) => recentRank(a) - recentRank(b));
    if (!recent.length) return items;
    return [
      { [HEADING_MARKER]: 'Recent' },
      ...recent,
      { [HEADING_MARKER]: 'All clients' },
      ...items,
    ];
  }

  function headingLabel(entry) {
    return entry && typeof entry === 'object' ? entry[HEADING_MARKER] || '' : '';
  }

  // Styled inline: each modal lives in its own shadow root with its own
  // stylesheet, and this keeps the eleven copies from each needing a new rule.
  function heading(label) {
    const el = document.createElement('div');
    el.textContent = label;
    el.setAttribute('role', 'presentation');
    el.style.cssText = 'font-size:11px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;'
      + 'color:#9aa0b4;margin:6px 2px 6px;';
    return el;
  }

  globalThis.rmwRecentClients = { arrange, headingLabel, heading };
})();
