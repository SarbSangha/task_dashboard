import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { creditReportAPI, downloadBlobResponse } from '../../services/reports';
import ToolLogo, { toolColor } from '../common/ToolLogo';
import './ZomatoExcelReportStudio.css';

const DATE_PRESETS = [
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: 'month', label: 'This month' },
  { key: 'prev_month', label: 'Last month' },
  { key: '90d', label: 'Last 3 months' },
  { key: 'custom', label: 'Custom range' },
];

const SHEETS = [
  { key: 'log', label: 'Activity', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.4l3.7 2.2-.8 1.3L11 13V7h2z' },
  { key: 'users', label: 'People', icon: 'M12 12a4 4 0 100-8 4 4 0 000 8zm-7 8c0-3.3 3.1-6 7-6s7 2.7 7 6H5z' },
  { key: 'tools', label: 'Tools', icon: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z' },
  { key: 'daily', label: 'Daily', icon: 'M7 2v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2H7zm-2 8h14v10H5V10z' },
  { key: 'monthly', label: 'Monthly', icon: 'M5 20V10h3v10H5zm5.5 0V4h3v16h-3zM16 20v-7h3v7h-3z' },
  { key: 'departments', label: 'Departments', icon: 'M3 21V7l6-4 6 4v2h6v12H3zm2-2h4v-3H5v3zm0-5h4v-3H5v3zm6 5h4v-3h-4v3zm0-5h4v-3h-4v3zm6 5h2v-8h-2v8z' },
];

const LOG_COLUMNS = [
  { key: 'when', label: 'When' },
  { key: 'person', label: 'Person' },
  { key: 'tool', label: 'Tool' },
  { key: 'output', label: 'Output' },
  { key: 'prompt', label: 'Prompt' },
  { key: 'client', label: 'Client / Project' },
  { key: 'department', label: 'Department' },
  { key: 'credits', label: 'Credits', num: true },
  { key: 'cost', label: 'Cost (₹)', num: true },
  { key: 'actions', label: 'Actions' },
];

const SHEET_COLS = { log: 10, users: 9, tools: 10, daily: 7, monthly: 8, departments: 8 };
const CHART_PALETTE = ['#10b981', '#8b5cf6', '#38bdf8', '#f59e0b', '#ec4899', '#14b8a6', '#f97316', '#a3e635'];
const DEPT_HUES = [160, 262, 330, 38, 200, 20, 290, 85];

const pad = (n) => String(n).padStart(2, '0');
const toIso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function computePresetDates(presetKey) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const back = (days) => {
    const s = new Date(today);
    s.setDate(s.getDate() - (days - 1));
    return { start: toIso(s), end: toIso(today) };
  };
  if (presetKey === '7d') return back(7);
  if (presetKey === '90d') return back(90);
  if (presetKey === 'month') {
    return { start: toIso(new Date(today.getFullYear(), today.getMonth(), 1)), end: toIso(today) };
  }
  if (presetKey === 'prev_month') {
    return {
      start: toIso(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      end: toIso(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  }
  return back(30);
}

const fmtINR = (val) => {
  const n = Number(val || 0);
  return `₹${n.toLocaleString('en-IN', { maximumFractionDigits: n >= 1000 ? 0 : 2 })}`;
};
const fmtCompactINR = (val) => {
  const n = Number(val || 0);
  if (n >= 100000) return `₹${(n / 100000).toFixed(1)}L`;
  if (n >= 1000) return `₹${(n / 1000).toFixed(1)}K`;
  return `₹${Math.round(n)}`;
};
const fmtNum = (val) => Number(val || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 });
const shortDate = (iso) => {
  const d = new Date(`${iso}T00:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

const hashHue = (text, hues) => hues[[...String(text || '')].reduce((s, c) => s + c.charCodeAt(0), 0) % hues.length];

/* ---------- small building blocks ---------- */

const Icon = ({ d, size = 16 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
    <path d={d} fill="currentColor" />
  </svg>
);

const ICONS = {
  rupee: 'M7 4h10v2h-3.2c.5.6.9 1.3 1.1 2H17v2h-2.1c-.4 2.3-2.4 4-4.9 4h-.6l5.3 6h-2.7l-5.3-6H6v-2h4c1.4 0 2.6-.8 3-2H6V8h6.9c-.4-1.2-1.6-2-2.9-2H7V4z',
  bars: 'M5 20V10h3v10H5zm5.5 0V4h3v16h-3zM16 20v-7h3v7h-3z',
  doc: 'M6 2h8l6 6v12a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2zm7 1.5V9h5.5L13 3.5zM8 13h8v2H8v-2zm0 4h8v2H8v-2z',
  people: 'M9 11a4 4 0 100-8 4 4 0 000 8zm7 0a3 3 0 100-6 3 3 0 000 6zM2 20c0-3.3 3.1-6 7-6s7 2.7 7 6H2zm15.5 0c0-1.9-.8-3.6-2.1-4.8 3 .3 5.6 2.2 5.6 4.8h-3.5z',
  info: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
  calendar: 'M7 2v2H5a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2V6a2 2 0 00-2-2h-2V2h-2v2H9V2H7zm-2 8h14v10H5V10z',
  refresh: 'M17.7 6.3A8 8 0 1020 12h-2a6 6 0 11-1.8-4.2L13 11h7V4l-2.3 2.3z',
  download: 'M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V3zM5 19h14v2H5v-2z',
  search: 'M10 4a6 6 0 104.47 10.03l4.75 4.75 1.06-1.06-4.75-4.75A6 6 0 0010 4zm0 1.5a4.5 4.5 0 110 9 4.5 4.5 0 010-9z',
  columns: 'M3 5h18v14H3V5zm2 2v10h4V7H5zm6 0v10h2V7h-2zm4 0v10h4V7h-4z',
  chart: 'M4 19h16v2H2V3h2v16zm3-3l4-5 3 3 5-7 1.6 1.2-6.4 9-3-3-2.6 3.3L7 16z',
};

const Avatar = ({ name }) => {
  const label = String(name || '?').trim();
  const initials = label.split(/\s+/).slice(0, 2).map((p) => p.charAt(0).toUpperCase()).join('');
  return (
    <span className="zrs-avatar" style={{ '--hue': hashHue(label, DEPT_HUES) }} aria-hidden="true">
      {initials || '?'}
    </span>
  );
};

const ToolTag = ({ name, onClick }) => (
  <button
    type="button"
    className="zrs-tool-tag"
    style={{ '--tool': toolColor(name) }}
    onClick={onClick}
    disabled={!onClick}
    title={onClick ? `Show only ${name}` : name}
  >
    <ToolLogo name={name} size={16} />
    {name}
  </button>
);

const DeptPill = ({ name }) =>
  name ? (
    <span className="zrs-dept" style={{ '--hue': hashHue(name, DEPT_HUES) }}>
      {name}
    </span>
  ) : (
    <span className="zrs-muted">—</span>
  );

const ShareBar = ({ pct }) => (
  <div className="zrs-share">
    <span className="zrs-share-track">
      <span style={{ width: `${Math.min(100, Number(pct || 0))}%` }} />
    </span>
    <span className="zrs-share-val">{fmtNum(pct)}%</span>
  </div>
);

const SkeletonRows = ({ cols, rows = 8 }) => (
  <tbody className="zrs-skeleton">
    {Array.from({ length: rows }).map((_, r) => (
      <tr key={r}>
        {Array.from({ length: cols }).map((__, c) => (
          <td key={c}>
            <span style={{ width: `${45 + ((r * 7 + c * 13) % 45)}%` }} />
          </td>
        ))}
      </tr>
    ))}
  </tbody>
);

const Kpi = ({ tone, icon, label, value, unit, foot, hint, loading }) => (
  <article className={`zrs-kpi tone-${tone}${loading ? ' is-loading' : ''}`}>
    <span className="zrs-kpi-icon">
      <Icon d={icon} size={22} />
    </span>
    <div className="zrs-kpi-body">
      <span className="zrs-kpi-label">{label}</span>
      <strong>
        {value}
        {unit ? <small>{unit}</small> : null}
      </strong>
      <span className="zrs-kpi-foot">{foot}</span>
    </div>
    <span className="zrs-kpi-info" title={hint}>
      <Icon d={ICONS.info} size={15} />
    </span>
  </article>
);

const ChartTooltip = ({ active, payload, label, money = true }) => {
  if (!active || !payload?.length) return null;
  const p = payload[0];
  return (
    <div className="zrs-tip">
      <span>{label || p.payload?.name}</span>
      <b>{money ? fmtINR(p.value) : fmtNum(p.value)}</b>
    </div>
  );
};

function useOutsideClose(open, setOpen) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, setOpen]);
  return ref;
}

/* ---------- main ---------- */

export default function ZomatoExcelReportStudio({ onSwitchToAdvanced }) {
  const queryClient = useQueryClient();

  const [preset, setPreset] = useState('30d');
  const [dateRange, setDateRange] = useState(() => computePresetDates('30d'));
  const [tool, setTool] = useState('all');
  const [department, setDepartment] = useState('all');
  const [userId, setUserId] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sheet, setSheet] = useState('log');
  const [trendMode, setTrendMode] = useState('daily');
  const [toolMode, setToolMode] = useState('outputs');
  const [deptMode, setDeptMode] = useState('spend');
  const [hiddenCols, setHiddenCols] = useState(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const exportRef = useOutsideClose(exportOpen, setExportOpen);
  const colsRef = useOutsideClose(colsOpen, setColsOpen);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 350);
    return () => clearTimeout(id);
  }, [search]);

  const notify = (msg) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3200);
  };

  const pickPreset = (key) => {
    setPreset(key);
    if (key !== 'custom') setDateRange(computePresetDates(key));
  };

  const params = useMemo(() => {
    const p = { start: dateRange.start, end: dateRange.end };
    if (department !== 'all') p.department = department;
    if (userId !== 'all') p.user = userId;
    if (tool !== 'all') p.tool = tool;
    if (debouncedSearch) p.search = debouncedSearch;
    return p;
  }, [dateRange, department, userId, tool, debouncedSearch]);

  const query = useQuery({
    queryKey: ['credit-report', 'live-sheet', params],
    queryFn: () => creditReportAPI.liveSheet(params),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const typing = search.trim() !== debouncedSearch;
  const refreshing = typing || (query.isFetching && !query.isLoading);
  const loading = query.isLoading || refreshing;

  const data = query.data;
  const kpis = data?.kpis || {};
  const avgs = kpis.averages || {};
  const period = data?.period || {};
  const options = data?.options || { departments: [], users: [], tools: [] };
  const sheets = data?.sheets || {};

  const userOptions = useMemo(() => {
    const all = options.users || [];
    return department === 'all' ? all : all.filter((u) => u.department === department);
  }, [options.users, department]);

  /* chart data */
  const trendData = useMemo(() => {
    if (trendMode === 'monthly') {
      return (sheets.monthly || []).map((m) => ({ label: m.monthLabel, value: Number(m.spendRupees || 0) }));
    }
    const byDate = new Map((sheets.daily || []).map((d) => [d.date, Number(d.spendRupees || 0)]));
    const out = [];
    const start = new Date(`${dateRange.start}T00:00:00`);
    const end = new Date(`${dateRange.end}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
    for (let d = new Date(start); d <= end && out.length < 400; d.setDate(d.getDate() + 1)) {
      const iso = toIso(d);
      out.push({ label: shortDate(iso), value: byDate.get(iso) || 0 });
    }
    return out;
  }, [sheets.daily, sheets.monthly, trendMode, dateRange]);

  const toolData = useMemo(() => {
    const rows = (sheets.tools || [])
      .map((t) => ({
        name: t.tool,
        value: Number(toolMode === 'outputs' ? t.generations : t.totalSpendRupees) || 0,
      }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
    const top = rows.slice(0, 5);
    const rest = rows.slice(5).reduce((s, r) => s + r.value, 0);
    if (rest > 0) top.push({ name: 'Others', value: rest });
    const total = top.reduce((s, r) => s + r.value, 0) || 1;
    return top.map((r, i) => ({ ...r, pct: (r.value / total) * 100, color: CHART_PALETTE[i % CHART_PALETTE.length] }));
  }, [sheets.tools, toolMode]);

  const toolTotal = toolData.reduce((s, r) => s + r.value, 0);

  const deptData = useMemo(
    () =>
      (sheets.departments || [])
        .map((d) => ({
          name: d.department,
          value: Number(deptMode === 'spend' ? d.spendRupees : d.generations) || 0,
        }))
        .filter((d) => d.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .map((d, i) => ({ ...d, color: CHART_PALETTE[i % CHART_PALETTE.length] })),
    [sheets.departments, deptMode]
  );

  /* actions */
  const resetFilters = () => {
    pickPreset('30d');
    setTool('all');
    setDepartment('all');
    setUserId('all');
    setSearch('');
  };

  const downloadWorkbook = async (version = 'full') => {
    setExportOpen(false);
    if (busy) return;
    setBusy(true);
    try {
      const res = await creditReportAPI.exportXlsx({
        start: params.start,
        end: params.end,
        department: params.department,
        user: params.user,
        tool: params.tool === 'ChatGPT' ? undefined : params.tool,
        version,
        format: 'xlsx',
      });
      const stem = version === 'management' ? 'RMW-Management-Summary' : 'RMW-AI-Spend';
      downloadBlobResponse(res, `${stem}_${params.start}_to_${params.end}.xlsx`);
      notify('Excel downloaded.');
    } catch {
      notify('Could not export the workbook.');
    } finally {
      setBusy(false);
    }
  };

  const downloadCsv = () => {
    setExportOpen(false);
    const rows = sheets[sheet] || [];
    if (!rows.length) {
      notify('Nothing to export in this tab.');
      return;
    }
    const headers = Object.keys(rows[0]).filter((k) => rows[0][k] === null || typeof rows[0][k] !== 'object');
    const lines = [
      headers.join(','),
      ...rows.map((r) => headers.map((h) => `"${r[h] == null ? '' : String(r[h]).replace(/"/g, '""')}"`).join(',')),
    ];
    const blob = new Blob(['\uFEFF' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RMW_${sheet}_${params.start}_to_${params.end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const openOutput = async (ref) => {
    if (!ref) return;
    const [toolName, recId] = ref.split(':');
    try {
      const res = await creditReportAPI.outputUrl(toolName, recId);
      if (res?.url) window.open(res.url, '_blank', 'noopener,noreferrer');
    } catch {
      notify('Output link unavailable.');
    }
  };

  const seedDemo = async () => {
    setBusy(true);
    try {
      const res = await creditReportAPI.seedDemo();
      notify(res.message || 'Sample data loaded.');
      queryClient.invalidateQueries({ queryKey: ['credit-report'] });
    } catch (err) {
      notify(err?.response?.data?.detail || 'Could not load sample data.');
    } finally {
      setBusy(false);
    }
  };

  const drill = (next) => {
    if (next.user !== undefined) setUserId(String(next.user));
    if (next.tool !== undefined) setTool(next.tool);
    if (next.department !== undefined) setDepartment(next.department);
    if (next.date) {
      setPreset('custom');
      setDateRange({ start: next.date, end: next.date });
    }
    setSheet('log');
  };

  const toggleCol = (key) =>
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const visibleLogCols = LOG_COLUMNS.filter((c) => !hiddenCols.has(c.key));
  const show = (key) => !hiddenCols.has(key);

  const counts = {
    log: sheets.log?.length,
    users: sheets.users?.length,
    tools: sheets.tools?.length,
    daily: sheets.daily?.length,
    monthly: sheets.monthly?.length,
    departments: sheets.departments?.length,
  };

  const empty = (cols) => (
    <tr>
      <td colSpan={cols} className="zrs-empty">
        No data for this selection.
      </td>
    </tr>
  );

  const changeText = kpis.spendChangeText;
  const changeUp = changeText && !String(changeText).trim().startsWith('▼') && !String(changeText).includes('-');

  return (
    <div className="zrs">
      {/* ── Top bar ── */}
      <header className="zrs-top">
        <div className="zrs-title">
          <span className="zrs-title-icon">
            <Icon d={ICONS.bars} size={22} />
          </span>
          <div>
            <h3>Usage &amp; Spend</h3>
            <p>Who generated what, with which tool, and what it cost</p>
          </div>
        </div>

        <div className="zrs-top-actions">
          {preset === 'custom' ? (
            <div className="zrs-date-edit">
              <Icon d={ICONS.calendar} size={15} />
              <input
                type="date"
                value={dateRange.start}
                max={dateRange.end}
                onChange={(e) => setDateRange((d) => ({ ...d, start: e.target.value }))}
              />
              <span>–</span>
              <input
                type="date"
                value={dateRange.end}
                min={dateRange.start}
                onChange={(e) => setDateRange((d) => ({ ...d, end: e.target.value }))}
              />
            </div>
          ) : (
            <span className="zrs-date-chip">
              <Icon d={ICONS.calendar} size={15} />
              {period.label || `${dateRange.start} – ${dateRange.end}`}
            </span>
          )}
          <button
            type="button"
            className={`zrs-btn ${preset === 'custom' ? 'primary' : ''}`}
            onClick={() => pickPreset(preset === 'custom' ? '30d' : 'custom')}
          >
            Custom
          </button>
          <button
            type="button"
            className="zrs-icon-btn"
            onClick={() => query.refetch()}
            title="Refresh"
            aria-label="Refresh"
          >
            <span className={query.isFetching ? 'spin' : ''}>
              <Icon d={ICONS.refresh} />
            </span>
          </button>
          <div className="zrs-menu-wrap" ref={exportRef}>
            <button type="button" className="zrs-btn" onClick={() => setExportOpen((v) => !v)} disabled={busy}>
              <Icon d={ICONS.download} size={15} />
              {busy ? 'Preparing…' : 'Export'}
              <span className="zrs-caret" />
            </button>
            {exportOpen && (
              <div className="zrs-menu" role="menu">
                <button type="button" onClick={() => downloadWorkbook('full')}>
                  Full Excel workbook (.xlsx)
                </button>
                <button type="button" onClick={() => downloadWorkbook('management')}>
                  Management summary (.xlsx)
                </button>
                <button type="button" onClick={downloadCsv}>
                  Current tab as CSV
                </button>
              </div>
            )}
          </div>
          {onSwitchToAdvanced && (
            <button type="button" className="zrs-icon-btn" onClick={onSwitchToAdvanced} title="Deep analytics">
              <Icon d={ICONS.chart} />
            </button>
          )}
        </div>
      </header>

      {/* ── KPIs ── */}
      <section className="zrs-kpis">
        <Kpi
          tone="green"
          icon={ICONS.rupee}
          label="Total spent"
          value={fmtINR(kpis.totalSpendRupees)}
          loading={loading}
          hint="Pay-per-use usage cost plus subscription plan fees for the selected period."
          foot={
            <>
              {changeText ? (
                <em className={changeUp ? 'up' : 'down'}>{changeText} vs previous period</em>
              ) : null}
              <span>
                Usage {fmtINR(kpis.payPerUseRupees)} · Plans {fmtINR(kpis.subscriptionRupees)}
              </span>
            </>
          }
        />
        <Kpi
          tone="violet"
          icon={ICONS.bars}
          label="Average spend"
          value={fmtINR(avgs.spendPerDay)}
          unit=" / day"
          loading={loading}
          hint="Total spend divided by calendar days in the period."
          foot={`${fmtINR(avgs.spendPerMonth)} / month · ${period.days || 0} days`}
        />
        <Kpi
          tone="amber"
          icon={ICONS.doc}
          label="Outputs generated"
          value={fmtNum(kpis.totalGenerations)}
          loading={loading}
          hint="Every image, video, audio, chat or asset generated through the AI tools."
          foot={`${fmtNum(avgs.generationsPerDay)} / day · ${fmtINR(avgs.spendPerOutput)} each`}
        />
        <Kpi
          tone="pink"
          icon={ICONS.people}
          label="People & tools"
          value={
            <>
              {fmtNum(kpis.activeUsers)}
              <small> people · </small>
              {fmtNum(kpis.activeTools)}
              <small> tools</small>
            </>
          }
          loading={loading}
          hint="People and AI tools with at least one generation in the period."
          foot={`${fmtINR(avgs.spendPerUser)} per person (avg)`}
        />
      </section>

      {/* ── Filters ── */}
      <section className="zrs-filters">
        <label className="zrs-field">
          <span>Time range</span>
          <select value={preset} onChange={(e) => pickPreset(e.target.value)}>
            {DATE_PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label className="zrs-field">
          <span>Tool</span>
          <select value={tool} onChange={(e) => setTool(e.target.value)}>
            <option value="all">All tools</option>
            {(options.tools || []).map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="zrs-field">
          <span>Department</span>
          <select
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value);
              setUserId('all');
            }}
          >
            <option value="all">All departments</option>
            {(options.departments || []).map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </label>
        <label className="zrs-field">
          <span>Person</span>
          <select value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="all">Everyone</option>
            {userOptions.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </label>
        <label className="zrs-search">
          <Icon d={ICONS.search} size={16} />
          <input
            type="text"
            placeholder="Search people, tools, prompts, outputs…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && refreshing && <span className="zrs-spinner" aria-label="Searching" />}
          {search && !refreshing && (
            <button type="button" className="zrs-search-clear" onClick={() => setSearch('')} aria-label="Clear search">
              ×
            </button>
          )}
        </label>
        <button type="button" className="zrs-reset" onClick={resetFilters}>
          Reset
        </button>
      </section>

      {/* ── Charts ── */}
      <section className="zrs-charts">
        <article className="zrs-card">
          <header className="zrs-card-head">
            <div>
              <h4>Spend trend</h4>
              <div className="zrs-card-value">
                {fmtINR(kpis.totalSpendRupees)}
                {changeText ? <em className={changeUp ? 'up' : 'down'}>{changeText}</em> : null}
              </div>
            </div>
            <select className="zrs-mini-select" value={trendMode} onChange={(e) => setTrendMode(e.target.value)}>
              <option value="daily">Daily</option>
              <option value="monthly">Monthly</option>
            </select>
          </header>
          <div className="zrs-chart">
            {trendData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendData} margin={{ top: 8, right: 6, left: -12, bottom: 0 }}>
                  <defs>
                    <linearGradient id="zrsTrendFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.45} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis
                    tickFormatter={fmtCompactINR}
                    tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={52}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--color-border-strong)' }} />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#10b981"
                    strokeWidth={2}
                    fill="url(#zrsTrendFill)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="zrs-chart-empty">No spend in this period</div>
            )}
          </div>
        </article>

        <article className="zrs-card">
          <header className="zrs-card-head">
            <h4>Usage by tool</h4>
            <select className="zrs-mini-select" value={toolMode} onChange={(e) => setToolMode(e.target.value)}>
              <option value="outputs">By outputs</option>
              <option value="spend">By spend</option>
            </select>
          </header>
          <div className="zrs-donut-wrap">
            <div className="zrs-donut">
              {toolData.length ? (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={toolData}
                      dataKey="value"
                      nameKey="name"
                      innerRadius="62%"
                      outerRadius="95%"
                      paddingAngle={2}
                      stroke="none"
                      isAnimationActive={false}
                    >
                      {toolData.map((d) => (
                        <Cell key={d.name} fill={d.color} />
                      ))}
                    </Pie>
                    <Tooltip content={<ChartTooltip money={toolMode === 'spend'} />} />
                  </PieChart>
                </ResponsiveContainer>
              ) : (
                <div className="zrs-chart-empty">No usage</div>
              )}
              {toolData.length > 0 && (
                <div className="zrs-donut-center">
                  <b>{toolMode === 'spend' ? fmtCompactINR(toolTotal) : fmtNum(toolTotal)}</b>
                  <span>{toolMode === 'spend' ? 'spent' : 'outputs'}</span>
                </div>
              )}
            </div>
            <ul className="zrs-legend">
              {toolData.map((d) => (
                <li key={d.name}>
                  <i style={{ background: d.color }} />
                  {d.name !== 'Others' ? <ToolLogo name={d.name} size={14} /> : null}
                  <span className="zrs-legend-name">{d.name}</span>
                  <span className="zrs-legend-pct">{Math.round(d.pct)}%</span>
                  <span className="zrs-legend-val">
                    {toolMode === 'spend' ? fmtCompactINR(d.value) : fmtNum(d.value)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="zrs-card">
          <header className="zrs-card-head">
            <div>
              <h4>Department-wise {deptMode === 'spend' ? 'spend' : 'outputs'}</h4>
              <div className="zrs-card-value">
                {deptMode === 'spend' ? fmtINR(kpis.itemSpendRupees) : fmtNum(kpis.totalGenerations)}
              </div>
            </div>
            <select className="zrs-mini-select" value={deptMode} onChange={(e) => setDeptMode(e.target.value)}>
              <option value="spend">By spend</option>
              <option value="outputs">By outputs</option>
            </select>
          </header>
          <div className="zrs-chart">
            {deptData.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={deptData} margin={{ top: 22, right: 4, left: 4, bottom: 0 }}>
                  <XAxis
                    dataKey="name"
                    tick={{ fill: 'var(--color-text-muted)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    interval={0}
                    tickFormatter={(v) => (String(v).length > 11 ? `${String(v).slice(0, 10)}…` : v)}
                  />
                  <Tooltip
                    content={<ChartTooltip money={deptMode === 'spend'} />}
                    cursor={{ fill: 'var(--color-hover-surface)' }}
                  />
                  <Bar dataKey="value" radius={[6, 6, 0, 0]} maxBarSize={48} isAnimationActive={false}>
                    {deptData.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                    <LabelList
                      dataKey="value"
                      position="top"
                      formatter={(v) => (deptMode === 'spend' ? fmtCompactINR(v) : fmtNum(v))}
                      style={{ fill: 'var(--color-text-secondary)', fontSize: 11 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="zrs-chart-empty">No department data</div>
            )}
          </div>
        </article>
      </section>

      {/* ── Table ── */}
      <section className="zrs-sheet">
        <div className="zrs-sheet-head">
          <nav className="zrs-tabs" role="tablist">
            {SHEETS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={sheet === s.key}
                className={sheet === s.key ? 'on' : ''}
                onClick={() => setSheet(s.key)}
              >
                <Icon d={s.icon} size={15} />
                {s.label}
                {counts[s.key] != null && <span>{counts[s.key]}</span>}
              </button>
            ))}
          </nav>
          {sheet === 'log' && (
            <div className="zrs-menu-wrap" ref={colsRef}>
              <button type="button" className="zrs-btn" onClick={() => setColsOpen((v) => !v)}>
                <Icon d={ICONS.columns} size={15} />
                Columns
                <span className="zrs-caret" />
              </button>
              {colsOpen && (
                <div className="zrs-menu right" role="menu">
                  {LOG_COLUMNS.map((c) => (
                    <label key={c.key} className="zrs-check">
                      <input type="checkbox" checked={show(c.key)} onChange={() => toggleCol(c.key)} />
                      {c.label}
                    </label>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="zrs-table-wrap">
          {loading ? (
            <div className="zrs-loading" role="status" aria-live="polite">
              <div className="zrs-loading-bar" />
              <div className="zrs-loading-label">
                <span className="zrs-spinner" />
                {search.trim() ? (
                  <>
                    Searching for <b>“{search.trim()}”</b>…
                  </>
                ) : query.isLoading ? (
                  'Loading report…'
                ) : (
                  'Updating report…'
                )}
              </div>
              <table className="zrs-table">
                <SkeletonRows cols={SHEET_COLS[sheet] || 8} />
              </table>
            </div>
          ) : (
            <>
              {sheet === 'log' && (
                <table className="zrs-table">
                  <thead>
                    <tr>
                      {visibleLogCols.map((c) => (
                        <th key={c.key} className={c.num ? 'num' : ''}>
                          {c.label}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {(sheets.log || []).length === 0 ? (
                      <tr>
                        <td colSpan={visibleLogCols.length} className="zrs-empty">
                          No generations for this selection.
                          {import.meta.env.DEV && (
                            <button type="button" className="zrs-link" onClick={seedDemo} disabled={busy}>
                              Load sample data (local only)
                            </button>
                          )}
                        </td>
                      </tr>
                    ) : (
                      sheets.log.map((r) => (
                        <tr key={`${r.tool}-${r.recordId}-${r.rowNum}`}>
                          {show('when') && (
                            <td className="nowrap">
                              {r.date}
                              <span className="sub">{r.time}</span>
                            </td>
                          )}
                          {show('person') && (
                            <td>
                              <div className="zrs-person">
                                <Avatar name={r.userName} />
                                <button type="button" className="zrs-cell-btn" onClick={() => drill({ user: r.userId })}>
                                  {r.userName}
                                </button>
                              </div>
                            </td>
                          )}
                          {show('tool') && (
                            <td>
                              <ToolTag name={r.tool} onClick={() => drill({ tool: r.tool })} />
                            </td>
                          )}
                          {show('output') && (
                            <td className="zrs-out">
                              {r.outputType}
                              <span className="sub">{r.whatGenerated}</span>
                            </td>
                          )}
                          {show('prompt') && (
                            <td className="zrs-prompt" title={r.prompt}>
                              {r.prompt}
                            </td>
                          )}
                          {show('client') && <td className="nowrap">{r.client}</td>}
                          {show('department') && (
                            <td>
                              <DeptPill name={r.department} />
                            </td>
                          )}
                          {show('credits') && <td className="num">{fmtNum(r.credits)}</td>}
                          {show('cost') && <td className="num money">{fmtINR(r.spendRupees)}</td>}
                          {show('actions') && (
                            <td>
                              {r.hasOutput && r.outputRef ? (
                                <button type="button" className="zrs-open" onClick={() => openOutput(r.outputRef)}>
                                  Open
                                </button>
                              ) : (
                                <span className="zrs-muted">—</span>
                              )}
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              )}

              {sheet === 'users' && (
                <table className="zrs-table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Department</th>
                      <th>Tools used</th>
                      <th className="num">Outputs</th>
                      <th className="num">Active days</th>
                      <th className="num">Credits</th>
                      <th className="num">Spent</th>
                      <th className="num">Per output</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(sheets.users || []).length === 0
                      ? empty(9)
                      : sheets.users.map((u) => (
                          <tr key={u.userId ?? u.userName}>
                            <td>
                              <div className="zrs-person">
                                <Avatar name={u.userName} />
                                <button type="button" className="zrs-cell-btn" onClick={() => drill({ user: u.userId })}>
                                  {u.userName}
                                </button>
                              </div>
                            </td>
                            <td>
                              <DeptPill name={u.department} />
                            </td>
                            <td className="zrs-wrap">{u.toolsUsedText}</td>
                            <td className="num">{fmtNum(u.generations)}</td>
                            <td className="num">{u.activeDays}</td>
                            <td className="num">{fmtNum(u.credits)}</td>
                            <td className="num money">{fmtINR(u.spendRupees)}</td>
                            <td className="num">{fmtINR(u.avgSpendPerOutput)}</td>
                            <td>
                              <ShareBar pct={u.sharePct} />
                            </td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              )}

              {sheet === 'tools' && (
                <table className="zrs-table">
                  <thead>
                    <tr>
                      <th>Tool</th>
                      <th>Category</th>
                      <th className="num">People</th>
                      <th>Top user</th>
                      <th className="num">Outputs</th>
                      <th className="num">Usage</th>
                      <th className="num">Plan fee</th>
                      <th className="num">Total</th>
                      <th className="num">Per output</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(sheets.tools || []).length === 0
                      ? empty(10)
                      : sheets.tools.map((t) => (
                          <tr key={t.tool}>
                            <td>
                              <ToolTag name={t.tool} onClick={() => drill({ tool: t.tool })} />
                            </td>
                            <td className="zrs-muted">{t.outputCategory}</td>
                            <td className="num">{t.users}</td>
                            <td className="nowrap">{t.topUser}</td>
                            <td className="num">{fmtNum(t.generations)}</td>
                            <td className="num">{fmtINR(t.itemSpendRupees)}</td>
                            <td className="num">{fmtINR(t.subscriptionFeeRupees)}</td>
                            <td className="num money">{fmtINR(t.totalSpendRupees)}</td>
                            <td className="num">{fmtINR(t.avgSpendPerOutput)}</td>
                            <td>
                              <ShareBar pct={t.sharePct} />
                            </td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              )}

              {sheet === 'daily' && (
                <table className="zrs-table">
                  <thead>
                    <tr>
                      <th>Date</th>
                      <th className="num">People</th>
                      <th className="num">Outputs</th>
                      <th>Top tool</th>
                      <th className="num">Credits</th>
                      <th className="num">Spent</th>
                      <th className="num">Per output</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(sheets.daily || []).length === 0
                      ? empty(7)
                      : sheets.daily.map((d) => (
                          <tr key={d.date}>
                            <td>
                              <button type="button" className="zrs-cell-btn" onClick={() => drill({ date: d.date })}>
                                {d.date}
                              </button>
                            </td>
                            <td className="num">{d.activeUsers}</td>
                            <td className="num">{fmtNum(d.generations)}</td>
                            <td>{d.topTool ? <ToolTag name={d.topTool} /> : '—'}</td>
                            <td className="num">{fmtNum(d.credits)}</td>
                            <td className="num money">{fmtINR(d.spendRupees)}</td>
                            <td className="num">{fmtINR(d.avgSpendPerOutput)}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              )}

              {sheet === 'monthly' && (
                <table className="zrs-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th className="num">Active days</th>
                      <th className="num">People</th>
                      <th className="num">Outputs</th>
                      <th>Top tool</th>
                      <th className="num">Credits</th>
                      <th className="num">Spent</th>
                      <th className="num">Per active day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(sheets.monthly || []).length === 0
                      ? empty(8)
                      : sheets.monthly.map((m) => (
                          <tr key={m.month}>
                            <td>{m.monthLabel}</td>
                            <td className="num">{m.activeDays}</td>
                            <td className="num">{m.activeUsers}</td>
                            <td className="num">{fmtNum(m.generations)}</td>
                            <td>{m.topTool ? <ToolTag name={m.topTool} /> : '—'}</td>
                            <td className="num">{fmtNum(m.credits)}</td>
                            <td className="num money">{fmtINR(m.spendRupees)}</td>
                            <td className="num">{fmtINR(m.avgSpendPerActiveDay)}</td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              )}

              {sheet === 'departments' && (
                <table className="zrs-table">
                  <thead>
                    <tr>
                      <th>Department</th>
                      <th className="num">People</th>
                      <th>Top user</th>
                      <th>Top tool</th>
                      <th className="num">Outputs</th>
                      <th className="num">Spent</th>
                      <th className="num">Per person</th>
                      <th>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(sheets.departments || []).length === 0
                      ? empty(8)
                      : sheets.departments.map((d) => (
                          <tr key={d.department}>
                            <td>
                              <button
                                type="button"
                                className="zrs-cell-btn"
                                onClick={() => drill({ department: d.department })}
                              >
                                <DeptPill name={d.department} />
                              </button>
                            </td>
                            <td className="num">{d.users}</td>
                            <td className="nowrap">{d.topUser}</td>
                            <td>{d.topTool ? <ToolTag name={d.topTool} /> : '—'}</td>
                            <td className="num">{fmtNum(d.generations)}</td>
                            <td className="num money">{fmtINR(d.spendRupees)}</td>
                            <td className="num">{fmtINR(d.avgSpendPerUser)}</td>
                            <td>
                              <ShareBar pct={d.sharePct} />
                            </td>
                          </tr>
                        ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      </section>

      {toast && <div className="zrs-toast">{toast}</div>}
    </div>
  );
}
