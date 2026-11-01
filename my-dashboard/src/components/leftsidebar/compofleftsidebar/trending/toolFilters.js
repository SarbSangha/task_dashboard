import { rmwDataExportAPI } from '../../../../services/api';
import { DATE_PRESETS, computePresetDates, formatRange } from '../../../reports/dateRanges';

/*
 * Filter state shared by a tool tab's Records view (ToolRecordsTab) and its
 * Excel export (ToolExportOptions). The filters themselves are defined per
 * tool on the server (GET /api/rmw-data/export/<tool>/options).
 *
 *   state = { common: {...EMPTY_COMMON}, perSheet: { <sheetKey>: { <filterKey>: value } } }
 */
export const EMPTY_COMMON = Object.freeze({
  datePreset: 'all', dateFrom: '', dateTo: '', ownerUserId: '', department: '', linked: '', client: '', ownership: '',
});

export const EMPTY_STATE = Object.freeze({ common: EMPTY_COMMON, perSheet: {} });

const optionsCache = new Map();
export function loadToolOptions(tool) {
  const hit = optionsCache.get(tool);
  if (hit && Date.now() - hit.at < 60_000) return hit.promise;
  const promise = rmwDataExportAPI.getOptions(tool).catch((error) => {
    optionsCache.delete(tool);
    throw error;
  });
  optionsCache.set(tool, { at: Date.now(), promise });
  return promise;
}

export const withCount = (label, count) => (Number.isFinite(count) ? `${label} · ${count.toLocaleString()}` : label);
// Only offer a choice when there is more than one thing to choose between.
export const usable = (list) => Array.isArray(list) && list.length > 1;

export function resolveDates(common) {
  if (!common.datePreset || common.datePreset === 'all') return { from: null, to: null };
  if (common.datePreset === 'custom') return { from: common.dateFrom || null, to: common.dateTo || null };
  const { start, end } = computePresetDates(common.datePreset);
  return { from: start, to: end };
}

export const datePatch = (range, key) => (
  key === 'custom'
    ? { datePreset: 'custom', dateFrom: range.start, dateTo: range.end }
    : { datePreset: key, dateFrom: '', dateTo: '' }
);

/** Query params for /rows, /preview and the export itself. */
export function buildToolParams(state, { q, sheetKeys, onlySheet } = {}) {
  const { common, perSheet } = state;
  const { from, to } = resolveDates(common);
  const out = {};
  if (from) out.date_from = from;
  if (to) out.date_to = to;
  if (common.ownerUserId) out.owner_user_id = common.ownerUserId;
  if (common.department) out.department = common.department;
  if (common.linked) out.linked = common.linked;
  if (common.client) out.client = common.client;
  if (common.ownership) out.ownership = common.ownership;
  if (q) out.q = q;
  if (sheetKeys) out.sheets = sheetKeys.join(',');
  Object.entries(perSheet || {}).forEach(([sheetKey, values]) => {
    if (onlySheet && sheetKey !== onlySheet) return;
    Object.entries(values || {}).forEach(([key, value]) => {
      if (value !== '' && value !== undefined && value !== null) out[`${sheetKey}.${key}`] = value;
    });
  });
  return out;
}

export function invalidReason(state, sheets = []) {
  const { from, to } = resolveDates(state.common);
  if (from && to && from > to) return 'The start date is after the end date.';
  for (const sheet of sheets) {
    const values = state.perSheet?.[sheet.key] || {};
    for (const fd of sheet.filters || []) {
      if (fd.kind !== 'range') continue;
      const low = values[`${fd.key}_min`];
      const high = values[`${fd.key}_max`];
      if (low !== undefined && low !== '' && high !== undefined && high !== '' && Number(low) > Number(high)) {
        return `${fd.label}: minimum is above maximum.`;
      }
    }
  }
  return '';
}

const DATE_LABELS = Object.fromEntries(DATE_PRESETS.map((preset) => [preset.key, preset.label]));
const labelIn = (list, value) => (list || []).find((item) => String(item.value) === String(value))?.label || value;

/** Active filters as removable chips: [{ key, label, apply(state) => state }]. */
export function describeToolFilters(state, options, sheetKey) {
  const chips = [];
  const { common, perSheet } = state;
  const c = options?.common || {};
  const resetCommon = (patch) => (prev) => ({ ...prev, common: { ...prev.common, ...patch } });
  if (common.datePreset && common.datePreset !== 'all') {
    const { from, to } = resolveDates(common);
    chips.push({
      key: 'date',
      label: common.datePreset === 'custom' ? formatRange(from, to) : DATE_LABELS[common.datePreset] || common.datePreset,
      apply: resetCommon({ datePreset: 'all', dateFrom: '', dateTo: '' }),
    });
  }
  if (common.ownerUserId) chips.push({ key: 'owner', label: `Person: ${labelIn(c.owners, common.ownerUserId)}`, apply: resetCommon({ ownerUserId: '' }) });
  if (common.department) chips.push({ key: 'dept', label: `Dept: ${common.department}`, apply: resetCommon({ department: '' }) });
  if (common.linked) chips.push({ key: 'linked', label: labelIn(c.linked, common.linked), apply: resetCommon({ linked: '' }) });
  if (common.client) chips.push({ key: 'client', label: `Client: ${common.client}`, apply: resetCommon({ client: '' }) });
  if (common.ownership) chips.push({ key: 'ownership', label: labelIn(c.ownership, common.ownership), apply: resetCommon({ ownership: '' }) });

  const sheet = (options?.sheets || []).find((item) => item.key === sheetKey);
  const values = perSheet?.[sheetKey] || {};
  (sheet?.filters || []).forEach((fd) => {
    const resetSheet = (keys) => (prev) => {
      const next = { ...(prev.perSheet?.[sheetKey] || {}) };
      keys.forEach((key) => { delete next[key]; });
      return { ...prev, perSheet: { ...prev.perSheet, [sheetKey]: next } };
    };
    if (fd.kind === 'range') {
      const low = values[`${fd.key}_min`];
      const high = values[`${fd.key}_max`];
      if ((low ?? '') !== '' || (high ?? '') !== '') {
        chips.push({
          key: fd.key,
          label: `${fd.label} ${low || 0}–${high || '∞'}`,
          apply: resetSheet([`${fd.key}_min`, `${fd.key}_max`]),
        });
      }
    } else if ((values[fd.key] ?? '') !== '') {
      chips.push({ key: fd.key, label: `${fd.label}: ${labelIn(fd.options, values[fd.key])}`, apply: resetSheet([fd.key]) });
    }
  });
  return chips;
}
