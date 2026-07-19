// Shared formatting/labeling helpers for the ChatGPT Capture Center. Kept
// dependency-free (no component imports) so every sub-component can import
// from here without a cycle.

export const EVENT_TYPE_META = {
  conversation_opened: { label: 'Opened', icon: '📂', tone: 'info' },
  conversation_created: { label: 'Created', icon: '✨', tone: 'success' },
  conversation_updated: { label: 'Updated', icon: '✏️', tone: 'info' },
  conversation_renamed: { label: 'Renamed', icon: '🏷️', tone: 'info' },
  conversation_archived: { label: 'Archived', icon: '🗄️', tone: 'muted' },
  conversation_deleted: { label: 'Deleted', icon: '🗑️', tone: 'error' },
  prompt_captured: { label: 'Prompt Submitted', icon: '💬', tone: 'primary' },
  message_edited: { label: 'Message Edited', icon: '📝', tone: 'warning' },
  response_started: { label: 'Response Started', icon: '⏳', tone: 'info' },
  response_completed: { label: 'Response Completed', icon: '✅', tone: 'success' },
  generation_captured: { label: 'Generation Captured', icon: '🎨', tone: 'success' },
  file_upload_detected: { label: 'File Upload', icon: '📤', tone: 'info' },
  file_download_detected: { label: 'File Download', icon: '📥', tone: 'info' },
};

export function getEventTypeMeta(eventType) {
  return EVENT_TYPE_META[eventType] || { label: eventType || 'Unknown', icon: '❔', tone: 'muted' };
}

export const HEALTH_STATUS_META = {
  healthy: { label: 'Healthy', tone: 'success' },
  degraded: { label: 'Degraded', tone: 'warning' },
  backlogged: { label: 'Backlogged', tone: 'warning' },
  offline: { label: 'Offline', tone: 'error' },
};

export function getHealthStatusMeta(status) {
  return HEALTH_STATUS_META[status] || { label: status || 'Unknown', tone: 'muted' };
}

export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '0';
}

/**
 * ChatGPT's response stream embeds inline citation/entity references using
 * two Unicode Private-Use-Area code points as delimiters, observed live in a
 * real captured response wrapping something like
 * ["politician","Yogi Adityanath",...]. The capture pipeline has no verified
 * parser for this encoding yet (a known follow-up, not silently ignored) -
 * so a raw captured response can contain these control code points verbatim.
 * Rather than showing garbled control characters in a "professional" chat
 * view, this strips the whole marked span for display only - the underlying
 * stored payload is untouched. Not full citation rendering (that would need
 * parsing the actual referenced entity, which isn't confirmed reliable yet).
 *
 * Character codes are built via String.fromCharCode rather than a regex
 * literal with the escape written inline, so this source file stays plain
 * ASCII with no ambiguity about which character is actually present.
 */
const ENTITY_MARKER_START_CODE = 0xe200;
const ENTITY_MARKER_END_CODE = 0xe201;

function buildEntityMarkerRegex() {
  const start = String.fromCharCode(ENTITY_MARKER_START_CODE);
  const end = String.fromCharCode(ENTITY_MARKER_END_CODE);
  // dotAll ("s" flag) makes "." match newlines too - avoids needing a
  // [\s\S]-style character class, whose backslashes have proven unreliable
  // to get through this particular editing pipeline intact (verified with a
  // standalone Node reproduction before landing this version).
  return new RegExp(start + '.*?' + end, 'gs');
}

export function sanitizeResponseText(text) {
  if (!text) return text;
  return text.replace(buildEntityMarkerRegex(), '').replace(/ {2,}/g, ' ').trim();
}

export function formatMs(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  if (number < 1000) return `${Math.round(number)} ms`;
  return `${(number / 1000).toFixed(2)} s`;
}

export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `${number.toFixed(1)}%`;
}

export function formatAbsoluteTime(value) {
  if (!value) return 'Not available';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
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

  if (relativeTimeFormatter) {
    return relativeTimeFormatter.format(value_, bucket.unit);
  }
  const plural = Math.abs(value_) === 1 ? '' : 's';
  return value_ < 0 ? `${Math.abs(value_)} ${bucket.unit}${plural} ago` : `in ${value_} ${bucket.unit}${plural}`;
}

/**
 * Adapts a ConversationCaptureAttachment (backend camelCase: fileUrl,
 * storagePath, fileName, mimeType) into the {path, url, originalName,
 * filename, mimetype} shape the dashboard's existing file components
 * (ChatAttachmentGallery, FilePreviewModal, utils/fileLinks.js) already
 * expect - reused as-is rather than building a second gallery/lightbox.
 */
export function toGalleryAttachment(attachment) {
  return {
    path: attachment.storagePath,
    url: attachment.fileUrl,
    originalName: attachment.fileName,
    filename: attachment.fileName,
    mimetype: attachment.mimeType,
  };
}

/**
 * Adapts a ConversationMediaAsset (backend camelCase: url, mimeType, prompt,
 * mediaType, id) into the same {path, url, originalName, filename, mimetype}
 * shape ChatAttachmentGallery expects - reusing the existing gallery/lightbox
 * rather than building a second one. Media assets have no storagePath (the
 * model stores only the R2 `url`), so `path` is omitted and the gallery falls
 * back to `url`, which the /api/files/open proxy resolves to a signed
 * redirect (the raw R2 url is private). The prompt, when present, makes a far
 * nicer caption than a filename.
 */
export function toGalleryMediaAsset(mediaAsset) {
  const label = mediaAsset.prompt || `${mediaAsset.mediaType || 'media'}-${mediaAsset.id}`;
  return {
    path: undefined,
    url: mediaAsset.url,
    originalName: label,
    filename: label,
    mimetype: mediaAsset.mimeType || (mediaAsset.mediaType?.includes('video') ? 'video/mp4' : 'image/jpeg'),
  };
}

/**
 * The normalized message's own `attachments` field only ever carries
 * {kind, label} placeholders (the network layer observes a filename, never
 * the bytes - see providers/chatgpt/queries.py). The real stored files (with
 * an actual url/path) live in a separate list fetched from
 * GET .../attachments. Correlates the two by filename + conversation, since
 * there's no stronger link available (the extension can't know which future
 * prompt an image belongs to at selection time - see
 * content-chatgpt-attachment-capture.js).
 */
export function matchStoredAttachments(messageAttachments, storedAttachments) {
  if (!messageAttachments?.length || !storedAttachments?.length) return [];
  const labels = new Set(messageAttachments.map((item) => item.label));
  return storedAttachments.filter((stored) => labels.has(stored.fileName));
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
  if (typeof detail === 'string' && detail.trim()) {
    return detail.trim();
  }
  if (error?.response?.status === 403) {
    return 'Administrator access is required for the ChatGPT Capture Center.';
  }
  if (error?.message) {
    return error.message;
  }
  return fallback;
}
