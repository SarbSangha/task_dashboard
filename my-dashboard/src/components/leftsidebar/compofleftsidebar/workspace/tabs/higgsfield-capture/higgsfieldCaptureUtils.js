// Shared formatting/labeling helpers for the Higgsfield Capture Center.
// Kept dependency-free, mirroring heygen-capture/heygenCaptureUtils.js's own
// "no component imports" rule so every sub-component can import from here
// without a cycle. This provider folder deliberately doesn't import from
// ../heygen-capture/ or ../freepik-capture/ - each provider folder stays
// self-contained, same precedent those folders already follow.
//
// No isVideoAssetUrl helper here (unlike Freepik's) - every Higgsfield
// generation is a video by construction (Create Video / Edit Video / Motion
// Control), so there's no image/video branching to do anywhere in this
// folder, same reasoning as HeyGen's own utils.

export const OWNERSHIP_STATUS_META = {
  resolved: { label: 'Attributed', icon: '✅', tone: 'success' },
  unknown: { label: 'Unclaimed', icon: '❔', tone: 'warning' },
};

export function getOwnershipStatusMeta(status) {
  return OWNERSHIP_STATUS_META[status] || { label: status || 'Unknown', icon: '❔', tone: 'muted' };
}

// Matches HiggsfieldGeneration.status values (backend/providers/higgsfield/constants.py) -
// unconfirmed guesses at a plausible lifecycle (pending -> queued ->
// processing/rendering -> completed, or -> failed/cancelled), same shape as
// HeyGen's own state machine.
export const GENERATION_STATUS_META = {
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'error' },
  cancelled: { label: 'Cancelled', tone: 'error' },
  pending: { label: 'Pending', tone: 'warning' },
  queued: { label: 'Queued', tone: 'warning' },
  processing: { label: 'Processing', tone: 'info' },
  rendering: { label: 'Rendering', tone: 'info' },
};

export function getGenerationStatusMeta(status) {
  return GENERATION_STATUS_META[status] || { label: status || 'Unknown', tone: 'muted' };
}

// HiggsfieldGeneration.kind values (constants.py's EVENT_TYPE_* split) -
// which of the three top-level tabs produced this generation.
export const KIND_LABELS = {
  create_video: 'Create Video',
  edit_video: 'Edit Video',
  motion_control: 'Motion Control',
};

export function getKindLabel(kind) {
  return KIND_LABELS[kind] || kind || 'Unknown';
}

export function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : '0';
}

export function formatCredits(value) {
  // Number(null) === 0, so a genuinely-uncaptured column (null, not 0)
  // would otherwise render as "0" instead of "—" - must be excluded before
  // the Number() coercion, not after.
  if (value === null || value === undefined) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 });
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

export function truncate(text, maxLength = 140) {
  if (!text) return '';
  return text.length > maxLength ? `${text.slice(0, maxLength).trim()}…` : text;
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
    return 'Administrator access is required for the Higgsfield Capture Center.';
  }
  if (error?.message) return error.message;
  return fallback;
}
