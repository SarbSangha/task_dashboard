// Shared formatting/labeling helpers for the Grammarly Docs Capture Center.
// Mirrors splice-capture/spliceCaptureUtils.js's own "no component imports,
// dependency-free, each provider folder keeps its own copy" rule - see that
// file's own comment for why this is a fresh copy rather than a cross-folder
// import. Grammarly Docs is session-shaped (doc opened, how long it stayed
// open), not download/generation-shaped, so this file adds duration
// formatting on top of the usual timestamp/count helpers, and skips
// ownership/quota formatters that provider doesn't have.

export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '0';
}

export function formatAbsoluteTime(value) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(parsed);
}

const RELATIVE_UNITS = [
  { limit: 60, divisor: 1, unit: 'second' },
  { limit: 3600, divisor: 60, unit: 'minute' },
  { limit: 86400, divisor: 3600, unit: 'hour' },
  { limit: 604800, divisor: 86400, unit: 'day' },
  { limit: 2629800, divisor: 604800, unit: 'week' },
  { limit: 31557600, divisor: 2629800, unit: 'month' },
  { limit: Infinity, divisor: 31557600, unit: 'year' },
];

const relativeTimeFormatter = typeof Intl.RelativeTimeFormat === 'function'
  ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  : null;

export function formatRelativeTime(value, now = Date.now()) {
  if (!value) return 'Never';
  const parsed = new Date(value).getTime();
  if (Number.isNaN(parsed)) return String(value);
  const diffSeconds = Math.round((parsed - now) / 1000);
  const absSeconds = Math.abs(diffSeconds);
  if (absSeconds < 5) return 'Just now';
  const bucket = RELATIVE_UNITS.find((entry) => absSeconds < entry.limit) || RELATIVE_UNITS[RELATIVE_UNITS.length - 1];
  const value_ = Math.round(diffSeconds / bucket.divisor);
  if (relativeTimeFormatter) return relativeTimeFormatter.format(value_, bucket.unit);
  const plural = Math.abs(value_) === 1 ? '' : 's';
  return value_ < 0 ? `${Math.abs(value_)} ${bucket.unit}${plural} ago` : `in ${value_} ${bucket.unit}${plural}`;
}

// Session duration is reported in whole seconds by the backend
// (GrammarlyDocSession.duration_seconds - see backend
// providers/grammarly_docs/models.py). Formats as "2h 14m", "6m", or "38s" -
// never shows more than two units, since sub-minute precision on an hours-
// long session is just noise.
export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

export const SESSION_STATUS_META = {
  open: { label: 'Open now', icon: '🟢', tone: 'success' },
  ended: { label: 'Ended', icon: '⏹️', tone: 'muted' },
  // A session that never got a close event, reconciled and capped - see
  // backend normalization.py's reconcile_stale_sessions.
  stale: { label: 'Ended (unconfirmed)', icon: '⚠️', tone: 'warning' },
};

export function getSessionStatusMeta(status) {
  return SESSION_STATUS_META[status] || { label: status || 'Unknown', icon: '❔', tone: 'muted' };
}

export async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // fall through to legacy path
    }
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function normalizeApiError(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (error?.response?.status === 403) {
    return 'Administrator access is required for the Grammarly Docs Capture Center.';
  }
  if (error?.message) return error.message;
  return fallback;
}

// Groups a flat session list into one entry per DOCUMENT (doc_id), sorted
// most-recently-active first - one doc_id can legitimately produce many
// session rows, not just from tab-switching (see content-grammarly-docs.js's
// "Session end / re-open" comment) but also from Coda's own multi-page
// documents: a document's "pages" (sidebar sub-pages) share the SAME
// top-level doc_id, confirmed real (2026-08-27) - a doc with several pages
// opened one after another produced 6 separate session rows all carrying the
// identical doc_id within minutes of each other. Without this grouping each
// of those rendered as if it were its own unrelated document in the "by
// person" list, when really they were all visits to (pages within) one
// document. A session with no doc_id (shouldn't normally happen - doc_id is
// always read off the URL before a session opens) gets its own singleton
// group keyed by session id, rather than being silently merged with other
// doc-id-less sessions that have nothing in common.
export function groupSessionsByDoc(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = session.docId || `no-doc-${session.id}`;
    if (!groups.has(key)) {
      groups.set(key, { key, docId: session.docId || null, sessions: [], totalDurationSeconds: 0, lastActiveAt: null });
    }
    const group = groups.get(key);
    group.sessions.push(session);
    group.totalDurationSeconds += Number(session.durationSeconds) || 0;
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : 0;
    if (startedAt && (!group.lastActiveAt || startedAt > group.lastActiveAt)) {
      group.lastActiveAt = startedAt;
    }
  }

  return Array.from(groups.values())
    .map((group) => {
      // Sessions within a doc are always sorted newest-first below - the
      // NEWEST one is the best guess at the doc's current title/client
      // (title/client can only ever change going forward across re-opens,
      // e.g. a rename or a client picked on a later visit, never backward -
      // see content-grammarly-docs.js's sticky-client-per-docId comment).
      const sorted = group.sessions.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
      const newest = sorted[0];
      // linkedClientId/Name specifically: prefer the newest session that
      // actually HAS one, not just the newest session outright - an older
      // page-visit's client pick shouldn't be hidden just because the most
      // recent re-open happened to not carry it forward yet.
      const withClient = sorted.find((s) => s.linkedClientId != null);
      return {
        ...group,
        sessions: sorted,
        sessionCount: sorted.length,
        docTitle: newest?.docTitle || null,
        docAuthor: newest?.docAuthor || null,
        linkedClientId: withClient?.linkedClientId ?? null,
        linkedClientName: withClient?.linkedClientName ?? null,
      };
    })
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}

// Groups a flat session list into one entry per person, sorted heaviest-time
// first - the "by person" view this Capture Center's whole point is. A
// session with no resolved owner (ownerUserId null - shouldn't normally
// happen, capture-time ownership is always resolved, but defensive) is
// bucketed under a single "Unattributed" group rather than dropped, so
// nothing silently disappears from the view. Each person's sessions are
// further grouped into documents via groupSessionsByDoc above, since a flat
// per-session list under a person conflates "6 different documents" with "6
// visits to the same 1 document" - see that function's own comment.
export function groupSessionsByPerson(sessions) {
  const groups = new Map();
  for (const session of sessions) {
    const key = session.ownerUserId ?? 'unattributed';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        ownerUserId: session.ownerUserId ?? null,
        ownerName: session.ownerName || (key === 'unattributed' ? 'Unattributed' : `User #${key}`),
        ownerEmployeeId: session.ownerEmployeeId || null,
        ownerDepartment: session.ownerDepartment || null,
        sessions: [],
        docIds: new Set(),
        totalDurationSeconds: 0,
        lastActiveAt: null,
      });
    }
    const group = groups.get(key);
    group.sessions.push(session);
    if (session.docId) group.docIds.add(session.docId);
    group.totalDurationSeconds += Number(session.durationSeconds) || 0;
    const startedAt = session.startedAt ? new Date(session.startedAt).getTime() : 0;
    if (startedAt && (!group.lastActiveAt || startedAt > group.lastActiveAt)) {
      group.lastActiveAt = startedAt;
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      docCount: group.docIds.size,
      sessionCount: group.sessions.length,
      docs: groupSessionsByDoc(group.sessions),
    }))
    .sort((a, b) => b.totalDurationSeconds - a.totalDurationSeconds);
}
