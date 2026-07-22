// Shared formatting + date helpers for the Reports module.

export const toISODate = (d) => {
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '';
  return dt.toISOString().slice(0, 10);
};

export const presetRange = (preset) => {
  const end = new Date();
  const start = new Date();
  if (preset === 'all') {
    // All time — start far enough back to include every record from the beginning.
    return { start: '2000-01-01', end: toISODate(end) };
  }
  if (preset === 'today') {
    // start = end = today
  } else if (preset === 'tomorrow') {
    start.setDate(end.getDate() + 1);
    end.setDate(end.getDate() + 1);
  } else if (preset === 'yesterday') {
    start.setDate(end.getDate() - 1);
    end.setDate(end.getDate() - 1);
  } else if (preset === '7d') {
    start.setDate(end.getDate() - 6);
  } else if (preset === '15d') {
    start.setDate(end.getDate() - 14);
  } else if (preset === '30d') {
    start.setDate(end.getDate() - 29);
  } else if (preset === '90d') {
    start.setDate(end.getDate() - 89);
  }
  return { start: toISODate(start), end: toISODate(end) };
};

export const formatNumber = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(n) >= 10_000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}K`;
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
};

export const formatFull = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  return Number(value).toLocaleString(undefined, { maximumFractionDigits: 2 });
};

export const formatPct = (value) => {
  if (value == null || Number.isNaN(Number(value))) return '—';
  const n = Number(value);
  return `${n > 0 ? '+' : ''}${n.toFixed(1)}%`;
};

export const formatDayLabel = (iso) => {
  const dt = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return iso;
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export const formatHour = (h) => {
  const hour = Number(h);
  if (hour === 0) return '12a';
  if (hour === 12) return '12p';
  return hour < 12 ? `${hour}a` : `${hour - 12}p`;
};

export const initialsOf = (name) =>
  `${name || '?'}`
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join('') || '?';
