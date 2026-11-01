// Shared formatting helpers for the Figma Capture Center. Same
// "no component imports, dependency-free, own copy per provider folder" rule
// as cursor-capture/cursorCaptureUtils.js.

export const DAY = 86400000;

// Figma AI credits are whole numbers per prompt; totals stay whole too.
export function fmtCredits(value) {
  if (value === null || value === undefined) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 1 });
}

export function fmtTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtDuration(ms) {
  if (!ms) return '—';
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normalizeApiError(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (error?.response?.status === 403) {
    return 'Administrator access is required for the Figma Capture Center.';
  }
  if (error?.message) return error.message;
  return fallback;
}
