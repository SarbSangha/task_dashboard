// A stable colour per sheet editor, so the same person reads the same in the
// per-user list, the chart and every log row. Hashing the email (rather than
// using list order) keeps colours fixed while filters change what is shown.

const PALETTE = [
  '#2563eb', '#dc2626', '#16a34a', '#9333ea', '#ea580c', '#0891b2',
  '#c026d3', '#65a30d', '#db2777', '#0d9488', '#7c3aed', '#ca8a04',
];
export const UNKNOWN_COLOR = '#6b7280';
export const UNKNOWN_LABEL = 'Unknown user';

export function sheetUserColor(email) {
  if (!email) return UNKNOWN_COLOR;
  let hash = 0;
  for (let i = 0; i < email.length; i += 1) hash = (hash * 31 + email.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function sheetUserLabel(email) {
  return email || UNKNOWN_LABEL;
}

export function sheetUserInitials(email) {
  if (!email) return '?';
  const local = email.split('@')[0] || email;
  const parts = local.split(/[._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2);
  return letters.toUpperCase();
}
