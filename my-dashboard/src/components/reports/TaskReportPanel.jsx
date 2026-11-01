import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import WindowControls from '../common/WindowControls';
import { useMinimizedWindowStack } from '../../hooks/useMinimizedWindowStack';
import { useDebouncedValue } from '../../hooks/useDebouncedValue';
import { isMobileViewport } from '../../utils/isMobileViewport';
import { downloadBlobResponse, reportsAPI } from '../../services/reports';
import { formatDateTimeIndia, toIndiaISODate } from '../../utils/dateTime';
import { formatShortDateTime, getAvatarHue, getInitials } from '../../utils/taskPresentation';
import DateRangePicker from './DateRangePicker';
import { DATE_PRESETS, computePresetDates, formatRange } from './dateRanges';
import FilterPopover from '../leftsidebar/compofleftsidebar/trending/FilterPopover';
import TaskReportDrawer from './TaskReportDrawer';
import { DEADLINE_BADGES } from './taskReportShared';
import './TaskReportPanel.css';

/*
 * Task Report: who assigned what to whom, where it stands, and whether it met
 * its deadline. Filters load results as they change (no "Generate" step) and
 * map 1:1 onto backend TaskReportFilters (routers/task_report_router.py),
 * shared by the list, the counts and the Excel export.
 */

const PAGE_SIZE = 50;

const EMPTY = Object.freeze({
  datePreset: 'all', dateFrom: '', dateTo: '', dateField: 'created',
  stage: '', statuses: [], priority: '', category: '', project: '',
  toDepartment: '', fromDepartment: '', creatorId: '', assigneeId: '', deadlineState: '', hasResult: '', search: '',
});

const SORTS = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'deadline', label: 'Deadline soonest' },
  { value: 'priority', label: 'Priority' },
  { value: 'status', label: 'Status' },
  { value: 'updated', label: 'Recently active' },
];

const STAGE_LABELS = { open: 'Open tasks', done: 'Finished tasks', closed: 'Cancelled / rejected' };
const DATE_LABELS = Object.fromEntries(DATE_PRESETS.map((p) => [p.key, p.label]));

const resolveDates = (f) => {
  if (!f.datePreset || f.datePreset === 'all') return { from: null, to: null };
  if (f.datePreset === 'custom') return { from: f.dateFrom || null, to: f.dateTo || null };
  const { start, end } = computePresetDates(f.datePreset);
  return { from: start, to: end };
};

const toParams = (f, search) => {
  const { from, to } = resolveDates(f);
  const params = {
    start: from || undefined,
    end: to || undefined,
    date_field: f.dateField,
    stage: f.stage || undefined,
    status: f.statuses.length ? f.statuses.join(',') : undefined,
    priority: f.priority || undefined,
    category: f.category || undefined,
    project: f.project || undefined,
    to_department: f.toDepartment || undefined,
    from_department: f.fromDepartment || undefined,
    creator_id: f.creatorId || undefined,
    assignee_id: f.assigneeId || undefined,
    deadline_state: f.deadlineState || undefined,
    has_result: f.hasResult || undefined,
    q: (search ?? f.search).trim() || undefined,
  };
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined));
};

const withCount = (label, count) => (Number.isFinite(count) ? `${label} · ${count.toLocaleString()}` : label);
const labelIn = (list = [], value) => list.find((o) => String(o.value) === String(value))?.label || value;

function describe(f, options) {
  const chips = [];
  if (f.datePreset !== 'all') {
    const { from, to } = resolveDates(f);
    const range = f.datePreset === 'custom' ? formatRange(from, to) : DATE_LABELS[f.datePreset];
    const field = labelIn(options.dateFields, f.dateField);
    chips.push({ key: 'date', label: `${field}: ${range}`, reset: { datePreset: 'all', dateFrom: '', dateTo: '' } });
  }
  if (f.stage) chips.push({ key: 'stage', label: STAGE_LABELS[f.stage], reset: { stage: '' } });
  if (f.statuses.length) chips.push({ key: 'status', label: `Status: ${f.statuses.map((s) => labelIn(options.statuses, s)).join(', ')}`, reset: { statuses: [] } });
  if (f.toDepartment) chips.push({ key: 'dept', label: `Dept: ${f.toDepartment}`, reset: { toDepartment: '' } });
  if (f.fromDepartment) chips.push({ key: 'fromDept', label: `From: ${f.fromDepartment}`, reset: { fromDepartment: '' } });
  if (f.creatorId) chips.push({ key: 'creator', label: `Assigned by: ${labelIn(options.creators, f.creatorId)}`, reset: { creatorId: '' } });
  if (f.assigneeId) chips.push({ key: 'assignee', label: `Assignee: ${labelIn(options.assignees, f.assigneeId)}`, reset: { assigneeId: '' } });
  if (f.priority) chips.push({ key: 'priority', label: `${labelIn(options.priorities, f.priority)} priority`, reset: { priority: '' } });
  if (f.category) chips.push({ key: 'category', label: `Category: ${f.category}`, reset: { category: '' } });
  if (f.project) chips.push({ key: 'project', label: `Project: ${f.project}`, reset: { project: '' } });
  if (f.deadlineState) chips.push({ key: 'deadline', label: labelIn(options.deadlineStates, f.deadlineState), reset: { deadlineState: '' } });
  if (f.hasResult) chips.push({ key: 'result', label: f.hasResult === 'yes' ? 'Has a result' : 'No result yet', reset: { hasResult: '' } });
  if (f.search.trim()) chips.push({ key: 'search', label: `“${f.search.trim()}”`, reset: { search: '' } });
  return chips;
}

function Person({ person, size = 22 }) {
  if (!person) return <span className="tr2-muted">—</span>;
  return (
    <span className="tr2-person" title={person.department ? `${person.name} · ${person.department}` : person.name}>
      <span className="tr2-avatar" style={{ width: size, height: size, '--hue': getAvatarHue(person.name) }} aria-hidden="true">
        {getInitials(person.name)}
      </span>
      <span className="tr2-person-name">{person.name}</span>
    </span>
  );
}

function Select({ label, value, onChange, anyLabel, options }) {
  return (
    <label className="tr2-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {options.map((o) => <option key={o.value} value={o.value}>{withCount(o.label, o.count)}</option>)}
      </select>
    </label>
  );
}

function ExportButton({ params, chips, total }) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape' && !busy) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open, busy]);

  const download = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await reportsAPI.taskReportXlsx({ ...params, include_history: history });
      downloadBlobResponse(res, `task-report_${toIndiaISODate(new Date())}.xlsx`);
      setOpen(false);
    } catch (err) {
      let detail = 'Could not build the export. Try again.';
      const data = err?.response?.data;
      if (data instanceof Blob) {
        try { const parsed = JSON.parse(await data.text()); if (typeof parsed?.detail === 'string') detail = parsed.detail; } catch { /* not JSON */ }
      }
      setError(detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="tr2-export" ref={ref}>
      <button type="button" className={`tr2-export-btn${open ? ' is-open' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" /><path d="M14 3v5h5M9 13l2.5 3L9 19M15 13l-2.5 3 2.5 3" />
        </svg>
        {busy ? 'Preparing…' : 'Export to Excel'}
      </button>
      {open && (
        <div className="tr2-export-pop" role="dialog" aria-label="Export task report">
          <header>
            <strong>Export task report</strong>
            <span>Summary (key figures, by status, assignee, assigned by, department, category, project, month) + every task</span>
          </header>
          <div className="tr2-export-body">
            <div className="tr2-export-filters">
              <span className="tr2-export-label">Uses the report filters</span>
              {chips.length ? (
                <div className="tr2-chips">{chips.map((c) => <span key={c.key} className="tr2-chip tr2-chip--static">{c.label}</span>)}</div>
              ) : <span className="tr2-muted">No filters: every task</span>}
            </div>
            <label className="tr2-check">
              <input type="checkbox" checked={history} onChange={(e) => setHistory(e.target.checked)} />
              <span>Add a <strong>Status history</strong> sheet (every status change, who and when)</span>
            </label>
            {error && <div className="tr2-error" role="alert">{error}</div>}
          </div>
          <footer>
            <span><strong>{(total ?? 0).toLocaleString()}</strong> task{total === 1 ? '' : 's'}</span>
            <button type="button" className="tr2-export-go" onClick={download} disabled={busy || !total}>
              {busy ? 'Preparing…' : 'Download .xlsx'}
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}

export default function TaskReportPanel({ isOpen, onClose, onMinimizedChange, onActivate }) {
  const [isMinimized, setIsMinimized] = useState(false);
  const [isMaximized, setIsMaximized] = useState(isMobileViewport);
  const minimizedWindowStyle = useMinimizedWindowStack('task-report-panel', isOpen && isMinimized);

  const [options, setOptions] = useState({
    statuses: [], priorities: [], categories: [], projects: [], toDepartments: [], fromDepartments: [],
    creators: [], assignees: [], deadlineStates: [], dateFields: [],
  });
  const [filters, setFilters] = useState(EMPTY);
  const search = useDebouncedValue(filters.search, 350);
  const project = useDebouncedValue(filters.project, 350);
  const [sort, setSort] = useState('newest');
  const [tasks, setTasks] = useState([]);
  const [kpis, setKpis] = useState(null);
  const [statusCounts, setStatusCounts] = useState({});
  const [nextOffset, setNextOffset] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [openTaskId, setOpenTaskId] = useState(null);
  const requestRef = useRef(0);

  useEffect(() => { onMinimizedChange?.(isOpen && isMinimized); }, [isMinimized, isOpen, onMinimizedChange]);
  useEffect(() => {
    if (!isOpen) { setIsMinimized(false); setIsMaximized(false); } else { setIsMaximized(isMobileViewport()); }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return undefined;
    let cancelled = false;
    reportsAPI.taskReportOptions()
      .then((res) => { if (!cancelled && res) setOptions((prev) => ({ ...prev, ...res })); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isOpen]);

  const params = useMemo(() => toParams({ ...filters, project }, search), [filters, search, project]);
  const paramsKey = JSON.stringify(params);
  const { from, to } = resolveDates(filters);
  const invalid = from && to && from > to ? 'The start date is after the end date.' : '';

  useEffect(() => {
    if (!isOpen || invalid) return;
    const id = ++requestRef.current;
    setLoading(true);
    reportsAPI.taskReportTasks({ ...params, sort, limit: PAGE_SIZE, offset: 0 })
      .then((res) => {
        if (requestRef.current !== id) return;
        setTasks(res?.tasks || []);
        setKpis(res?.kpis || null);
        setStatusCounts(res?.statusCounts || {});
        setNextOffset(res?.hasMore ? res.nextOffset : null);
        setError('');
      })
      .catch((err) => { if (requestRef.current === id) setError(err?.response?.data?.detail || 'Could not load the task report.'); })
      .finally(() => { if (requestRef.current === id) setLoading(false); });
  }, [isOpen, paramsKey, sort, invalid]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadMore = async () => {
    if (loadingMore || nextOffset == null) return;
    setLoadingMore(true);
    try {
      const res = await reportsAPI.taskReportTasks({ ...params, sort, limit: PAGE_SIZE, offset: nextOffset });
      setTasks((prev) => [...prev, ...(res?.tasks || [])]);
      setNextOffset(res?.hasMore ? res.nextOffset : null);
    } catch {
      setError('Could not load more tasks.');
    } finally {
      setLoadingMore(false);
    }
  };

  const update = useCallback((patch) => setFilters((prev) => ({ ...prev, ...patch })), []);
  const toggleStatus = (status) => update({
    stage: '',
    statuses: filters.statuses.includes(status) ? filters.statuses.filter((s) => s !== status) : [...filters.statuses, status],
  });

  const handleToggleMinimize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMinimized(true);
  };
  const handleToggleMaximize = () => {
    if (isMinimized) { onActivate?.(); setIsMinimized(false); return; }
    setIsMaximized((prev) => !prev);
  };

  if (!isOpen) return null;

  const chips = describe(filters, options);
  const popoverActive = chips.filter((c) => !['date', 'search', 'stage'].includes(c.key)).length;
  const statusTotal = Object.values(statusCounts).reduce((a, b) => a + b, 0) || 1;
  const statusSegments = options.statuses
    .map((s) => ({ ...s, n: statusCounts[s.value] || 0 }))
    .filter((s) => s.n > 0);

  const kpiCards = kpis && [
    { key: 'total', label: 'Tasks', value: kpis.total, onClick: () => update({ stage: '', deadlineState: '', statuses: [] }) },
    { key: 'open', label: 'Open', value: kpis.open, onClick: () => update({ stage: 'open', statuses: [] }), active: filters.stage === 'open' },
    { key: 'overdue', label: 'Overdue', value: kpis.overdue, tone: kpis.overdue ? 'danger' : '', onClick: () => update({ deadlineState: 'overdue' }), active: filters.deadlineState === 'overdue' },
    { key: 'done', label: 'Finished', value: kpis.done, tone: 'success', onClick: () => update({ stage: 'done', statuses: [] }), active: filters.stage === 'done' },
    { key: 'ontime', label: 'On-time rate', value: kpis.onTimeRate != null ? `${kpis.onTimeRate}%` : '—', hint: 'Finished tasks that met their deadline' },
    { key: 'avg', label: 'Avg. days to finish', value: kpis.avgDaysToComplete ?? '—', hint: 'From created to completed' },
  ];

  return (
    <>
      <div className={`trp-overlay ${isMinimized ? 'disabled' : ''}`} onClick={!isMinimized ? onClose : undefined} />
      <div
        className={`trp-panel tr2-panel ${isMinimized ? 'minimized' : ''} ${isMaximized ? 'maximized' : ''}`}
        style={minimizedWindowStyle || undefined}
        onClick={isMinimized ? handleToggleMinimize : undefined}
        role="dialog"
        aria-modal="true"
        aria-label="Task Report"
      >
        <div className="trp-header">
          <div className="trp-brand">
            <span className="trp-brand-mark" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 11l2 2 4-4" /><rect x="3" y="4" width="18" height="16" rx="2" /><line x1="7" y1="16" x2="13" y2="16" />
              </svg>
            </span>
            <h2 className="trp-title">Task Report</h2>
          </div>
          <div className="trp-header-spacer" />
          <WindowControls isMinimized={isMinimized} isMaximized={isMaximized} onMinimize={handleToggleMinimize} onMaximize={handleToggleMaximize} onClose={onClose} />
        </div>

        {!isMinimized && (
          <div className="trp-body tr2-body">
            {kpiCards && (
              <div className="tr2-kpis">
                {kpiCards.map((card) => {
                  const Tag = card.onClick ? 'button' : 'div';
                  return (
                    <Tag
                      key={card.key}
                      type={card.onClick ? 'button' : undefined}
                      className={`tr2-kpi${card.tone ? ` tr2-kpi--${card.tone}` : ''}${card.active ? ' is-active' : ''}`}
                      onClick={card.onClick}
                      title={card.hint}
                    >
                      <span>{card.label}</span>
                      <strong>{typeof card.value === 'number' ? card.value.toLocaleString() : card.value}</strong>
                    </Tag>
                  );
                })}
              </div>
            )}

            {statusSegments.length > 0 && (
              <div className="tr2-statusbar-wrap">
                <div className="tr2-statusbar" role="img" aria-label="Tasks by status">
                  {statusSegments.map((s) => (
                    <span key={s.value} className={`tr2-seg tr2-seg--${s.value}`} style={{ flexGrow: s.n }} title={`${s.label}: ${s.n}`} />
                  ))}
                </div>
                <div className="tr2-legend">
                  {statusSegments.map((s) => (
                    <button
                      key={s.value}
                      type="button"
                      className={`tr2-legend-item${filters.statuses.includes(s.value) ? ' is-active' : ''}`}
                      onClick={() => toggleStatus(s.value)}
                      aria-pressed={filters.statuses.includes(s.value)}
                    >
                      <span className={`tr2-dot tr2-seg--${s.value}`} aria-hidden="true" />
                      {s.label} <strong>{s.n}</strong>
                      <em>{Math.round((100 * s.n) / statusTotal)}%</em>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="tr2-toolbar">
              <label className="tr2-datefield" title="Which date the range applies to">
                <select value={filters.dateField} onChange={(e) => update({ dateField: e.target.value })} aria-label="Date applies to">
                  {(options.dateFields.length ? options.dateFields : [{ value: 'created', label: 'Created' }]).map((d) => (
                    <option key={d.value} value={d.value}>{d.label}</option>
                  ))}
                </select>
              </label>
              <div className="tr2-date">
                <DateRangePicker
                  block allowAll portal align="left" ariaLabel="Date range"
                  start={from || ''} end={to || ''} presetKey={filters.datePreset}
                  onChange={(range, key) => update(key === 'custom'
                    ? { datePreset: 'custom', dateFrom: range.start, dateTo: range.end }
                    : { datePreset: key, dateFrom: '', dateTo: '' })}
                />
              </div>
              <input
                type="search"
                className="tr2-search"
                placeholder="Search title, task #, project…"
                value={filters.search}
                onChange={(e) => update({ search: e.target.value })}
                aria-label="Search tasks"
              />
              <FilterPopover
                activeCount={popoverActive}
                onClear={() => update({
                  statuses: [], priority: '', category: '', project: '', toDepartment: '', fromDepartment: '',
                  creatorId: '', assigneeId: '', deadlineState: '', hasResult: '',
                })}
              >
                <section className="fpop-section">
                  <h6 className="fpop-section-title">People &amp; departments</h6>
                  <div className="fpop-grid">
                    <Select label="Department" anyLabel="All departments" options={options.toDepartments} value={filters.toDepartment} onChange={(v) => update({ toDepartment: v })} />
                    <Select label="From department" anyLabel="Any" options={options.fromDepartments} value={filters.fromDepartment} onChange={(v) => update({ fromDepartment: v })} />
                    <Select label="Assigned by" anyLabel="Anyone" options={options.creators} value={filters.creatorId} onChange={(v) => update({ creatorId: v })} />
                    <Select label="Assignee" anyLabel="Anyone" options={options.assignees} value={filters.assigneeId} onChange={(v) => update({ assigneeId: v })} />
                  </div>
                </section>
                <section className="fpop-section">
                  <h6 className="fpop-section-title">Task</h6>
                  <div className="fpop-grid">
                    <Select label="Status" anyLabel="Any status" options={options.statuses}
                      value={filters.statuses.length === 1 ? filters.statuses[0] : ''}
                      onChange={(v) => update({ statuses: v ? [v] : [], stage: '' })} />
                    <Select label="Priority" anyLabel="Any" options={options.priorities} value={filters.priority} onChange={(v) => update({ priority: v })} />
                    <Select label="Category" anyLabel="All categories" options={options.categories} value={filters.category} onChange={(v) => update({ category: v })} />
                    <label className="tr2-field">
                      <span>Project</span>
                      <input list="tr2-projects" placeholder="Any project" value={filters.project} onChange={(e) => update({ project: e.target.value })} />
                      <datalist id="tr2-projects">
                        {options.projects.map((p) => <option key={p.value} value={p.value}>{withCount(p.label, p.count)}</option>)}
                      </datalist>
                    </label>
                  </div>
                </section>
                <section className="fpop-section">
                  <h6 className="fpop-section-title">Deadline &amp; output</h6>
                  <div className="fpop-grid">
                    <Select label="Deadline" anyLabel="Any" options={options.deadlineStates} value={filters.deadlineState} onChange={(v) => update({ deadlineState: v })} />
                    <Select label="Written result" anyLabel="Any" options={[{ value: 'yes', label: 'Has a result' }, { value: 'no', label: 'No result yet' }]} value={filters.hasResult} onChange={(v) => update({ hasResult: v })} />
                    <Select label="Progress" anyLabel="Any" options={Object.entries(STAGE_LABELS).map(([value, label]) => ({ value, label }))} value={filters.stage} onChange={(v) => update({ stage: v, statuses: [] })} />
                  </div>
                </section>
              </FilterPopover>
              <label className="tr2-sort">
                <span>Sort</span>
                <select value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort tasks">
                  {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </label>
              <ExportButton params={params} chips={chips} total={kpis?.total} />
            </div>

            {(chips.length > 0 || invalid) && (
              <div className="tr2-chips">
                {invalid && <span className="tr2-invalid">{invalid}</span>}
                {chips.map((chip) => (
                  <span key={chip.key} className="tr2-chip">
                    {chip.label}
                    <button type="button" onClick={() => update(chip.reset)} aria-label={`Remove filter ${chip.label}`}>×</button>
                  </span>
                ))}
                {chips.length > 0 && <button type="button" className="tr2-link" onClick={() => setFilters(EMPTY)}>Clear all</button>}
              </div>
            )}

            {error && <div className="trp-error" role="alert">{error}</div>}

            {tasks.length === 0 ? (
              <div className="tr2-empty">{loading ? 'Loading tasks…' : 'No tasks match these filters.'}</div>
            ) : (
              <div className={`tr2-table-wrap${loading ? ' is-refreshing' : ''}`}>
                <table className="tr2-table">
                  <thead>
                    <tr>
                      <th>Task</th>
                      <th>Assigned by</th>
                      <th>Assignees</th>
                      <th>Department</th>
                      <th>Status</th>
                      <th>Deadline</th>
                      <th>Created</th>
                      <th className="num" title="Days open (or days it took to finish)">Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tasks.map((t) => {
                      const badge = DEADLINE_BADGES[t.deadlineState] || DEADLINE_BADGES.no_deadline;
                      return (
                        <tr key={t.id} onClick={() => setOpenTaskId(t.id)} className="tr2-row">
                          <td className="tr2-task-cell">
                            <div className="tr2-task">
                              <span className={`tr2-priority tr2-priority--${t.priority || 'none'}`} title={`${t.priority || 'No'} priority`} />
                              <div className="tr2-task-text">
                                <button type="button" className="tr2-task-title" title={t.title} onClick={(e) => { e.stopPropagation(); setOpenTaskId(t.id); }}>
                                  {t.title || 'Untitled task'}
                                </button>
                                <span className="tr2-task-meta">
                                  {[t.taskNumber, t.projectName].filter(Boolean).join(' · ')}
                                  {t.category && <span className="tr2-tag">{t.category}</span>}
                                  {t.commentCount > 0 && <span className="tr2-meta-icon" title={`${t.commentCount} comments`}>💬 {t.commentCount}</span>}
                                  {t.hasResult && <span className="tr2-meta-icon" title="Has a written result">📄</span>}
                                </span>
                              </div>
                            </div>
                          </td>
                          <td><Person person={t.assignedBy} /></td>
                          <td>
                            {t.assignees.length ? (
                              <div className="tr2-people">
                                <Person person={t.assignees[0]} />
                                {t.assignees.length > 1 && <span className="tr2-more" title={t.assignees.map((a) => a.name).join(', ')}>+{t.assignees.length - 1}</span>}
                              </div>
                            ) : <span className="tr2-unassigned">Nobody yet</span>}
                          </td>
                          <td>
                            <span className="tr2-dept" title={`${t.fromDepartment || '—'} → ${t.toDepartment || '—'}`}>
                              {t.toDepartment || '—'}
                              {t.fromDepartment && t.fromDepartment !== t.toDepartment && <em>from {t.fromDepartment}</em>}
                            </span>
                          </td>
                          <td>
                            <span className={`tr2-status tr2-status--${t.status}`}>{t.statusLabel}</span>
                            {t.stageTitle && <span className="tr2-stage" title="Current workflow stage">{t.stageTitle}</span>}
                          </td>
                          <td title={t.deadline ? formatDateTimeIndia(t.deadline) : undefined}>
                            <div className="tr2-deadline">
                              <span>{t.deadline ? formatShortDateTime(t.deadline) : '—'}</span>
                              <span className={`tr2-badge tr2-badge--${badge.tone}`}>{badge.label}</span>
                            </div>
                          </td>
                          <td title={formatDateTimeIndia(t.createdAt)}>{formatShortDateTime(t.createdAt)}</td>
                          <td className="num">{t.ageDays ?? '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {nextOffset != null && (
              <div className="tr2-more-wrap">
                <button type="button" className="tr2-more-btn" onClick={loadMore} disabled={loadingMore}>
                  {loadingMore ? 'Loading…' : `Show more (${((kpis?.total || 0) - tasks.length).toLocaleString()} left)`}
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {openTaskId && <TaskReportDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
    </>
  );
}
