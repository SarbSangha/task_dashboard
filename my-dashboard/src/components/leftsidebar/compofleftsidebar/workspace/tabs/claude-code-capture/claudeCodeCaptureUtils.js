// Shared formatting helpers for the Claude Code Capture Center. Same
// "no component imports, dependency-free, own copy per provider folder" rule
// as cursor-capture/cursorCaptureUtils.js.

export const DAY = 86400000;

// Claude Code reports cost in USD per model call, often fractions of a cent.
export function fmtUSD(value) {
  if (value === null || value === undefined) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.001) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(value >= 10 ? 2 : 3)}`;
}

export function fmtN(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(Math.round(n));
}

export function fmtTime(value) {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function normalizeApiError(error, fallback) {
  const detail = error?.response?.data?.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (error?.response?.status === 403) {
    return 'Administrator access is required for the Claude Code Capture Center.';
  }
  if (error?.message) return error.message;
  return fallback;
}
