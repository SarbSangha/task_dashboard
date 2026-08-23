// Shared formatting/labeling helpers for the Epidemic Sound Capture Center.
// Mirrors envato-capture/envatoCaptureUtils.js's own "no component imports,
// dependency-free" rule - each provider folder stays self-contained.
// Epidemic Sound itself is still a stock music/sound-effects LICENSING
// LIBRARY, not a general AI generator (see providers/epidemicsound/
// constants.py's own docstring) - downloads have no prompt/itemType/credits
// concept, only download_click events. Adaptations are the one exception:
// a real prompt-based AI regeneration feature layered on top of a track a
// user already has (see EpidemicAdaptationCard.jsx's own header comment),
// so ADAPTATION_STATUS_META below is this file's only generation-shaped
// addition - still no ITEM_TYPE_META (every adaptation is audio; there is no
// image/video/type split to label).

export const OWNERSHIP_STATUS_META = {
  resolved: { label: 'Attributed', icon: '✅', tone: 'success' },
  unknown: { label: 'Unclaimed', icon: '❔', tone: 'warning' },
};

export function getOwnershipStatusMeta(status) {
  return OWNERSHIP_STATUS_META[status] || { label: status || 'Unknown', icon: '❔', tone: 'muted' };
}

// isSfx is a plain boolean on EpidemicDownload (see constants.py's confirmed
// capture sample: `is_sfx=true` on the query string) - Sound Effect vs Music
// is the only "kind" split this provider has, no itemType enum like Envato's.
export function getSoundKindMeta(isSfx) {
  return isSfx ? { label: 'Sound Effect', icon: '🔊' } : { label: 'Music', icon: '🎵' };
}

// EpidemicAdaptation.status values (draft -> pending -> completed - see
// EpidemicAdaptationCard.jsx's own header comment for the full lifecycle
// story). Reuses the same muted/warning/success tone vocabulary as
// higgsfield-capture/higgsfieldCaptureUtils.js's own GENERATION_STATUS_META,
// rendered through this tab's shared .chatgpt-capture-badge.tone-* classes
// (ChatGptCaptureCenterTab.css) so draft/pending read as visually
// "in progress" and completed reads as visually "done".
export const ADAPTATION_STATUS_META = {
  draft: { label: 'Draft', icon: '📝', tone: 'muted' },
  pending: { label: 'Generating…', icon: '⏳', tone: 'warning' },
  completed: { label: 'Completed', icon: '✅', tone: 'success' },
};

export function getAdaptationStatusMeta(status) {
  return ADAPTATION_STATUS_META[status] || { label: status || 'Unknown', icon: '❔', tone: 'muted' };
}

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
    return 'Administrator access is required for the Epidemic Sound Capture Center.';
  }
  if (error?.message) return error.message;
  return fallback;
}
