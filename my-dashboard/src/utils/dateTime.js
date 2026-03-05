export const INDIA_LOCALE = 'en-IN';
export const INDIA_TIMEZONE = 'Asia/Kolkata';

export function formatDateTimeIndia(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
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
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleDateString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatTimeIndia(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return `${date.toLocaleTimeString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  })} IST`;
}
