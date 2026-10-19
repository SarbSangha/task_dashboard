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
import ToolLogo from '../common/ToolLogo';
import DateRangePicker from './DateRangePicker';
import { computePresetDates, toIso } from './dateRanges';
import Dropdown from './usageSpend/Dropdown';
import ComparePanel, { COMPARE_MODES } from './usageSpend/ComparePanel';
import ChatTranscriptModal from './usageSpend/ChatTranscriptModal';
import OutputPreviewModal from './usageSpend/OutputPreviewModal';
import PeopleReportModal from './usageSpend/PeopleReportModal';
import { buildColumns, ROW_KEYS } from './usageSpend/sheetColumns';
import {
  Avatar,
  CHART_PALETTE,
  CHAT_TOOLS,
  ChartSkeleton,
  ChartTooltip,
  Icon,
  ICONS,
  Skel,
  SkeletonRows,
  SortTh,
  fmtCompactINR,
  fmtINR,
  fmtNum,
  shortDate,
  sortOptions,
  sortRows,
  useOutsideClose,
} from './usageSpend/shared';
import './ZomatoExcelReportStudio.css';
import './usageSpend/usageSpend.css';

const SHEETS = [
  { key: 'log', label: 'Activity', icon: 'M12 2a10 10 0 100 20 10 10 0 000-20zm1 5v5.4l3.7 2.2-.8 1.3L11 13V7h2z' },
  { key: 'users', label: 'People', icon: ICONS.person },
  { key: 'tools', label: 'Tools', icon: 'M4 6h16v2H4V6zm0 5h16v2H4v-2zm0 5h16v2H4v-2z' },
  { key: 'clients', label: 'Clients', icon: ICONS.briefcase },
  { key: 'daily', label: 'Daily', icon: ICONS.calendar },
  { key: 'monthly', label: 'Monthly', icon: ICONS.bars },
  { key: 'departments', label: 'Departments', icon: 'M3 21V7l6-4 6 4v2h6v12H3zm2-2h4v-3H5v3zm0-5h4v-3H5v3zm6 5h4v-3h-4v3zm0-5h4v-3h-4v3zm6 5h2v-8h-2v8z' },
  { key: 'compare', label: 'Compare', icon: ICONS.compare },
];

const TREND_MODES = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
];
const TOOL_MODES = [
  { value: 'outputs', label: 'By outputs' },
  { value: 'spend', label: 'By spend' },
  { value: 'credits', label: 'By credits' },
];
const DEPT_MODES = [
  { value: 'spend', label: 'By spend' },
  { value: 'outputs', label: 'By outputs' },
  { value: 'credits', label: 'By credits' },
];

const DEFAULT_COMPARE = {
  mode: 'tools',
  tools: [],
  people: [],
  metric: 'generations',
  entitySort: 'desc',
  dimension: 'tools',
  rankSort: 'desc',
  topN: 10,
};

const Kpi = ({ tone, icon, label, value, unit, foot, hint, loading, onClick, action }) => {
  const clickable = Boolean(onClick);
  return (
    <article
      className={`zrs-kpi tone-${tone}${loading ? ' is-loading' : ''}${clickable ? ' is-clickable' : ''}`}
      onClick={onClick}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick()) : undefined}
    >
      <span className="zrs-kpi-icon">
        <Icon d={icon} size={22} />
      </span>
      <div className="zrs-kpi-body">
        <span className="zrs-kpi-label">{label}</span>
        <strong>
          {value}
          {unit ? <small>{unit}</small> : null}
        </strong>
        {loading ? (
          <span className="zrs-kpi-foot">
            <Skel w="85%" h={9} />
            <Skel w="60%" h={9} />
          </span>
        ) : (
          <span className="zrs-kpi-foot">{foot}</span>
        )}
        {clickable && !loading && <span className="zrs-kpi-action">{action} →</span>}
      </div>
      <span className="zrs-kpi-info" title={hint}>
        <Icon d={ICONS.info} size={15} />
      </span>
    </article>
  );
};

const AUTO_REFRESH_MS = 2 * 60 * 1000;

// "just now" / "3m ago" for the last successful load, re-rendered every 15s.
function useUpdatedAgo(timestamp) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  if (!timestamp) return '';
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`;
}

/* ---------- main ---------- */

export default function ZomatoExcelReportStudio({ onSwitchToAdvanced }) {
  const queryClient = useQueryClient();
  const sheetRef = useRef(null);

  const [preset, setPreset] = useState('30d');
  const [dateRange, setDateRange] = useState(() => computePresetDates('30d'));
  const [tool, setTool] = useState('all');
  const [department, setDepartment] = useState('all');
  const [userId, setUserId] = useState('all');
  const [client, setClient] = useState('all');
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [sheet, setSheet] = useState('log');
  const [sorts, setSorts] = useState({});
  const [trendMode, setTrendMode] = useState('daily');
  const [toolMode, setToolMode] = useState('outputs');
  const [deptMode, setDeptMode] = useState('spend');
  const [hiddenCols, setHiddenCols] = useState(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [colsOpen, setColsOpen] = useState(false);
  const [peopleOpen, setPeopleOpen] = useState(false);
  const [preview, setPreview] = useState(null);
  const [chat, setChat] = useState(null);
  const [compare, setCompare] = useState(DEFAULT_COMPARE);
  const [manualRefresh, setManualRefresh] = useState(false);
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

  const changeRange = (range, key) => {
    setPreset(key);
    setDateRange(range);
  };

  const params = useMemo(() => {
    const p = { start: dateRange.start, end: dateRange.end };
    if (department !== 'all') p.department = department;
    if (userId !== 'all') p.user = userId;
    if (tool !== 'all') p.tool = tool;
    if (client !== 'all') p.client = client;
    if (debouncedSearch) p.search = debouncedSearch;
    return p;
  }, [dateRange, department, userId, tool, client, debouncedSearch]);

  const query = useQuery({
    queryKey: ['credit-report', 'live-sheet', params],
    queryFn: () => creditReportAPI.liveSheet(params),
    staleTime: 30_000,
    placeholderData: (prev) => prev,
    // Live: re-read the backend every 2 minutes while this tab is visible
    // (paused in the background), and again whenever the window regains focus.
    refetchInterval: AUTO_REFRESH_MS,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
  const updatedAgo = useUpdatedAgo(query.dataUpdatedAt);

  const typing = search.trim() !== debouncedSearch;
  // Skeletons whenever what's on screen doesn't match the selection yet:
  // first load, a filter change (old data shown as placeholder), typing in
  // search, or a manual refresh. The silent 2-minute auto refresh keeps the
  // current numbers on screen and only flips the "Updating…" pill.
  const loading =
    query.isLoading || typing || (query.isFetching && (query.isPlaceholderData || manualRefresh));
  const refreshing = loading && !query.isLoading;

  const refreshNow = async () => {
    setManualRefresh(true);
    try {
      await query.refetch();
    } finally {
      setManualRefresh(false);
    }
  };

  const data = query.data;
  const kpis = data?.kpis || {};
  const avgs = kpis.averages || {};
  const period = data?.period || {};
  const options = data?.options || { departments: [], users: [], tools: [], clients: [] };
  const sheets = data?.sheets || {};

  /* dropdown options */
  const toolOptions = useMemo(
    () => [
      { value: 'all', label: 'All tools' },
      ...(options.tools || []).map((t) => ({ value: t, label: t, icon: <ToolLogo name={t} size={16} /> })),
    ],
    [options.tools]
  );
  const deptOptions = useMemo(
    () => [{ value: 'all', label: 'All departments' }, ...(options.departments || []).map((d) => ({ value: d, label: d }))],
    [options.departments]
  );
  const userOptions = useMemo(() => {
    const all = options.users || [];
    const list = department === 'all' ? all : all.filter((u) => u.department === department);
    return [
      { value: 'all', label: 'Everyone' },
      ...list.map((u) => ({
        value: String(u.id),
        label: u.name,
        hint: u.department,
        icon: <Avatar name={u.name} size={20} />,
      })),
    ];
  }, [options.users, department]);
  const clientOptions = useMemo(() => {
    const spendByClient = new Map((sheets.clients || []).map((c) => [c.client, c.generations]));
    return [
      { value: 'all', label: 'All clients' },
      ...(options.clients || []).map((c) => ({
        value: c,
        label: c,
        meta: spendByClient.has(c) ? fmtNum(spendByClient.get(c)) : undefined,
      })),
    ];
  }, [options.clients, sheets.clients]);

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

  const toolField = { outputs: 'generations', spend: 'totalSpendRupees', credits: 'credits' }[toolMode];
  const toolData = useMemo(() => {
    const rows = (sheets.tools || [])
      .map((t) => ({ name: t.tool, value: Number(t[toolField]) || 0 }))
      .filter((r) => r.value > 0)
      .sort((a, b) => b.value - a.value);
    const top = rows.slice(0, 5);
    const rest = rows.slice(5).reduce((s, r) => s + r.value, 0);
    if (rest > 0) top.push({ name: 'Others', value: rest });
    const total = top.reduce((s, r) => s + r.value, 0) || 1;
    return top.map((r, i) => ({ ...r, pct: (r.value / total) * 100, color: CHART_PALETTE[i % CHART_PALETTE.length] }));
  }, [sheets.tools, toolField]);

  const toolTotal = toolData.reduce((s, r) => s + r.value, 0);

  const deptField = { spend: 'spendRupees', outputs: 'generations', credits: 'credits' }[deptMode];
  const deptData = useMemo(
    () =>
      (sheets.departments || [])
        .map((d) => ({ name: d.department, value: Number(d[deptField]) || 0 }))
        .filter((d) => d.value > 0)
        .sort((a, b) => b.value - a.value)
        .slice(0, 6)
        .map((d, i) => ({ ...d, color: CHART_PALETTE[i % CHART_PALETTE.length] })),
    [sheets.departments, deptField]
  );
  const deptTotal = deptMode === 'spend' ? kpis.itemSpendRupees : deptMode === 'credits' ? kpis.totalCredits : kpis.totalGenerations;
  const fmtDept = (v) => (deptMode === 'spend' ? fmtCompactINR(v) : fmtNum(v));

  /* actions */
  const resetFilters = () => {
    setPreset('30d');
    setDateRange(computePresetDates('30d'));
    setTool('all');
    setDepartment('all');
    setUserId('all');
    setClient('all');
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
        client: params.client,
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
      ...sortedRows.map((r) => headers.map((h) => `"${r[h] == null ? '' : String(r[h]).replace(/"/g, '""')}"`).join(',')),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RMW_${sheet}_${params.start}_to_${params.end}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Link button: a chat opens its transcript, anything else plays here.
  const openLink = (row) => (CHAT_TOOLS.has(row.tool) ? setChat(row) : setPreview(row));

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

  const scrollToSheet = () =>
    setTimeout(() => sheetRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);

  const drill = (next) => {
    if (next.user !== undefined) setUserId(String(next.user));
    if (next.tool !== undefined) setTool(next.tool);
    if (next.department !== undefined) setDepartment(next.department);
    if (next.client !== undefined) setClient(next.client);
    if (next.date) {
      setPreset('custom');
      setDateRange({ start: next.date, end: next.date });
    }
    setPeopleOpen(false);
    setSheet('log');
    scrollToSheet();
  };

  const openCompare = (mode, patch = {}) => {
    setCompare((s) => ({ ...s, mode, ...patch }));
    setPeopleOpen(false);
    setSheet('compare');
    scrollToSheet();
  };

  const toggleCol = (key) =>
    setHiddenCols((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /* tables */
  const columns = useMemo(() => buildColumns({ drill, openOutput: openLink }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const isTable = sheet !== 'compare';
  const sheetCols = isTable ? columns[sheet].filter((c) => sheet !== 'log' || !hiddenCols.has(c.key)) : [];
  const sort = sorts[sheet] || null;
  const setSort = (next) => setSorts((s) => ({ ...s, [sheet]: next }));
  const sortedRows = useMemo(
    () => (isTable ? sortRows(sheets[sheet] || [], columns[sheet], sort) : []),
    [isTable, sheets, sheet, columns, sort]
  );
  const sortChoices = useMemo(() => (isTable ? sortOptions(columns[sheet]) : []), [isTable, columns, sheet]);
  // What ← / → steps through in the player: playable outputs, in the order the Activity tab shows them.
  const previewRows = useMemo(
    () =>
      (sheet === 'log' ? sortedRows : sheets.log || []).filter(
        (r) => r.hasOutput && r.outputRef && !CHAT_TOOLS.has(r.tool)
      ),
    [sheet, sortedRows, sheets.log]
  );

  const counts = {
    log: sheets.log?.length,
    users: sheets.users?.length,
    tools: sheets.tools?.length,
    clients: sheets.clients?.length,
    daily: sheets.daily?.length,
    monthly: sheets.monthly?.length,
    departments: sheets.departments?.length,
  };

  const changeText = kpis.spendChangeText;
  const changeUp = changeText && !String(changeText).trim().startsWith('▼') && !String(changeText).includes('-');

  const activeFilters = [tool, department, userId, client].filter((v) => v !== 'all').length + (search ? 1 : 0);

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
            <p>Who generated what, with which tool, for which client, and what it cost</p>
          </div>
        </div>

        <div className="zrs-top-actions">
          <DateRangePicker start={dateRange.start} end={dateRange.end} presetKey={preset} onChange={changeRange} />
          <span
            className={`zrs-live ${query.isError ? 'error' : ''}`}
            title={query.dataUpdatedAt ? `Last updated ${new Date(query.dataUpdatedAt).toLocaleTimeString('en-IN')} · refreshes every 2 minutes` : 'Loading…'}
          >
            <span className="zrs-live-dot" />
            {query.isError ? 'Update failed' : query.isFetching ? 'Updating…' : updatedAgo ? `Live · ${updatedAgo}` : 'Live'}
          </span>
          <button type="button" className="zrs-icon-btn" onClick={refreshNow} title="Refresh" aria-label="Refresh">
            <span className={query.isFetching ? 'spin' : ''}>
              <Icon d={ICONS.refresh} />
            </span>
          </button>
          <Dropdown
            value={null}
            options={COMPARE_MODES.map((m) => ({ ...m, icon: <Icon d={m.iconD} size={16} /> }))}
            onChange={(m) => openCompare(m)}
            label="Compare"
            align="right"
            menuWidth={300}
            trigger={
              <>
                <Icon d={ICONS.compare} size={15} />
                Compare
              </>
            }
          />
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
                <button type="button" onClick={downloadCsv} disabled={!isTable}>
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
          foot={`${fmtNum(avgs.generationsPerDay)} / day · ${fmtINR(avgs.spendPerOutput)} each · ${fmtNum(kpis.totalCredits)} credits`}
          onClick={() => openCompare('generations')}
          action="Compare generations"
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
          hint="People and AI tools with at least one generation in the period. Click for the full people report."
          foot={`${fmtINR(avgs.spendPerUser)} per person (avg)`}
          onClick={() => setPeopleOpen(true)}
          action="Open people report"
        />
      </section>

      {/* ── Filters ── */}
      <section className="zrs-filters">
        <div className="zrs-field">
          <span>Tool</span>
          <Dropdown value={tool} options={toolOptions} onChange={setTool} label="Tool" searchable />
        </div>
        <div className="zrs-field">
          <span>Department</span>
          <Dropdown
            value={department}
            options={deptOptions}
            onChange={(v) => {
              setDepartment(v);
              setUserId('all');
            }}
            label="Department"
          />
        </div>
        <div className="zrs-field">
          <span>Person</span>
          <Dropdown value={String(userId)} options={userOptions} onChange={setUserId} label="Person" searchable menuWidth={260} />
        </div>
        <div className="zrs-field">
          <span>Client / Project</span>
          <Dropdown value={client} options={clientOptions} onChange={setClient} label="Client" searchable menuWidth={260} />
        </div>
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
          Reset{activeFilters ? ` (${activeFilters})` : ''}
        </button>
      </section>

      {/* ── Charts ── */}
      <section className="zrs-charts">
        <article className="zrs-card">
          <header className="zrs-card-head">
            <div>
              <h4>Spend trend</h4>
              <div className="zrs-card-value">
                {loading ? (
                  <Skel w={120} h={22} r={7} />
                ) : (
                  <>
                    {fmtINR(kpis.totalSpendRupees)}
                    {changeText ? <em className={changeUp ? 'up' : 'down'}>{changeText}</em> : null}
                  </>
                )}
              </div>
            </div>
            <Dropdown value={trendMode} options={TREND_MODES} onChange={setTrendMode} size="sm" align="right" label="Trend period" />
          </header>
          <div className="zrs-chart">
            {loading ? (
              <ChartSkeleton kind="area" />
            ) : trendData.length ? (
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
            <div className="zrs-card-tools">
              <button type="button" className="zrs-card-link" onClick={() => openCompare('tools')} title="Compare tools side by side">
                <Icon d={ICONS.compare} size={13} />
                Compare
              </button>
              <Dropdown value={toolMode} options={TOOL_MODES} onChange={setToolMode} size="sm" align="right" label="Measure" />
            </div>
          </header>
          {loading ? (
            <ChartSkeleton kind="donut" />
          ) : (
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
                    <span>{toolMode === 'spend' ? 'spent' : toolMode === 'credits' ? 'credits' : 'outputs'}</span>
                  </div>
                )}
              </div>
              <ul className="zrs-legend">
                {toolData.map((d) => (
                  <li key={d.name}>
                    <i style={{ background: d.color }} />
                    {d.name !== 'Others' ? <ToolLogo name={d.name} size={14} /> : null}
                    {d.name !== 'Others' ? (
                      <button type="button" className="zrs-legend-name zrs-cell-btn" onClick={() => drill({ tool: d.name })}>
                        {d.name}
                      </button>
                    ) : (
                      <span className="zrs-legend-name">{d.name}</span>
                    )}
                    <span className="zrs-legend-pct">{Math.round(d.pct)}%</span>
                    <span className="zrs-legend-val">
                      {toolMode === 'spend' ? fmtCompactINR(d.value) : fmtNum(d.value)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </article>

        <article className="zrs-card">
          <header className="zrs-card-head">
            <div>
              <h4>Department-wise {deptMode}</h4>
              <div className="zrs-card-value">
                {loading ? <Skel w={100} h={22} r={7} /> : deptMode === 'spend' ? fmtINR(deptTotal) : fmtNum(deptTotal)}
              </div>
            </div>
            <Dropdown value={deptMode} options={DEPT_MODES} onChange={setDeptMode} size="sm" align="right" label="Measure" />
          </header>
          <div className="zrs-chart">
            {loading ? (
              <ChartSkeleton kind="bars" />
            ) : deptData.length ? (
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
                  <Bar
                    dataKey="value"
                    radius={[6, 6, 0, 0]}
                    maxBarSize={48}
                    isAnimationActive={false}
                    cursor="pointer"
                    onClick={(d) => d?.name && drill({ department: d.name })}
                  >
                    {deptData.map((d) => (
                      <Cell key={d.name} fill={d.color} />
                    ))}
                    <LabelList
                      dataKey="value"
                      position="top"
                      formatter={fmtDept}
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
      <section className="zrs-sheet" ref={sheetRef}>
        <div className="zrs-sheet-head">
          <nav className="zrs-tabs" role="tablist">
            {SHEETS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={sheet === s.key}
                className={`${sheet === s.key ? 'on' : ''}${s.key === 'compare' ? ' zrs-tab-compare' : ''}`}
                onClick={() => setSheet(s.key)}
              >
                <Icon d={s.icon} size={15} />
                {s.label}
                {s.key !== 'compare' &&
                  (loading ? <i className="zrs-tab-skel" aria-hidden="true" /> : counts[s.key] != null && <span>{counts[s.key]}</span>)}
              </button>
            ))}
          </nav>
          {isTable && (
            <div className="zrs-sheet-actions">
              <Dropdown
                value={sort ? `${sort.key}:${sort.dir}` : ''}
                options={sortChoices}
                onChange={(v) => {
                  if (!v) return setSort(null);
                  const [key, dir] = v.split(':');
                  return setSort({ key, dir });
                }}
                label="Sort rows"
                align="right"
                menuWidth={250}
                searchable
                triggerClassName={`zrs-btn${sort ? ' is-active' : ''}`}
                trigger={
                  <>
                    <Icon d={ICONS.sort} size={15} />
                    {sort ? sortChoices.find((o) => o.value === `${sort.key}:${sort.dir}`)?.label || 'Sort' : 'Sort'}
                  </>
                }
              />
              {sheet === 'log' && (
                <div className="zrs-menu-wrap" ref={colsRef}>
                  <button type="button" className="zrs-btn" onClick={() => setColsOpen((v) => !v)}>
                    <Icon d={ICONS.columns} size={15} />
                    Columns
                    <span className="zrs-caret" />
                  </button>
                  {colsOpen && (
                    <div className="zrs-menu right" role="menu">
                      {columns.log.map((c) => (
                        <label key={c.key} className="zrs-check">
                          <input type="checkbox" checked={!hiddenCols.has(c.key)} onChange={() => toggleCol(c.key)} />
                          {c.label}
                        </label>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {sheet === 'compare' ? (
          <ComparePanel sheets={sheets} loading={loading} state={compare} setState={setCompare} onDrill={drill} />
        ) : (
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
                    'Syncing latest data…'
                  )}
                </div>
                <table className="zrs-table">
                  <SkeletonRows cols={sheetCols.length + 1 || 8} />
                </table>
              </div>
            ) : (
              <table className="zrs-table">
                <thead>
                  <tr>
                    <th className="num zrs-sno">S.No</th>
                    {sheetCols.map((c) => (
                      <SortTh key={c.key} col={c} sort={sort} onSort={setSort} />
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.length === 0 ? (
                    <tr>
                      <td colSpan={sheetCols.length + 1} className="zrs-empty">
                        {sheet === 'log' ? 'No generations for this selection.' : 'No data for this selection.'}
                        {sheet === 'log' && import.meta.env.DEV && (
                          <button type="button" className="zrs-link" onClick={seedDemo} disabled={busy}>
                            Load sample data (local only)
                          </button>
                        )}
                      </td>
                    </tr>
                  ) : (
                    sortedRows.map((r, i) => (
                      <tr key={ROW_KEYS[sheet](r)}>
                        <td className="num zrs-sno">{i + 1}</td>
                        {sheetCols.map((c) => (
                          <td
                            key={c.key}
                            className={[c.num ? 'num' : '', c.td || ''].join(' ').trim() || undefined}
                            title={c.title ? c.title(r) : undefined}
                          >
                            {c.cell(r)}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>

      <PeopleReportModal
        open={peopleOpen}
        onClose={() => setPeopleOpen(false)}
        users={sheets.users}
        log={sheets.log}
        period={period}
        loading={loading}
        onDrill={drill}
        onOpenOutput={openLink}
        onCompare={(ids) => openCompare('people', { people: ids })}
      />

      <OutputPreviewModal
        row={preview}
        rows={previewRows}
        onNavigate={setPreview}
        onClose={() => setPreview(null)}
        notify={notify}
      />

      <ChatTranscriptModal row={chat} onClose={() => setChat(null)} notify={notify} />

      {toast && <div className="zrs-toast">{toast}</div>}
    </div>
  );
}
