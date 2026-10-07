// Shared date formatting for the Sheets section. "≈" marks times the
// dashboard inferred from a poll rather than read from an Apps Script event.

export const formatWhen = (iso, approximate) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const text = d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  return approximate ? `≈ ${text}` : text;
};

// keyword_ranking AI Overview states (backend services/sheets/ranking.py).
export const AI_LABELS = {
  cited: 'Cited', not_cited: 'Not cited', none: 'No AI Overview', failed: 'Check failed', unparsed: 'Unreadable', blank: '—',
};

export default formatWhen;
