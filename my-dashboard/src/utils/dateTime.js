export const INDIA_LOCALE = 'en-IN';
export const INDIA_TIMEZONE = 'Asia/Kolkata';

export function parseAppDate(value) {
  if (!value) return null;

  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }

  const normalizedValue =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value.trim())
      ? `${value.trim()}Z`
      : value;

  const date = new Date(normalizedValue);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatDateTimeIndia(value) {
  if (!value) return 'N/A';
  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  const datePart = date.toLocaleDateString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const timePart = date.toLocaleTimeString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${datePart}, ${timePart} IST`;
}

export function formatDateIndia(value) {
  if (!value) return 'N/A';
  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTimeIndia(value) {
  if (!value) return 'N/A';
  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  return `${date.toLocaleTimeString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })} IST`;
}
