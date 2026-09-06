// Shared formatting/labeling helpers for the Claude Capture Center. Mirrors
// grammarly-docs-capture/grammarlyDocsCaptureUtils.js's own "no component
// imports, dependency-free, each provider folder keeps its own copy" rule -
// see that file's own comment for why this is a fresh copy rather than a
// cross-folder import. Claude is chat-shaped (prompt/response turns), not
// session-duration-shaped like Grammarly Docs, so this groups by person +
// conversation (no doc/duration concepts) and adds a couple of chat-message
// helpers (day labels, clock times) mirrored from chatgpt-capture/
// chatgptCaptureUtils.js instead.

export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '0';
}

export function formatAbsoluteTime(value) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
  }).format(parsed);
}

// Short clock time (e.g. "10:32 AM") for per-message timestamps.
export function formatClockTime(value) {
  if (!value) return '';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return '';
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(parsed);
}

// Day label for message time-grouping: "Today", "Yesterday", else a date.
export function formatDayLabel(value) {
  if (!value) return 'Undated';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Undated';
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const today = startOfDay(new Date());
  const day = startOfDay(parsed);
  const diffDays = Math.round((today - day) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'long', day: 'numeric' }).format(parsed);
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

export const CONVERSATION_HEALTH_META = {
  healthy: { label: 'Healthy', icon: '🟢', tone: 'success' },
  degraded: { label: 'Missing response', icon: '⚠️', tone: 'warning' },
  no_messages: { label: 'No messages', icon: '⚪', tone: 'muted' },
  backlogged: { label: 'Backlogged', icon: '🟠', tone: 'warning' },
  offline: { label: 'Offline', icon: '🔴', tone: 'error' },
};

export function getConversationHealthMeta(status) {
  return CONVERSATION_HEALTH_META[status] || { label: status || 'Unknown', icon: '❔', tone: 'muted' };
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

/**
 * Adapts a ConversationCaptureAttachment (backend camelCase: fileUrl,
 * storagePath, fileName, mimeType) into the {path, url, originalName,
 * filename, mimetype} shape ChatAttachmentGallery expects - reusing the
 * existing gallery/lightbox rather than building a second one. Mirrors
 * chatgpt-capture/chatgptCaptureUtils.js's identical toGalleryAttachment.
 */
export function toGalleryAttachment(attachment) {
  // fileName on a stored attachment is deliberately the file's Claude uuid,
  // not its human name - that is the correlation key (see
  // matchStoredAttachments below). Showing a bare uuid as the label is
  // useless to a reader, so matchStoredAttachments attaches the real
  // filename from the prompt message as displayName and it is preferred
  // here. Falls back to the uuid when there is no match to draw a name from.
  const label = attachment.displayName || attachment.fileName;
  return {
    path: attachment.storagePath,
    url: attachment.fileUrl,
    originalName: label,
    filename: label,
    mimetype: attachment.mimeType,
  };
}

/**
 * The normalized prompt message's own `files` field carries {name,
 * mimeType, uuid} - uuid is Claude's own file id (see
 * content-claude-capture.js's extractFiles), the SAME value
 * captureFileAttachments used as the stored attachment's fileName when it
 * uploaded the bytes. Correlates the two by that uuid, not by filename
 * (unlike ChatGPT's equivalent match - see that provider's own
 * matchStoredAttachments - Claude's own file uuid is a stronger, collision-
 * free key that's already available here).
 */
export function matchStoredAttachments(messageFiles, storedAttachments) {
  if (!messageFiles?.length || !storedAttachments?.length) return [];
  // uuid -> the file's human name as Claude reported it on the prompt
  // message, so the gallery can label a stored attachment with something
  // readable instead of the uuid it is keyed by (see toGalleryAttachment).
  const nameByUuid = new Map();
  for (const item of messageFiles) {
    if (item?.uuid) nameByUuid.set(item.uuid, item.name || '');
  }
  if (!nameByUuid.size) return [];
  return storedAttachments
    .filter((stored) => nameByUuid.has(stored.fileName))
    .map((stored) => ({ ...stored, displayName: nameByUuid.get(stored.fileName) || stored.fileName }));
}

export function normalizeApiError(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (error?.response?.status === 403) {
    return 'Administrator access is required for the Claude Capture Center.';
  }
  if (error?.message) return error.message;
  return fallback;
}

// Groups a flat conversation list into one entry per person, most-recently-
// active first. A conversation with no resolved owner (ownerUserId null -
// happens when its very first capture didn't look new enough to attribute,
// see backend providers/claude/normalization.py's _is_attributable) is
// bucketed under a single "Unattributed" group rather than dropped, so
// nothing silently disappears from the view - mirrors
// grammarlyDocsCaptureUtils.js's groupSessionsByPerson exactly, minus that
// file's extra per-document grouping layer (one Claude conversation IS the
// row here, no further nesting needed).
export function groupConversationsByPerson(conversations) {
  const groups = new Map();
  for (const conversation of conversations) {
    const key = conversation.ownerUserId ?? 'unattributed';
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        ownerUserId: conversation.ownerUserId ?? null,
        ownerName: conversation.ownerName || (key === 'unattributed' ? 'Unattributed' : `User #${key}`),
        ownerEmail: conversation.ownerEmail || null,
        conversations: [],
        promptCount: 0,
        responseCount: 0,
        lastActiveAt: null,
      });
    }
    const group = groups.get(key);
    group.conversations.push(conversation);
    group.promptCount += Number(conversation.promptCount) || 0;
    group.responseCount += Number(conversation.responseCount) || 0;
    const lastActiveAt = conversation.lastActivityAt ? new Date(conversation.lastActivityAt).getTime() : 0;
    if (lastActiveAt && (!group.lastActiveAt || lastActiveAt > group.lastActiveAt)) {
      group.lastActiveAt = lastActiveAt;
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      conversations: group.conversations.sort(
        (a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0)
      ),
      conversationCount: group.conversations.length,
      messageCount: group.promptCount + group.responseCount,
    }))
    .sort((a, b) => (b.lastActiveAt || 0) - (a.lastActiveAt || 0));
}
