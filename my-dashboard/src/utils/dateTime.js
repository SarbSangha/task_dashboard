export const INDIA_LOCALE = 'en-IN';
export const INDIA_TIMEZONE = 'Asia/Kolkata';

const getFormatterParts = (value, options = {}) => {
  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return null;

  const formatter = new Intl.DateTimeFormat(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    ...options,
  });
  return formatter.formatToParts(date);
};

const getPartValue = (parts, type) => parts?.find((part) => part.type === type)?.value || '';

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

export function formatTimeIndiaShort(value) {
  if (!value) return 'N/A';
  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleTimeString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatMonthDayTimeIndia(value) {
  if (!value) return 'N/A';
  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

export function formatRelativeDayIndia(value, nowValue = new Date()) {
  const targetParts = getFormatterParts(value, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });
  const nowParts = getFormatterParts(nowValue, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  });

  if (!targetParts || !nowParts) return 'Recent';

  const targetYear = Number(getPartValue(targetParts, 'year'));
  const targetMonth = Number(getPartValue(targetParts, 'month'));
  const targetDay = Number(getPartValue(targetParts, 'day'));
  const nowYear = Number(getPartValue(nowParts, 'year'));
  const nowMonth = Number(getPartValue(nowParts, 'month'));
  const nowDay = Number(getPartValue(nowParts, 'day'));

  const targetDateUtc = Date.UTC(targetYear, targetMonth - 1, targetDay);
  const nowDateUtc = Date.UTC(nowYear, nowMonth - 1, nowDay);
  const diffDays = Math.round((nowDateUtc - targetDateUtc) / 86400000);

  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';

  const date = parseAppDate(value);
  if (!date || Number.isNaN(date.getTime())) return 'Recent';

  return date.toLocaleDateString(INDIA_LOCALE, {
    timeZone: INDIA_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: targetYear === nowYear ? undefined : 'numeric',
  });
}

export function formatDateTimeLocalInputIndia(value) {
  const parts = getFormatterParts(value, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    hourCycle: 'h23',
  });

  if (!parts) return '';

  const year = getPartValue(parts, 'year');
  const month = getPartValue(parts, 'month');
  const day = getPartValue(parts, 'day');
  const hour = getPartValue(parts, 'hour');
  const minute = getPartValue(parts, 'minute');

  if (!year || !month || !day || !hour || !minute) return '';
  return `${year}-${month}-${day}T${hour}:${minute}`;
}
