// Client-side conversation filter predicates (Type / Status / Time). Pure -
// no React. Every predicate reads only fields the conversation summary already
// returns; nothing is fetched.
const DAY = 24 * 60 * 60 * 1000;
function within(value, ms) {
  if (!value) return false;
  const t = new Date(value).getTime();
  return Number.isFinite(t) && Date.now() - t <= ms;
}

export const TYPE_FILTERS = [
  { key: 'all', label: 'All', predicate: () => true },
  { key: 'text', label: 'Text', predicate: (c) => !(c.imagesCount > 0) && !(c.filesCount > 0) },
  { key: 'images', label: 'Images', predicate: (c) => (c.imagesCount || 0) > 0 },
  { key: 'files', label: 'Files', predicate: (c) => (c.filesCount || 0) > 0 },
];
export const STATUS_FILTERS = [
  { key: 'any', label: 'All', predicate: () => true },
  { key: 'completed', label: 'Completed', predicate: (c) => c.captureHealth === 'healthy' },
  { key: 'issues', label: 'Issues', predicate: (c) => c.captureHealth && c.captureHealth !== 'healthy' },
];
export const TIME_FILTERS = [
  { key: 'any', label: 'Any', predicate: () => true },
  { key: 'today', label: 'Today', predicate: (c) => within(c.lastSeenAt, DAY) },
  { key: 'week', label: 'Week', predicate: (c) => within(c.lastSeenAt, 7 * DAY) },
  { key: 'month', label: 'Month', predicate: (c) => within(c.lastSeenAt, 30 * DAY) },
];

export const FILTER_GROUPS = [
  { axis: 'type', label: 'Type', options: TYPE_FILTERS },
  { axis: 'status', label: 'Status', options: STATUS_FILTERS },
  { axis: 'time', label: 'Time', options: TIME_FILTERS },
];

export const DEFAULT_CONVERSATION_FILTERS = { type: 'all', status: 'any', time: 'any' };

export function applyConversationFilters(conversations, filters) {
  const t = TYPE_FILTERS.find((f) => f.key === filters.type) || TYPE_FILTERS[0];
  const s = STATUS_FILTERS.find((f) => f.key === filters.status) || STATUS_FILTERS[0];
  const tm = TIME_FILTERS.find((f) => f.key === filters.time) || TIME_FILTERS[0];
  if (t.key === 'all' && s.key === 'any' && tm.key === 'any') return conversations;
  return conversations.filter((c) => t.predicate(c) && s.predicate(c) && tm.predicate(c));
}
