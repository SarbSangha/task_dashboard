// Tool Renew plans -- mirrors RENEWAL_TYPES / PLAN_PERIOD_MONTHS / STATUS_*
// in backend utils/tool_renewal_service.py. Subscriptions carry how many
// months one billing period spans.
export const SUBSCRIPTION_PLANS = [
  { value: 'MONTHLY', label: 'Monthly', months: 1 },
  { value: 'QUARTERLY', label: 'Quarterly', months: 3 },
  { value: 'HALF_YEARLY', label: 'Half-yearly', months: 6 },
  { value: 'YEARLY', label: 'Yearly', months: 12 },
];
export const OTHER_PLANS = [
  { value: 'CREDIT_CONSUMPTION', label: 'Credit pack' },
  { value: 'MANUAL', label: 'Custom dates' },
  { value: 'FREE', label: 'Free plan' },
  { value: 'NOT_PURCHASED', label: 'Not purchased' },
];
export const PLAN_LABELS = Object.fromEntries([...SUBSCRIPTION_PLANS, ...OTHER_PLANS].map((p) => [p.value, p.label]));
export const PLAN_PERIOD_MONTHS = Object.fromEntries(SUBSCRIPTION_PLANS.map((p) => [p.value, p.months]));
export const PERIOD_TEXT = { 1: 'month', 3: '3 months', 6: '6 months', 12: 'year' };
// Plans that cost nothing: the backend holds their cost at 0.
export const NO_COST_PLANS = new Set(['FREE', 'NOT_PURCHASED']);

// Statuses that need someone to act, in the order the table's
// "Needs attention" filter cares about.
export const ATTENTION_STATUSES = new Set(['renewal_required', 'credits_exhausted', 'due_soon', 'credits_low', 'needs_setup']);

// 'YYYY-MM-DD' + n months, clamping the day (Jan 31 + 1 -> Feb 28).
export const addMonths = (isoDate, months) => {
  const [y, m, d] = (isoDate || '').split('-').map(Number);
  if (!y || !m || !d) return '';
  const total = m - 1 + months;
  const year = y + Math.floor(total / 12);
  const month = (total % 12) + 1;
  const lastDay = new Date(year, month, 0).getDate();
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(Math.min(d, lastDay))}`;
};

export const formatDate = (value) => {
  if (!value) return '';
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};

export const formatRupees = (value, digits = 2) => `₹${Number(value).toLocaleString(undefined, { maximumFractionDigits: digits })}`;
export const formatNumber = (value) => Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });

// "in 5 days" / "today" / "3 days ago" for a days-until count.
export const relativeDays = (days) => {
  if (days == null) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
};
