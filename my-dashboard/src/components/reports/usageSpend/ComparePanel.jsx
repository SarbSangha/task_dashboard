import React, { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import ToolLogo, { toolColor } from '../../common/ToolLogo';
import Dropdown from './Dropdown';
import {
  Avatar,
  CHART_PALETTE,
  Icon,
  ICONS,
  Skel,
  fmtCompactINR,
  fmtCompactNum,
  fmtINR,
  fmtNum,
  hashHue,
  parseToolsUsed,
} from './shared';

export const COMPARE_MODES = [
  { value: 'tools', label: 'Tool comparison', hint: 'Tools side by side on every metric', iconD: ICONS.tool },
  { value: 'people', label: 'People comparison', hint: 'People side by side on every metric', iconD: ICONS.people },
  { value: 'generations', label: 'Generation comparison', hint: 'Rank outputs across tools, people, teams…', iconD: ICONS.doc },
  { value: 'credits', label: 'Credit comparison', hint: 'Rank credits used across tools, people, teams…', iconD: ICONS.coin },
];

const MAX_PICK = 6;

const money = (v) => fmtINR(v);
const num = (v) => fmtNum(v);

// Metrics for side-by-side comparison. lower = smaller is better.
const TOOL_METRICS = [
  { key: 'generations', label: 'Outputs', fmt: num, compact: fmtCompactNum },
  { key: 'credits', label: 'Credits used', fmt: num, compact: fmtCompactNum },
  { key: 'totalSpendRupees', label: 'Total spend', fmt: money, compact: fmtCompactINR, money: true },
  { key: 'itemSpendRupees', label: 'Usage spend', fmt: money, compact: fmtCompactINR, money: true },
  { key: 'subscriptionFeeRupees', label: 'Plan fee', fmt: money, compact: fmtCompactINR, money: true, neutral: true },
  { key: 'users', label: 'People using it', fmt: num, compact: fmtCompactNum },
  { key: 'avgSpendPerOutput', label: 'Cost per output', fmt: money, compact: fmtCompactINR, money: true, lower: true },
  { key: 'avgGenerationsPerDay', label: 'Outputs / day', fmt: num, compact: fmtCompactNum },
  { key: 'sharePct', label: 'Share of spend', fmt: (v) => `${fmtNum(v)}%`, compact: (v) => `${Math.round(v)}%`, neutral: true },
];

const PEOPLE_METRICS = [
  { key: 'generations', label: 'Outputs', fmt: num, compact: fmtCompactNum },
  { key: 'credits', label: 'Credits used', fmt: num, compact: fmtCompactNum },
  { key: 'spendRupees', label: 'Spend', fmt: money, compact: fmtCompactINR, money: true, neutral: true },
  { key: 'activeDays', label: 'Active days', fmt: num, compact: fmtCompactNum },
  { key: 'toolCount', label: 'Tools used', fmt: num, compact: fmtCompactNum },
  { key: 'avgGenerationsPerActiveDay', label: 'Outputs / active day', fmt: num, compact: fmtCompactNum },
  { key: 'avgSpendPerOutput', label: 'Cost per output', fmt: money, compact: fmtCompactINR, money: true, lower: true },
  { key: 'sharePct', label: 'Share of spend', fmt: (v) => `${fmtNum(v)}%`, compact: (v) => `${Math.round(v)}%`, neutral: true },
];

const DIMENSIONS = [
  { value: 'tools', label: 'Tools', one: 'Tool', sheet: 'tools', name: (r) => r.tool },
  { value: 'users', label: 'People', one: 'Person', sheet: 'users', name: (r) => r.userName },
  { value: 'departments', label: 'Departments', one: 'Department', sheet: 'departments', name: (r) => r.department },
  { value: 'clients', label: 'Clients', one: 'Client', sheet: 'clients', name: (r) => r.client },
  { value: 'daily', label: 'Days', one: 'Day', sheet: 'daily', name: (r) => r.date },
  { value: 'monthly', label: 'Months', one: 'Month', sheet: 'monthly', name: (r) => r.monthLabel },
];

const RANK_SORTS = [
  { value: 'desc', label: 'High → low' },
  { value: 'asc', label: 'Low → high' },
  { value: 'az', label: 'Name A → Z' },
  { value: 'za', label: 'Name Z → A' },
];

const TOP_N = [
  { value: 5, label: 'Top 5' },
  { value: 10, label: 'Top 10' },
  { value: 20, label: 'Top 20' },
  { value: 0, label: 'Show all' },
];

const ENTITY_SORTS = [
  { value: 'desc', label: 'High → low' },
  { value: 'asc', label: 'Low → high' },
  { value: 'pick', label: 'Order picked' },
];

const entityColor = (mode, name, i) => (mode === 'tools' ? toolColor(name) : CHART_PALETTE[i % CHART_PALETTE.length]);

const RankTip = ({ active, payload, fmt }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="zrs-tip">
      <span>{p.name}</span>
      <b>{fmt(p.value)}</b>
    </div>
  );
};

/**
 * Compare tab: Tool / People side-by-side, and Generation / Credit rankings
 * across any dimension, all sortable on the spot.
 */
export default function ComparePanel({ sheets, loading, state, setState, onDrill }) {
  const { mode, tools: pickedTools, people: pickedPeople, metric, entitySort, dimension, rankSort, topN } = state;
  const set = (patch) => setState((s) => ({ ...s, ...patch }));

  const isSideBySide = mode === 'tools' || mode === 'people';
  const metrics = mode === 'tools' ? TOOL_METRICS : PEOPLE_METRICS;

  /* ---------- side by side ---------- */
  const pool = useMemo(() => {
    if (mode === 'tools') return (sheets.tools || []).map((t) => ({ ...t, id: t.tool, name: t.tool }));
    if (mode === 'people')
      return (sheets.users || [])
        .filter((u) => Number(u.generations) > 0)
        .map((u) => ({ ...u, id: u.userId, name: u.userName, toolCount: (u.toolsUsed || []).length }));
    return [];
  }, [mode, sheets.tools, sheets.users]);

  const picks = mode === 'tools' ? pickedTools : pickedPeople;
  // Nothing picked yet: start with the four busiest.
  const effectivePicks = useMemo(() => {
    const valid = (picks || []).filter((id) => pool.some((p) => p.id === id));
    if (valid.length) return valid;
    return [...pool]
      .sort((a, b) => Number(b.generations || 0) - Number(a.generations || 0))
      .slice(0, 4)
      .map((p) => p.id);
  }, [picks, pool]);

  const entityOptions = useMemo(
    () =>
      [...pool]
        .sort((a, b) => Number(b.generations || 0) - Number(a.generations || 0))
        .map((p) => ({
          value: p.id,
          label: p.name,
          icon: mode === 'tools' ? <ToolLogo name={p.name} size={16} /> : <Avatar name={p.name} size={20} />,
          hint: mode === 'people' ? p.department : p.outputCategory,
          meta: fmtCompactNum(p.generations),
        })),
    [pool, mode]
  );

  const metricDef = metrics.find((m) => m.key === metric) || metrics[0];

  const entities = useMemo(() => {
    const chosen = effectivePicks.map((id) => pool.find((p) => p.id === id)).filter(Boolean);
    const withColor = chosen.map((e, i) => ({ ...e, color: entityColor(mode, e.name, i) }));
    if (entitySort === 'pick') return withColor;
    const mult = entitySort === 'asc' ? 1 : -1;
    return [...withColor].sort((a, b) => (Number(a[metricDef.key] || 0) - Number(b[metricDef.key] || 0)) * mult);
  }, [effectivePicks, pool, mode, entitySort, metricDef.key]);

  const best = useMemo(() => {
    const out = {};
    metrics.forEach((m) => {
      if (m.neutral || entities.length < 2) return;
      const vals = entities.map((e) => Number(e[m.key] || 0));
      const target = m.lower ? Math.min(...vals.filter((v) => v > 0)) : Math.max(...vals);
      if (Number.isFinite(target) && target > 0) out[m.key] = target;
    });
    return out;
  }, [entities, metrics]);

  const metricMax = useMemo(() => {
    const out = {};
    metrics.forEach((m) => {
      out[m.key] = Math.max(...entities.map((e) => Number(e[m.key] || 0)), 0) || 1;
    });
    return out;
  }, [entities, metrics]);

  /* ---------- rankings ---------- */
  const dim = DIMENSIONS.find((d) => d.value === dimension) || DIMENSIONS[0];
  const rankKey = mode === 'credits' ? 'credits' : 'generations';
  const rankFmt = fmtNum;

  const ranking = useMemo(() => {
    if (isSideBySide) return { rows: [], total: 0, avg: 0, count: 0 };
    const all = (sheets[dim.sheet] || [])
      .map((r) => ({
        raw: r,
        name: dim.name(r) || '—',
        value: Number(r[rankKey] || 0),
        spend: Number(r.spendRupees ?? r.itemSpendRupees ?? 0),
        outputs: Number(r.generations || 0),
        credits: Number(r.credits || 0),
      }))
      .filter((r) => r.value > 0);
    const total = all.reduce((s, r) => s + r.value, 0);
    const avg = all.length ? total / all.length : 0;
    const sorted = [...all].sort((a, b) => {
      if (rankSort === 'az') return a.name.localeCompare(b.name, 'en', { numeric: true });
      if (rankSort === 'za') return b.name.localeCompare(a.name, 'en', { numeric: true });
      return rankSort === 'asc' ? a.value - b.value : b.value - a.value;
    });
    const rows = (topN ? sorted.slice(0, topN) : sorted).map((r, i) => ({
      ...r,
      color: dim.value === 'tools' ? toolColor(r.name) : `hsl(${hashHue(r.name)} 70% 55%)`,
      share: total ? (r.value / total) * 100 : 0,
      vsAvg: avg ? ((r.value - avg) / avg) * 100 : 0,
      rank: i + 1,
    }));
    const values = all.map((r) => r.value);
    return {
      rows,
      total,
      avg,
      count: all.length,
      high: values.length ? Math.max(...values) : 0,
      low: values.length ? Math.min(...values) : 0,
      highName: all.find((r) => r.value === Math.max(...values))?.name,
      lowName: all.find((r) => r.value === Math.min(...values))?.name,
    };
  }, [isSideBySide, sheets, dim, rankKey, rankSort, topN]);

  const drillRow = (r) => {
    if (dim.value === 'tools') onDrill({ tool: r.name });
    else if (dim.value === 'users') onDrill({ user: r.raw.userId });
    else if (dim.value === 'departments') onDrill({ department: r.name });
    else if (dim.value === 'clients' && r.name !== 'No client') onDrill({ client: r.name });
    else if (dim.value === 'daily') onDrill({ date: r.raw.date });
  };

  const modeOptions = COMPARE_MODES.map((m) => ({ ...m, icon: <Icon d={m.iconD} size={16} /> }));

  return (
    <div className="zcp">
      <div className="zcp-bar">
        <Dropdown value={mode} options={modeOptions} onChange={(v) => set({ mode: v })} label="Comparison type" menuWidth={300} />

        {isSideBySide ? (
          <>
            <Dropdown
              multiple
              searchable
              max={MAX_PICK}
              value={effectivePicks}
              options={entityOptions}
              onChange={(v) => set(mode === 'tools' ? { tools: v } : { people: v })}
              allLabel={mode === 'tools' ? 'Pick tools' : 'Pick people'}
              label={mode === 'tools' ? 'Tools to compare' : 'People to compare'}
              menuWidth={300}
              className="zcp-picker"
            />
            <span className="zcp-sep" />
            <span className="zcp-lbl">Chart</span>
            <Dropdown
              value={metricDef.key}
              options={metrics.map((m) => ({ value: m.key, label: m.label }))}
              onChange={(v) => set({ metric: v })}
              label="Metric"
              size="sm"
            />
            <span className="zcp-lbl">Sort</span>
            <Dropdown value={entitySort} options={ENTITY_SORTS} onChange={(v) => set({ entitySort: v })} label="Sort" size="sm" />
          </>
        ) : (
          <>
            <span className="zcp-lbl">By</span>
            <Dropdown
              value={dimension}
              options={DIMENSIONS.map((d) => ({ value: d.value, label: d.label, meta: (sheets[d.sheet] || []).length }))}
              onChange={(v) => set({ dimension: v })}
              label="Compare across"
            />
            <span className="zcp-lbl">Sort</span>
            <Dropdown value={rankSort} options={RANK_SORTS} onChange={(v) => set({ rankSort: v })} label="Sort" size="sm" />
            <Dropdown value={topN} options={TOP_N} onChange={(v) => set({ topN: v })} label="How many" size="sm" />
          </>
        )}
      </div>

      {loading ? (
        <div className="zcp-skel">
          <div className="zcp-cards">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="zcp-card skel">
                <Skel w="60%" h={14} />
                <Skel w="45%" h={24} r={8} />
                <Skel w="80%" h={9} />
                <Skel w="70%" h={9} />
              </div>
            ))}
          </div>
          <div className="zcp-chart-card">
            {[82, 64, 48, 30, 18].map((w, i) => (
              <Skel key={i} w={`${w}%`} h={18} r={6} />
            ))}
          </div>
        </div>
      ) : isSideBySide ? (
        entities.length === 0 ? (
          <div className="zrs-empty">Nothing to compare for this selection.</div>
        ) : (
          <>
            <div className="zcp-cards">
              {entities.map((e) => {
                const tools = mode === 'people' ? parseToolsUsed(e.toolsUsed) : [];
                const toolTotal = tools.reduce((s, t) => s + t.count, 0) || 1;
                const isTop = best[metricDef.key] != null && Number(e[metricDef.key] || 0) === best[metricDef.key];
                return (
                  <article key={e.id} className={`zcp-card${isTop ? ' top' : ''}`} style={{ '--c': e.color }}>
                    <header>
                      {mode === 'tools' ? <ToolLogo name={e.name} size={22} /> : <Avatar name={e.name} size={28} />}
                      <button
                        type="button"
                        className="zrs-cell-btn"
                        onClick={() => onDrill(mode === 'tools' ? { tool: e.name } : { user: e.userId })}
                      >
                        {e.name}
                      </button>
                      {isTop && (
                        <span className="zcp-crown" title={`Best on ${metricDef.label}`}>
                          <Icon d={ICONS.crown} size={13} />
                        </span>
                      )}
                      <button
                        type="button"
                        className="zcp-x"
                        aria-label={`Remove ${e.name}`}
                        onClick={() => {
                          const next = effectivePicks.filter((id) => id !== e.id);
                          set(mode === 'tools' ? { tools: next } : { people: next });
                        }}
                      >
                        <Icon d={ICONS.close} size={12} />
                      </button>
                    </header>
                    <div className="zcp-card-val">
                      {metricDef.fmt(e[metricDef.key])}
                      <small>{metricDef.label}</small>
                    </div>
                    <dl>
                      <div>
                        <dt>Outputs</dt>
                        <dd>{fmtNum(e.generations)}</dd>
                      </div>
                      <div>
                        <dt>Credits</dt>
                        <dd>{fmtNum(e.credits)}</dd>
                      </div>
                      <div>
                        <dt>Spend</dt>
                        <dd>{fmtINR(mode === 'tools' ? e.totalSpendRupees : e.spendRupees)}</dd>
                      </div>
                      <div>
                        <dt>{mode === 'tools' ? 'Top user' : 'Top tool'}</dt>
                        <dd className="ellip">{mode === 'tools' ? e.topUser : e.topTool}</dd>
                      </div>
                    </dl>
                    {mode === 'people' && tools.length > 0 && (
                      <span className="zpm-mixbar" title={e.toolsUsedText}>
                        {tools.map((t) => (
                          <i key={t.tool} style={{ width: `${(t.count / toolTotal) * 100}%`, background: toolColor(t.tool) }} />
                        ))}
                      </span>
                    )}
                  </article>
                );
              })}
            </div>

            <div className="zcp-grid">
              <article className="zcp-chart-card">
                <h5>{metricDef.label}</h5>
                <div style={{ height: Math.max(160, entities.length * 46) }}>
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart
                      data={entities.map((e) => ({ name: e.name, value: Number(e[metricDef.key] || 0), color: e.color }))}
                      layout="vertical"
                      margin={{ top: 4, right: 56, left: 4, bottom: 4 }}
                    >
                      <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" horizontal={false} />
                      <XAxis
                        type="number"
                        tickFormatter={metricDef.compact}
                        tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                        axisLine={false}
                        tickLine={false}
                      />
                      <YAxis
                        type="category"
                        dataKey="name"
                        width={110}
                        tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                        axisLine={false}
                        tickLine={false}
                        tickFormatter={(v) => (String(v).length > 15 ? `${String(v).slice(0, 14)}…` : v)}
                      />
                      <Tooltip content={<RankTip fmt={metricDef.fmt} />} cursor={{ fill: 'var(--color-hover-surface)' }} />
                      <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={26} isAnimationActive={false}>
                        {entities.map((e) => (
                          <Cell key={e.id} fill={e.color} />
                        ))}
                        <LabelList
                          dataKey="value"
                          position="right"
                          formatter={metricDef.compact}
                          style={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                        />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </article>

              <article className="zcp-matrix-card">
                <div className="zcp-matrix-scroll">
                  <table className="zcp-matrix">
                    <thead>
                      <tr>
                        <th>Metric</th>
                        {entities.map((e) => (
                          <th key={e.id} style={{ '--c': e.color }}>
                            <span className="zcp-th">
                              <i />
                              {e.name}
                            </span>
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.map((m) => (
                        <tr key={m.key} className={m.key === metricDef.key ? 'on' : ''}>
                          <th>
                            <button type="button" onClick={() => set({ metric: m.key })} title="Chart this metric">
                              {m.label}
                              {m.lower && <small> (lower is better)</small>}
                            </button>
                          </th>
                          {entities.map((e) => {
                            const v = Number(e[m.key] || 0);
                            const win = best[m.key] != null && v === best[m.key];
                            return (
                              <td key={e.id} className={win ? 'win' : ''} style={{ '--c': e.color }}>
                                <span className="v">{m.fmt(v)}</span>
                                <span className="bar">
                                  <i style={{ width: `${(v / metricMax[m.key]) * 100}%` }} />
                                </span>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </article>
            </div>
          </>
        )
      ) : ranking.count === 0 ? (
        <div className="zrs-empty">No {mode === 'credits' ? 'credit usage' : 'generations'} for this selection.</div>
      ) : (
        <>
          <div className="zcp-stats">
            <div>
              <span>Total {mode === 'credits' ? 'credits' : 'outputs'}</span>
              <b>{rankFmt(ranking.total)}</b>
              <small>{ranking.count} {dim.label.toLowerCase()}</small>
            </div>
            <div>
              <span>Average</span>
              <b>{rankFmt(ranking.avg)}</b>
              <small>per {dim.one.toLowerCase()}</small>
            </div>
            <div>
              <span>Highest</span>
              <b>{rankFmt(ranking.high)}</b>
              <small className="ellip">{ranking.highName}</small>
            </div>
            <div>
              <span>Lowest</span>
              <b>{rankFmt(ranking.low)}</b>
              <small className="ellip">{ranking.lowName}</small>
            </div>
          </div>

          <div className="zcp-grid">
            <article className="zcp-chart-card">
              <h5>
                {mode === 'credits' ? 'Credits' : 'Outputs'} by {dim.label.toLowerCase()}
              </h5>
              <div style={{ height: Math.max(180, ranking.rows.length * 34) }}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={ranking.rows} layout="vertical" margin={{ top: 4, right: 56, left: 4, bottom: 4 }}>
                    <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" horizontal={false} />
                    <XAxis
                      type="number"
                      tickFormatter={fmtCompactNum}
                      tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis
                      type="category"
                      dataKey="name"
                      width={120}
                      tick={{ fill: 'var(--color-text-secondary)', fontSize: 12 }}
                      axisLine={false}
                      tickLine={false}
                      interval={0}
                      tickFormatter={(v) => (String(v).length > 16 ? `${String(v).slice(0, 15)}…` : v)}
                    />
                    <Tooltip content={<RankTip fmt={rankFmt} />} cursor={{ fill: 'var(--color-hover-surface)' }} />
                    <Bar dataKey="value" radius={[0, 6, 6, 0]} maxBarSize={22} isAnimationActive={false}>
                      {ranking.rows.map((r) => (
                        <Cell key={r.name} fill={r.color} />
                      ))}
                      <LabelList
                        dataKey="value"
                        position="right"
                        formatter={fmtCompactNum}
                        style={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                      />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </article>

            <article className="zcp-matrix-card">
              <div className="zcp-matrix-scroll">
                <table className="zcp-rank">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>{dim.one}</th>
                      <th className="num">{mode === 'credits' ? 'Credits' : 'Outputs'}</th>
                      <th className="num">Share</th>
                      <th className="num">vs avg</th>
                      <th className="num">{mode === 'credits' ? 'Credits / output' : 'Cost / output'}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranking.rows.map((r) => (
                      <tr key={r.name}>
                        <td className="rank">{r.rank}</td>
                        <td>
                          <button type="button" className="zcp-name" onClick={() => drillRow(r)}>
                            {dim.value === 'tools' ? (
                              <ToolLogo name={r.name} size={16} />
                            ) : dim.value === 'users' ? (
                              <Avatar name={r.name} size={22} />
                            ) : (
                              <i style={{ background: r.color }} />
                            )}
                            {r.name}
                          </button>
                        </td>
                        <td className="num strong">{rankFmt(r.value)}</td>
                        <td className="num">{fmtNum(r.share)}%</td>
                        <td className={`num ${r.vsAvg >= 0 ? 'up' : 'down'}`}>
                          {r.vsAvg >= 0 ? '+' : ''}
                          {Math.round(r.vsAvg)}%
                        </td>
                        <td className="num">
                          {mode === 'credits'
                            ? fmtNum(r.outputs ? r.credits / r.outputs : 0)
                            : fmtINR(r.outputs ? r.spend / r.outputs : 0)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </article>
          </div>
        </>
      )}
    </div>
  );
}
