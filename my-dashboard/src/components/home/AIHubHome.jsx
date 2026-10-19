import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { creditReportAPI } from '../../services/reports';
import { itToolsAPI } from '../../services/api';
import { useAuth } from '../../context/AuthContext';
import { usePermissions } from '../../hooks/usePermissions';
import ToolLogo from '../common/ToolLogo';
import './AIHubHome.css';

const pad = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const fmtINR = (val) => {
  const n = Number(val || 0);
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
};
const fmtShortINR = (val) => {
  const n = Number(val || 0);
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(1)}Cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(1)}L`;
  if (n >= 1e3) return `₹${(n / 1e3).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
};
const fmtNum = (val) => Number(val || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 });

const PALETTE = ['#10b981', '#8b5cf6', '#38bdf8', '#f59e0b', '#ec4899', '#14b8a6', '#a3a3a3'];

const PERIODS = [
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'month', label: 'This month' },
];

const periodRange = (id) => {
  const end = new Date();
  const start = new Date();
  if (id === 'month') start.setDate(1);
  else start.setDate(start.getDate() - (id === '7d' ? 6 : 29));
  return { start: toIso(start), end: toIso(end) };
};

const greeting = () => {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 17) return 'Good afternoon';
  return 'Good evening';
};

const hueOf = (text = '') => {
  let h = 0;
  for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) % 360;
  return h;
};

const initials = (name = '') =>
  name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0].toUpperCase())
    .join('') || '?';

const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const ICONS = {
  rupee: 'M6 3h12M6 8h12M6 13l8.5 8M6 13h3a5 5 0 0 0 0-10',
  avg: 'M3 3v18h18M7 15l4-4 3 3 5-6',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  spark: 'M12 3l1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2z',
  chart: 'M3 3v18h18M8 17V9M13 17V5M18 17v-6',
  tools: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z',
  plus: 'M12 5v14M5 12h14',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z',
  bulb: 'M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.74V17h8v-2.26A7 7 0 0 0 12 2z',
  alert: 'M12 9v4M12 17h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  arrow: 'M5 12h14M13 5l7 7-7 7',
};

function Icon({ name, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}

function Avatar({ name }) {
  return (
    <span className="hub-avatar" style={{ '--hue': hueOf(name) }}>
      {initials(name)}
    </span>
  );
}

function Kpi({ tone, icon, label, value, unit, foot, loading }) {
  return (
    <article className={`hub-kpi tone-${tone} ${loading ? 'is-loading' : ''}`}>
      <span className="hub-kpi-icon">
        <Icon name={icon} size={20} />
      </span>
      <div className="hub-kpi-body">
        <span className="hub-kpi-label">{label}</span>
        <strong>
          {value}
          {unit && <small>{unit}</small>}
        </strong>
        <span className="hub-kpi-foot">{foot}</span>
      </div>
    </article>
  );
}

function ChartTip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  return (
    <div className="hub-tip">
      <span>{row.full || label}</span>
      <b>{fmtINR(row.spend)}</b>
      {row.outputs != null && <span>{fmtNum(row.outputs)} outputs</span>}
    </div>
  );
}

export default function AIHubHome({ pushMeta, pushDetail }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { can, isAdmin } = usePermissions();
  const canSeeSpend = isAdmin || can('view_credit_report');

  const [period, setPeriod] = useState('30d');
  const [toolSearch, setToolSearch] = useState('');

  const range = useMemo(() => periodRange(period), [period]);

  const sheetQuery = useQuery({
    queryKey: ['credit-report', 'live-sheet', 'home', range],
    queryFn: () => creditReportAPI.liveSheet({ ...range, limit: 50 }),
    enabled: canSeeSpend,
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  const toolsQuery = useQuery({
    queryKey: ['it-tools', 'home-launcher'],
    queryFn: () => itToolsAPI.listTools(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  const data = sheetQuery.data || {};
  const kpis = data.kpis || {};
  const avgs = kpis.averages || {};
  const sheets = data.sheets || {};
  const loading = sheetQuery.isLoading;
  const fetching = sheetQuery.isFetching;
  const periodLabel = PERIODS.find((p) => p.id === period)?.label || '';

  const change = kpis.spendChangeText || '';
  const changeTone = change.startsWith('▲') ? 'up' : change.startsWith('▼') ? 'down' : 'flat';

  const trendData = useMemo(() => {
    const byDate = new Map((sheets.daily || []).map((d) => [d.date, d]));
    const out = [];
    const cur = new Date(`${range.start}T00:00:00`);
    const last = new Date(`${range.end}T00:00:00`);
    while (cur <= last) {
      const iso = toIso(cur);
      const row = byDate.get(iso);
      out.push({
        label: shortDate(iso),
        full: cur.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' }),
        spend: Number(row?.spendRupees || 0),
        outputs: Number(row?.generations || 0),
      });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [sheets.daily, range]);

  const toolData = useMemo(() => {
    const rows = [...(sheets.tools || [])].sort((a, b) => Number(b.totalSpendRupees || 0) - Number(a.totalSpendRupees || 0));
    const top = rows.slice(0, 6).map((t, i) => ({
      name: t.tool,
      spend: Number(t.totalSpendRupees || 0),
      outputs: Number(t.generations || 0),
      users: t.users,
      color: PALETTE[i],
    }));
    const rest = rows.slice(6);
    if (rest.length) {
      top.push({
        name: 'Others',
        spend: rest.reduce((s, t) => s + Number(t.totalSpendRupees || 0), 0),
        outputs: rest.reduce((s, t) => s + Number(t.generations || 0), 0),
        color: PALETTE[6],
      });
    }
    const total = top.reduce((s, t) => s + t.spend, 0) || 1;
    return top.map((t) => ({ ...t, pct: Math.round((t.spend / total) * 100) }));
  }, [sheets.tools]);

  const people = useMemo(
    () => [...(sheets.users || [])].sort((a, b) => Number(b.spendRupees || 0) - Number(a.spendRupees || 0)).slice(0, 6),
    [sheets.users]
  );
  const maxPersonSpend = Math.max(1, ...people.map((p) => Number(p.spendRupees || 0)));

  const departments = useMemo(
    () => [...(sheets.departments || [])].sort((a, b) => Number(b.spendRupees || 0) - Number(a.spendRupees || 0)).slice(0, 6),
    [sheets.departments]
  );
  const maxDeptSpend = Math.max(1, ...departments.map((d) => Number(d.spendRupees || 0)));

  const recent = (sheets.log || []).slice(0, 8);
  const keyPoints = (data.insights?.keyPoints || []).slice(0, 4);
  const attention = (data.insights?.attention || []).slice(0, 3);

  const tools = toolsQuery.data?.tools || [];
  const visibleTools = tools.filter((t) => {
    if (!toolSearch.trim()) return true;
    const q = toolSearch.toLowerCase();
    return `${t.name} ${t.category || ''} ${t.description || ''}`.toLowerCase().includes(q);
  });

  const openReports = () => navigate(isAdmin ? '/dashboard/reports' : '/dashboard/credit-report');
  const openTools = () => navigate('/dashboard/workspace?tab=Tools');

  const firstName = (user?.name || 'there').split(' ')[0];
  const today = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <div className="hub">
      {/* Header */}
      <section className="hub-head">
        <div className="hub-head-copy">
          <span className="hub-date">{today}</span>
          <h1>
            {greeting()}, {firstName}
          </h1>
          <p>
            {canSeeSpend
              ? 'Here is how your team is using AI tools and what it is costing.'
              : 'Open your AI tools and keep track of your work.'}
          </p>
        </div>
        <div className="hub-head-actions">
          {canSeeSpend && (
            <div className="hub-period" role="tablist" aria-label="Period">
              {PERIODS.map((p) => (
                <button key={p.id} type="button" role="tab" aria-selected={period === p.id} className={period === p.id ? 'on' : ''} onClick={() => setPeriod(p.id)}>
                  {p.label}
                </button>
              ))}
              {fetching && !loading && <span className="hub-spinner" aria-label="Updating" />}
            </div>
          )}
          <div className="hub-quick">
            {canSeeSpend && (
              <button type="button" className="hub-btn primary" onClick={openReports}>
                <Icon name="chart" size={16} /> Full report
              </button>
            )}
            <button type="button" className="hub-btn" onClick={openTools}>
              <Icon name="tools" size={16} /> AI tools
            </button>
            <button type="button" className="hub-btn" onClick={() => navigate('/dashboard/create-task')}>
              <Icon name="plus" size={16} /> Assign task
            </button>
            <button type="button" className="hub-btn" onClick={() => navigate('/dashboard/inbox')}>
              <Icon name="inbox" size={16} /> Inbox
            </button>
          </div>
        </div>
      </section>

      {canSeeSpend && (
        <>
          {/* KPIs */}
          <section className="hub-kpis">
            <Kpi
              tone="green"
              icon="rupee"
              label={`Total spent · ${periodLabel}`}
              value={fmtINR(kpis.totalSpendRupees)}
              loading={loading}
              foot={
                <>
                  {change && change !== '—' && <em className={changeTone}>{change}</em>} vs previous period
                </>
              }
            />
            <Kpi
              tone="violet"
              icon="avg"
              label="Average spend"
              value={fmtINR(avgs.spendPerDay)}
              unit="/day"
              loading={loading}
              foot={`${fmtINR(avgs.spendPerMonth)} per month`}
            />
            <Kpi
              tone="amber"
              icon="file"
              label="Outputs generated"
              value={fmtNum(kpis.totalGenerations)}
              loading={loading}
              foot={`${fmtNum(avgs.generationsPerDay)}/day · ${fmtINR(avgs.spendPerOutput)} each`}
            />
            <Kpi
              tone="pink"
              icon="users"
              label="Active people"
              value={fmtNum(kpis.activeUsers)}
              loading={loading}
              foot={`${fmtINR(avgs.spendPerUser)} per person`}
            />
            <Kpi
              tone="teal"
              icon="spark"
              label="AI tools in use"
              value={fmtNum(kpis.activeTools)}
              loading={loading}
              foot={`${fmtNum(kpis.totalCredits)} credits used`}
            />
          </section>

          {/* Key takeaways */}
          {(keyPoints.length > 0 || attention.length > 0) && (
            <section className="hub-insights">
              {keyPoints.length > 0 && (
                <div className="hub-insight">
                  <span className="hub-insight-icon">
                    <Icon name="bulb" size={16} />
                  </span>
                  <div>
                    <h3>Key takeaways</h3>
                    <ul>
                      {keyPoints.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
              {attention.length > 0 && (
                <div className="hub-insight warn">
                  <span className="hub-insight-icon">
                    <Icon name="alert" size={16} />
                  </span>
                  <div>
                    <h3>Needs attention</h3>
                    <ul>
                      {attention.map((p) => (
                        <li key={p}>{p}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}
            </section>
          )}

          {/* Trend + tool split */}
          <section className="hub-row hub-row--wide">
            <article className="hub-card">
              <header className="hub-card-head">
                <div>
                  <h2>Spend trend</h2>
                  <p>Daily spend · {periodLabel}</p>
                </div>
                <div className="hub-card-stat">
                  <b>{fmtINR(kpis.totalSpendRupees)}</b>
                  {change && change !== '—' && <em className={changeTone}>{change}</em>}
                </div>
              </header>
              <div className="hub-chart">
                {trendData.every((d) => !d.spend) ? (
                  <div className="hub-empty">{loading ? 'Loading…' : 'No spend recorded in this period.'}</div>
                ) : (
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={trendData} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                      <defs>
                        <linearGradient id="hubSpend" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                          <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                      <XAxis dataKey="label" tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis tickFormatter={fmtShortINR} tick={{ fontSize: 11, fill: 'var(--color-text-muted)' }} tickLine={false} axisLine={false} width={52} />
                      <Tooltip content={<ChartTip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
                      <Area type="monotone" dataKey="spend" stroke="#10b981" strokeWidth={2} fill="url(#hubSpend)" />
                    </AreaChart>
                  </ResponsiveContainer>
                )}
              </div>
            </article>

            <article className="hub-card">
              <header className="hub-card-head">
                <div>
                  <h2>Where the money goes</h2>
                  <p>Spend by AI tool</p>
                </div>
              </header>
              {toolData.length === 0 ? (
                <div className="hub-empty">{loading ? 'Loading…' : 'No tool usage yet.'}</div>
              ) : (
                <div className="hub-donut-wrap">
                  <div className="hub-donut">
                    <ResponsiveContainer width="100%" height="100%">
                      <PieChart>
                        <Pie data={toolData} dataKey="spend" nameKey="name" innerRadius="66%" outerRadius="100%" paddingAngle={2} stroke="none">
                          {toolData.map((t) => (
                            <Cell key={t.name} fill={t.color} />
                          ))}
                        </Pie>
                        <Tooltip content={<ChartTip />} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="hub-donut-center">
                      <b>{fmtShortINR(kpis.totalSpendRupees)}</b>
                      <span>total</span>
                    </div>
                  </div>
                  <ul className="hub-legend">
                    {toolData.map((t) => (
                      <li key={t.name}>
                        <i style={{ background: t.color }} />
                        {t.name !== 'Others' && <ToolLogo name={t.name} size={16} />}
                        <span className="hub-legend-name">{t.name}</span>
                        <span className="hub-legend-pct">{t.pct}%</span>
                        <span className="hub-legend-val">{fmtShortINR(t.spend)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </article>
          </section>

          {/* People + departments */}
          <section className="hub-row">
            <article className="hub-card">
              <header className="hub-card-head">
                <div>
                  <h2>Top spenders</h2>
                  <p>Who is using AI the most</p>
                </div>
                <button type="button" className="hub-link" onClick={openReports}>
                  All people <Icon name="arrow" size={14} />
                </button>
              </header>
              {people.length === 0 ? (
                <div className="hub-empty">{loading ? 'Loading…' : 'No activity yet.'}</div>
              ) : (
                <ol className="hub-rank">
                  {people.map((p, i) => (
                    <li key={p.userId || p.userName} onClick={openReports}>
                      <span className="hub-rank-no">{i + 1}</span>
                      <Avatar name={p.userName} />
                      <div className="hub-rank-who">
                        <b>{p.userName}</b>
                        <span>
                          {p.department || '—'} · {fmtNum(p.generations)} outputs
                        </span>
                      </div>
                      <div className="hub-rank-bar">
                        <span style={{ width: `${(Number(p.spendRupees || 0) / maxPersonSpend) * 100}%` }} />
                      </div>
                      <b className="hub-rank-val">{fmtINR(p.spendRupees)}</b>
                    </li>
                  ))}
                </ol>
              )}
            </article>

            <article className="hub-card">
              <header className="hub-card-head">
                <div>
                  <h2>Department-wise spend</h2>
                  <p>Which teams spend the most</p>
                </div>
              </header>
              {departments.length === 0 ? (
                <div className="hub-empty">{loading ? 'Loading…' : 'No department data yet.'}</div>
              ) : (
                <ul className="hub-depts">
                  {departments.map((d, i) => (
                    <li key={d.department}>
                      <div className="hub-dept-top">
                        <span className="hub-dept-name">
                          <i style={{ background: PALETTE[i % PALETTE.length] }} />
                          {d.department}
                        </span>
                        <b>{fmtINR(d.spendRupees)}</b>
                      </div>
                      <div className="hub-dept-bar">
                        <span style={{ width: `${(Number(d.spendRupees || 0) / maxDeptSpend) * 100}%`, background: PALETTE[i % PALETTE.length] }} />
                      </div>
                      <span className="hub-dept-meta">
                        {fmtNum(d.users)} people · {fmtNum(d.generations)} outputs
                        {d.topTool ? ` · mostly ${d.topTool}` : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>

          {/* Who generated what */}
          <section className="hub-card">
            <header className="hub-card-head">
              <div>
                <h2>Who generated what</h2>
                <p>Latest AI outputs across the team</p>
              </div>
              <button type="button" className="hub-link" onClick={openReports}>
                Open in Excel <Icon name="arrow" size={14} />
              </button>
            </header>
            <div className="hub-table-wrap">
              <table className="hub-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Person</th>
                    <th>Tool</th>
                    <th>Output</th>
                    <th className="num">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="hub-empty">
                        {loading ? 'Loading…' : 'No generations in this period.'}
                      </td>
                    </tr>
                  ) : (
                    recent.map((r) => (
                      <tr key={`${r.tool}-${r.recordId}-${r.rowNum}`} onClick={openReports}>
                        <td className="nowrap">
                          {shortDate(r.date)}
                          <span className="hub-sub">{r.time}</span>
                        </td>
                        <td>
                          <span className="hub-person">
                            <Avatar name={r.userName} />
                            <span>
                              <b>{r.userName}</b>
                              <span className="hub-sub">{r.department}</span>
                            </span>
                          </span>
                        </td>
                        <td className="nowrap">
                          <span className="hub-chip">
                            <ToolLogo name={r.tool} size={16} /> {r.tool}
                          </span>
                        </td>
                        <td className="hub-out">
                          {r.outputType}
                          <span className="hub-sub">{r.whatGenerated}</span>
                        </td>
                        <td className="num hub-money">{fmtINR(r.spendRupees)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}

      {/* AI tool launcher */}
      <section className="hub-card">
        <header className="hub-card-head">
          <div>
            <h2>AI tools</h2>
            <p>{tools.length ? `${tools.length} tools · one click to open` : 'Your tool vault'}</p>
          </div>
          <div className="hub-launcher-tools">
            <input type="search" placeholder="Search tools…" value={toolSearch} onChange={(e) => setToolSearch(e.target.value)} />
            <button type="button" className="hub-link" onClick={openTools}>
              Tool vault <Icon name="arrow" size={14} />
            </button>
          </div>
        </header>
        <div className="hub-tools">
          {toolsQuery.isLoading && <div className="hub-empty">Loading tools…</div>}
          {!toolsQuery.isLoading && visibleTools.length === 0 && (
            <div className="hub-empty">
              {tools.length ? 'No tools match your search.' : 'No AI tools assigned to you yet. Ask your admin for access.'}
            </div>
          )}
          {visibleTools.map((t) => (
            <button key={t.id} type="button" className="hub-tool" onClick={openTools} title={t.description || t.name}>
              <span className="hub-tool-icon">
                <ToolLogo name={t.name} websiteUrl={t.websiteUrl || t.loginUrl} size={22} />
              </span>
              <span className="hub-tool-copy">
                <b>{t.name}</b>
                <small>{t.category || 'AI tool'}</small>
              </span>
              {t.singleSeat && <span className="hub-tool-tag">1 seat</span>}
            </button>
          ))}
        </div>
      </section>

      {pushMeta && (
        <footer className="hub-foot">
          <span className={`hub-status hub-status--${pushMeta.code}`}>
            <i /> Notifications: {pushMeta.label}
          </span>
          {pushDetail && <span className="hub-dim">{pushDetail}</span>}
        </footer>
      )}
    </div>
  );
}
