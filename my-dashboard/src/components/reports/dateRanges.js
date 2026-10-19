// Date helpers for the Usage & Spend report's range picker
// (DateRangePicker.jsx). Dates are local "YYYY-MM-DD" strings.

const pad = (n) => String(n).padStart(2, '0');
export const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const fromIso = (iso) => {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMonths = (d, n) => new Date(d.getFullYear(), d.getMonth() + n, 1);
export const sameDay = (a, b) => Boolean(a && b) && toIso(a) === toIso(b);
export const daysBetween = (a, b) => Math.round((startOfDay(b) - startOfDay(a)) / 86400000) + 1;

export const DATE_PRESETS = [
  { key: 'today', label: 'Today' },
  { key: 'yesterday', label: 'Yesterday' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'week', label: 'This week' },
  { key: 'month', label: 'This month' },
  { key: 'prev_month', label: 'Last month' },
  { key: 'quarter', label: 'This quarter' },
  { key: '90d', label: 'Last 3 months' },
  { key: 'year', label: 'This year' },
];

export function computePresetDates(presetKey, now = new Date()) {
  const today = startOfDay(now);
  const range = (s, e) => ({ start: toIso(s), end: toIso(e) });
  switch (presetKey) {
    case 'today':
      return range(today, today);
    case 'yesterday': {
      const y = addDays(today, -1);
      return range(y, y);
    }
    case '7d':
      return range(addDays(today, -6), today);
    case 'week': {
      const mondayOffset = (today.getDay() + 6) % 7; // weeks start on Monday
      return range(addDays(today, -mondayOffset), today);
    }
    case 'month':
      return range(new Date(today.getFullYear(), today.getMonth(), 1), today);
    case 'prev_month':
      return range(new Date(today.getFullYear(), today.getMonth() - 1, 1), new Date(today.getFullYear(), today.getMonth(), 0));
    case 'quarter':
      return range(new Date(today.getFullYear(), Math.floor(today.getMonth() / 3) * 3, 1), today);
    case '90d':
      return range(addDays(today, -89), today);
    case 'year':
      return range(new Date(today.getFullYear(), 0, 1), today);
    case '30d':
    default:
      return range(addDays(today, -29), today);
  }
}

export const MONTH_FMT = { month: 'long', year: 'numeric' };
export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

export function formatRange(start, end) {
  const s = fromIso(start);
  const e = fromIso(end);
  if (!s || !e) return 'Pick dates';
  const sameYear = s.getFullYear() === e.getFullYear();
  const day = (d, withYear) => d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', ...(withYear ? { year: 'numeric' } : {}) });
  if (sameDay(s, e)) return day(s, true);
  return `${day(s, !sameYear)} – ${day(e, true)}`;
}

export function monthGrid(monthStart) {
  // 6 weeks x 7 days, Monday first; days outside the month are null.
  const first = new Date(monthStart.getFullYear(), monthStart.getMonth(), 1);
  const lead = (first.getDay() + 6) % 7;
  const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < 42; i += 1) {
    const dayNum = i - lead + 1;
    cells.push(dayNum >= 1 && dayNum <= daysInMonth ? new Date(first.getFullYear(), first.getMonth(), dayNum) : null);
  }
  while (cells.length > 35 && cells.slice(-7).every((c) => c === null)) cells.splice(-7);
  return cells;
}
