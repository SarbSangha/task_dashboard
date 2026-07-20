// Resolve which datum a recharts click landed on.
//
// recharts v3 changed the chart-level onClick payload: it no longer carries
// `activePayload`, only { activeIndex, activeTooltipIndex, activeLabel, ... }.
// Reading e.activePayload[0].payload — the v2 idiom — silently yields undefined
// and the handler does nothing, so every chart drill must go through here.
//
//   <BarChart data={rows} onClick={chartClick(rows, (d) => onDrill(view, { hour: d.hour }))} />
//
// `data` must be the exact array passed to the chart (post-slice), because the
// index is positional — indexing a wider array drills into the wrong row.
export const chartClick = (data, pick, enabled = true) => (state) => {
  if (!enabled || typeof pick !== 'function' || !Array.isArray(data)) return;
  const i = Number(state?.activeIndex ?? state?.activeTooltipIndex);
  // Guard with Number.isInteger, not truthiness: index 0 is a valid first bar.
  if (!Number.isInteger(i) || i < 0 || i >= data.length) return;
  pick(data[i], i);
};

export default chartClick;
