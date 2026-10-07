// Line-level diff (longest common subsequence) for showing a user's edits to
// Claude's Optimized Structure. Inputs are capped so a huge cell can't freeze
// the browser; past the cap the remainder is shown as one changed block.

const MAX_LINES = 1500;

export function lineDiff(before = '', after = '') {
  const a = String(before ?? '').split('\n');
  const b = String(after ?? '').split('\n');
  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    return [...a.map((text) => ({ type: 'del', text })), ...b.map((text) => ({ type: 'add', text }))];
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push({ type: 'same', text: a[i] }); i += 1; j += 1; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { out.push({ type: 'del', text: a[i] }); i += 1; }
    else { out.push({ type: 'add', text: b[j] }); j += 1; }
  }
  while (i < n) { out.push({ type: 'del', text: a[i] }); i += 1; }
  while (j < m) { out.push({ type: 'add', text: b[j] }); j += 1; }
  return out;
}

export default lineDiff;
