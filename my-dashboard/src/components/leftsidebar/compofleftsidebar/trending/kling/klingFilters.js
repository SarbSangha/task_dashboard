import { generationRecordsAPI } from '../../../../../services/api';
import { DATE_PRESETS as PICKER_PRESETS, computePresetDates, formatRange } from '../../../../reports/dateRanges';

/*
 * One filter object drives the Kling tab, its result summary and the Excel
 * export, and maps 1:1 onto backend KlingFilterParams
 * (routers/generation_records_router.py). Empty string = "any".
 */
export const KLING_DEFAULT_FILTERS = Object.freeze({
  datePreset: 'all',
  dateFrom: '',
  dateTo: '',
  ownerUserId: '',
  department: '',
  account: '',
  outputType: '',
  creditsPreset: '',
  creditsMin: '',
  creditsMax: '',
  linked: '',
  clientId: '',
  quality: '',
  duplicates: '',
  capture: '',
  ownership: '',
  model: '',
  resolution: '',
  tag: '',
  favoritesOnly: false,
});

// Date presets come from the shared DateRangePicker (reports/dateRanges.js);
// 'all' and 'custom' are handled here.
const DATE_LABELS = Object.fromEntries(PICKER_PRESETS.map((preset) => [preset.key, preset.label]));

// Bands picked from the credit distribution (most generations cost 11–35;
// 36–70 is the next big group; above 70 is rare and worth spotting).
export const CREDIT_PRESETS = [
  { value: '', label: 'Any credits' },
  { value: 'low', label: 'Low (1–10)', min: 1, max: 10 },
  { value: 'standard', label: 'Standard (11–35)', min: 11, max: 35 },
  { value: 'high', label: 'High (36–70)', min: 36, max: 70 },
  { value: 'veryHigh', label: 'Very high (71+)', min: 71 },
  { value: 'custom', label: 'Custom…' },
];

export const OUTPUT_OPTIONS = [
  { value: 'video', label: 'Video', count: 'video' },
  { value: 'image', label: 'Image', count: 'image' },
  { value: 'none', label: 'No output captured', count: 'noOutput' },
];

export const LINKED_OPTIONS = [
  { value: 'task', label: 'Linked to a task', count: 'linkedTask' },
  { value: 'no_task', label: 'No linked task', count: 'noTask' },
  { value: 'client', label: 'Linked to a client', count: 'linkedClient' },
  { value: 'no_client', label: 'No linked client', count: 'noClient' },
  { value: 'unlinked', label: 'No task or client', count: 'unlinked' },
];

export const QUALITY_OPTIONS = [
  { value: 'complete', label: 'Complete records', count: 'complete' },
  { value: 'missing_any', label: 'Missing any data', count: 'missingAny' },
  { value: 'missing_credits', label: 'Missing credits', count: 'missingCredits' },
  { value: 'missing_prompt', label: 'Missing prompt', count: 'missingPrompt' },
  { value: 'missing_file', label: 'Missing video file', count: 'missingFile' },
];

export const DUPLICATE_OPTIONS = [
  { value: 'only', label: 'Duplicates only', count: 'duplicates' },
  { value: 'exclude', label: 'Hide duplicates' },
];

export const CAPTURE_OPTIONS = [
  { value: 'history', label: 'History import', count: 'history' },
  { value: 'live', label: 'Live capture', count: 'live' },
];

export const OWNERSHIP_OPTIONS = [
  { value: 'resolved', label: 'Owner known' },
  { value: 'unknown', label: 'Owner unknown' },
];

export const SORT_OPTIONS = [
  { value: 'latest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'credits', label: 'Most credits' },
];

// Filters that live behind "More filters" (rarer, audit-style questions).
export const ADVANCED_KEYS = [
  'linked', 'clientId', 'quality', 'duplicates', 'capture', 'ownership', 'model', 'resolution', 'tag',
];

export function resolveDateRange(filters) {
  if (!filters.datePreset || filters.datePreset === 'all') return { from: null, to: null };
  if (filters.datePreset === 'custom') return { from: filters.dateFrom || null, to: filters.dateTo || null };
  const { start, end } = computePresetDates(filters.datePreset);
  return { from: start, to: end };
}

export function resolveCreditRange(filters) {
  if (filters.creditsPreset === 'custom') {
    const toNumber = (value) => (value === '' || value == null ? null : Number(value));
    return { min: toNumber(filters.creditsMin), max: toNumber(filters.creditsMax) };
  }
  const preset = CREDIT_PRESETS.find((item) => item.value === filters.creditsPreset);
  return { min: preset?.min ?? null, max: preset?.max ?? null };
}

/** Backend query params for /api/generations/search and the Kling export. */
export function toKlingQueryParams(filters, extra = {}) {
  const { from, to } = resolveDateRange(filters);
  const credits = resolveCreditRange(filters);
  const params = {
    date_from: from || undefined,
    date_to: to || undefined,
    owner_user_id: filters.ownerUserId || undefined,
    department: filters.department || undefined,
    account: filters.account || undefined,
    output_type: filters.outputType || undefined,
    credits_min: credits.min ?? undefined,
    credits_max: credits.max ?? undefined,
    linked: filters.linked || undefined,
    client_id: filters.clientId || undefined,
    quality: filters.quality || undefined,
    duplicates: filters.duplicates || undefined,
    capture: filters.capture || undefined,
    ownership_status: filters.ownership || undefined,
    model: filters.model || undefined,
    resolution: filters.resolution || undefined,
    tag: filters.tag || undefined,
    is_favorite: filters.favoritesOnly ? true : undefined,
    ...extra,
  };
  return Object.fromEntries(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''));
}

export function isFilterInvalid(filters) {
  const { from, to } = resolveDateRange(filters);
  if (from && to && from > to) return 'The start date is after the end date.';
  const { min, max } = resolveCreditRange(filters);
  if (min != null && max != null && min > max) return 'Minimum credits is above maximum credits.';
  return '';
}

const labelOf = (options, value) => options.find((item) => item.value === value)?.label || value;

/** Active filters as removable chips: [{ key, label, reset }]. */
export function describeKlingFilters(filters, options = {}) {
  const chips = [];
  const add = (key, label, reset) => chips.push({ key, label, reset });
  if (filters.datePreset && filters.datePreset !== 'all') {
    const { from, to } = resolveDateRange(filters);
    const label = filters.datePreset === 'custom'
      ? formatRange(from, to)
      : DATE_LABELS[filters.datePreset] || filters.datePreset;
    add('date', label, { datePreset: 'all', dateFrom: '', dateTo: '' });
  }
  if (filters.ownerUserId) {
    const owner = (options.owners || []).find((item) => String(item.userId) === String(filters.ownerUserId));
    add('ownerUserId', `Person: ${owner?.name || filters.ownerUserId}`, { ownerUserId: '' });
  }
  if (filters.department) add('department', `Dept: ${filters.department}`, { department: '' });
  if (filters.account) add('account', `Account: ${filters.account}`, { account: '' });
  if (filters.outputType) add('outputType', labelOf(OUTPUT_OPTIONS, filters.outputType), { outputType: '' });
  if (filters.creditsPreset) {
    const { min, max } = resolveCreditRange(filters);
    const label = filters.creditsPreset === 'custom'
      ? `Credits ${min ?? 0}–${max ?? '∞'}`
      : `${labelOf(CREDIT_PRESETS, filters.creditsPreset)} credits`.replace(' credits credits', ' credits');
    add('credits', label, { creditsPreset: '', creditsMin: '', creditsMax: '' });
  }
  if (filters.linked) add('linked', labelOf(LINKED_OPTIONS, filters.linked), { linked: '' });
  if (filters.clientId) {
    const client = (options.clients || []).find((item) => String(item.id) === String(filters.clientId));
    add('clientId', `Client: ${client?.name || filters.clientId}`, { clientId: '' });
  }
  if (filters.quality) add('quality', labelOf(QUALITY_OPTIONS, filters.quality), { quality: '' });
  if (filters.duplicates) add('duplicates', labelOf(DUPLICATE_OPTIONS, filters.duplicates), { duplicates: '' });
  if (filters.capture) add('capture', labelOf(CAPTURE_OPTIONS, filters.capture), { capture: '' });
  if (filters.ownership) add('ownership', labelOf(OWNERSHIP_OPTIONS, filters.ownership), { ownership: '' });
  if (filters.model) add('model', `Model: ${filters.model}`, { model: '' });
  if (filters.resolution) add('resolution', `Resolution: ${filters.resolution}`, { resolution: '' });
  if (filters.tag) add('tag', `Tag: ${filters.tag}`, { tag: '' });
  if (filters.favoritesOnly) add('favoritesOnly', 'Favourites', { favoritesOnly: false });
  return chips;
}

export const countAdvancedActive = (filters) =>
  ADVANCED_KEYS.filter((key) => Boolean(filters[key])).length;

// Filter options (with counts) change slowly; share one fetch between the
// tab and the export popover for a minute.
let optionsCache = { at: 0, promise: null };
export function loadKlingFilterOptions({ force = false } = {}) {
  const fresh = Date.now() - optionsCache.at < 60_000;
  if (!force && optionsCache.promise && fresh) return optionsCache.promise;
  optionsCache = {
    at: Date.now(),
    promise: generationRecordsAPI.getFilters().catch((error) => {
      optionsCache = { at: 0, promise: null };
      throw error;
    }),
  };
  return optionsCache.promise;
}
