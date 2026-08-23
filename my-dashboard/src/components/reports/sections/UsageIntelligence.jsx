import React, { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, Tooltip, XAxis, YAxis,
} from 'recharts';
import { reportsAPI, downloadBlobResponse } from '../../../services/reports';
import { useChartTheme } from '../hooks/useChartTheme';
import SectionHeader from '../primitives/SectionHeader';
import KpiCard from '../primitives/KpiCard';
import InsightBanner from '../primitives/InsightBanner';
import ChartFrame, { ChartTooltip } from '../primitives/ChartFrame';
import DataTable from '../primitives/DataTable';
import { formatFull, formatNumber, formatDayLabel } from '../utils/format';

const REPORT_TYPES = [
  { key: 'organisation', label: 'Organisation' },
  { key: 'team', label: 'Team' },
  { key: 'individual', label: 'Individual' },
];

const PIE_KEYS = ['#2563eb', '#10b981', '#f59e0b', '#8b5cf6', '#ef4444', '#06b6d4', '#84cc16', '#f97316'];

const usageParams = (filters, extras = {}) => {
  const params = { start: filters.start, end: filters.end, ...extras };
  if (filters.department && filters.department !== 'all') params.department = filters.department;
  return params;
};

const UsageIntelligence = ({ filters, onOpenUser }) => {
  const theme = useChartTheme();
  const [reportType, setReportType] = useState('organisation');
  const [team, setTeam] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const [showPreview, setShowPreview] = useState(false);

  const directoryQuery = useQuery({
    queryKey: ['reports', 'usage', 'directory'],
    queryFn: () => reportsAPI.usageDirectory(),
    staleTime: 10 * 60_000,
  });
  const teams = directoryQuery.data?.teams || [];
  const people = directoryQuery.data?.users || [];

  const scopedTeam = reportType === 'team' ? team : '';
  const scopedUser = reportType === 'individual' && userId ? Number(userId) : undefined;

  const queryParams = useMemo(() => {
    const params = usageParams(filters, { reportType });
    if (scopedTeam) params.department = scopedTeam;
    if (scopedUser) params.user = scopedUser;
    return params;
  }, [filters, reportType, scopedTeam, scopedUser]);

  const overviewQuery = useQuery({
    queryKey: ['reports', 'usage', 'overview', queryParams],
    queryFn: () => reportsAPI.usageOverview(queryParams),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const detailQuery = useQuery({
    queryKey: ['reports', 'usage', 'detail', reportType, scopedUser, scopedTeam, queryParams],
    queryFn: () => {
      if (reportType === 'individual' && scopedUser) return reportsAPI.usageUser(scopedUser, queryParams);
      if (reportType === 'team' && scopedTeam) return reportsAPI.usageTeam(scopedTeam, queryParams);
      return Promise.resolve(null);
    },
    enabled: (reportType === 'individual' && !!scopedUser) || (reportType === 'team' && !!scopedTeam),
    staleTime: 60_000,
  });

  const data = overviewQuery.data;
  const k = data?.kpis || {};
  const period = data?.period || {};
  const preview = data?.preview || {};
  const individual = detailQuery.data?.individual || data?.individual;
  const teamReport = detailQuery.data?.team || data?.team;

  const generate = async () => {
    if (busy) return;
    if (reportType === 'team' && !scopedTeam) {
      setToast('Select a team first.');
      setTimeout(() => setToast(''), 2800);
      return;
    }
    if (reportType === 'individual' && !scopedUser) {
      setToast('Select a user first.');
      setTimeout(() => setToast(''), 2800);
      return;
    }
    setShowPreview(true);
    setBusy(true);
    setToast('Generating workbook…');
    try {
      const res = await reportsAPI.usageWorkbook(queryParams);
      downloadBlobResponse(res, reportType === 'individual' ? 'Person-Report.xlsx' : 'Usage-Intelligence.xlsx');
      setToast(reportType === 'individual' ? 'Person report downloaded.' : 'Workbook downloaded.');
    } catch (err) {
      setToast(err?.response?.status === 403
        ? 'Admin access is required to generate this report.'
        : 'Could not generate the workbook. Try a shorter date range.');
    } finally {
      setBusy(false);
      setTimeout(() => setToast(''), 3600);
    }
  };

  const openPreview = () => {
    if (reportType === 'team' && !scopedTeam) return;
    if (reportType === 'individual' && !scopedUser) return;
    setShowPreview(true);
  };

  if (overviewQuery.isLoading && !data) {
    return <div className="rpt-loading">Loading usage intelligence…</div>;
  }
  if (overviewQuery.isError) {
    return (
      <div className="rpt-error">
        Failed to load: {overviewQuery.error?.response?.data?.detail || overviewQuery.error?.message}
      </div>
    );
  }

  const daily = data?.trends?.daily || [];
  const tools = data?.tools || [];
  const users = data?.users || [];
  const teamRows = data?.teams || [];
  const categories = data?.categories || [];
  const actions = data?.actions || [];
  const anomalies = (data?.anomalies || []).filter((a) => a.severity === 'review').slice(0, 8);
  const bandCounts = [
    { name: 'High', value: users.filter((u) => u.usageBand === 'High').length },
    { name: 'Medium', value: users.filter((u) => u.usageBand === 'Medium').length },
    { name: 'Low', value: users.filter((u) => u.usageBand === 'Low').length },
    { name: 'Inactive', value: users.filter((u) => u.usageBand === 'Inactive').length },
  ].filter((d) => d.value > 0);

  const insight = (data?.findings || []).slice(0, 2).join(' ');
  const rec = actions[0]?.action;

  return (
    <div>
      <SectionHeader
        title="Usage Intelligence"
        subtitle="Management view of who is using which tools, how much, how effectively, and what to do next. Engagement is not a productivity score."
      >
        <div className="ui-head-actions">
          <button type="button" className="rpt-to-canvas" onClick={openPreview} disabled={busy}>
            Preview summary
          </button>
          <button type="button" className="rpt-workbook-btn" onClick={generate} disabled={busy}>
            {busy
              ? 'Generating…'
              : reportType === 'individual'
                ? 'Download person report'
                : 'Download Excel'}
          </button>
        </div>
      </SectionHeader>

      <div className="ui-wizard">
        <label className="ui-field">
          <span>Report</span>
          <div className="rpt-date-presets" role="group">
            {REPORT_TYPES.map((t) => (
              <button
                key={t.key}
                type="button"
                className={`rpt-date-preset ${reportType === t.key ? 'active' : ''}`}
                onClick={() => { setReportType(t.key); setShowPreview(false); }}
              >
                {t.label}
              </button>
            ))}
          </div>
        </label>
        {reportType === 'team' && (
          <label className="ui-field">
            <span>Team</span>
            <select className="rpt-select" value={team} onChange={(e) => setTeam(e.target.value)}>
              <option value="">Select team…</option>
              {teams.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.userCount})</option>)}
            </select>
          </label>
        )}
        {reportType === 'individual' && (
          <label className="ui-field">
            <span>User</span>
            <select className="rpt-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Select user…</option>
              {people.map((p) => (
                <option key={p.userId} value={p.userId}>{p.name} · {p.department}</option>
              ))}
            </select>
          </label>
        )}
        <p className="ui-wizard-note">
          {reportType === 'individual'
            ? 'Downloads one Excel tab: who they are, headline numbers, tools, clients, charts, and every generation.'
            : 'Period uses the date bar above. Previous equivalent period is compared automatically.'}
        </p>
      </div>

      {showPreview && (
        <div className="ui-preview">
          <div className="ui-preview-top">
            <strong>Report ready to download</strong>
            <span>{preview.period || period.label}</span>
          </div>
          <div className="ui-preview-kpis">
            <span>{formatNumber(preview.users)} users</span>
            <span>{formatNumber(preview.teams)} teams</span>
            <span>{formatNumber(preview.activeUsers)} active</span>
            <span>{formatFull(preview.generations)} generations</span>
            <span>{formatFull(preview.credits)} credits</span>
            <span>{formatFull(preview.usageHours)} hours</span>
            <span>{preview.successRate != null ? `${preview.successRate}% success` : ''}</span>
          </div>
          {(preview.findings || []).length > 0 && (
            <div>
              <div className="ui-preview-h">Key findings</div>
              <ol>{preview.findings.map((f) => <li key={f}>{f}</li>)}</ol>
            </div>
          )}
          {(preview.actionTitles || []).length > 0 && (
            <div>
              <div className="ui-preview-h">Recommended actions</div>
              <ol>{preview.actionTitles.map((f) => <li key={f}>{f}</li>)}</ol>
            </div>
          )}
        </div>
      )}

      {insight && (
        <InsightBanner recommendation={rec}>
          {insight} Period {period.label}. Usage volume is not treated as productivity.
        </InsightBanner>
      )}

      <div className="rpt-kpi-grid">
        <KpiCard label="Active users" metric={k.activeUsers} />
        <KpiCard label="Usage time" metric={k.usageHours} format="full" />
        <KpiCard label="Generations" metric={k.generations} />
        <KpiCard label="Credits consumed" metric={k.credits} format="full" />
        <KpiCard label="Success rate" metric={k.successRate} format="pct" />
        <div className="rpt-kpi">
          <div className="rpt-kpi-top"><span className="rpt-kpi-label">Most used tool</span></div>
          <div className="rpt-kpi-value" style={{ fontSize: 18 }}>{k.mostUsedTool || 'None'}</div>
        </div>
        <div className="rpt-kpi">
          <div className="rpt-kpi-top"><span className="rpt-kpi-label">Highest credit consumer</span></div>
          <div className="rpt-kpi-value" style={{ fontSize: 18 }}>{k.highestCreditConsumer || 'None'}</div>
          <div className="rpt-kpi-foot"><span className="rpt-kpi-prev">{formatFull(k.highestCreditConsumerValue)} credits</span></div>
        </div>
        <div className="rpt-kpi">
          <div className="rpt-kpi-top"><span className="rpt-kpi-label">Fastest growing tool</span></div>
          <div className="rpt-kpi-value" style={{ fontSize: 18 }}>{k.fastestGrowingTool || 'None'}</div>
          <div className="rpt-kpi-foot">
            <span className="rpt-kpi-prev">
              {k.fastestGrowingPct != null ? `${k.fastestGrowingPct > 0 ? '+' : ''}${k.fastestGrowingPct}% vs prior` : ''}
            </span>
          </div>
        </div>
      </div>

      {reportType === 'individual' && individual && (
        <IndividualPanel user={individual} />
      )}

      {reportType === 'team' && teamReport && (
        <TeamPanel team={teamReport} onOpenUser={onOpenUser} />
      )}

      <div className="rpt-grid cols-2" style={{ marginBottom: 18 }}>
        <ChartFrame title="Usage trend" hint="Generations and credits by day" height={240}>
          <AreaChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="date" tickFormatter={formatDayLabel} tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Date', position: 'insideBottom', offset: -4, fill: theme.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Volume', angle: -90, position: 'insideLeft', fill: theme.axis, fontSize: 11 }} />
            <Tooltip content={<ChartTooltip labelFormatter={formatDayLabel} />} />
            <Legend />
            <Area type="monotone" dataKey="generations" name="Generations" stroke={theme.primary} fill={theme.primary} fillOpacity={0.18} />
            <Area type="monotone" dataKey="credits" name="Credits" stroke={theme.warning} fill="transparent" />
          </AreaChart>
        </ChartFrame>
        <ChartFrame title="Tool usage distribution" hint="Generations by tool" height={240}>
          <BarChart data={tools.slice(0, 8)} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="tool" tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Tool', position: 'insideBottom', offset: -4, fill: theme.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Generations', angle: -90, position: 'insideLeft', fill: theme.axis, fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="generations" name="Generations" fill={theme.primary} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartFrame>
        <ChartFrame title="Team comparison" hint="Credits by department" height={240}>
          <BarChart data={teamRows.slice(0, 10)} layout="vertical" margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke={theme.grid} horizontal={false} />
            <XAxis type="number" tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Credits', position: 'insideBottom', offset: -4, fill: theme.axis, fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={90} tick={{ fill: theme.axis, fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="credits" name="Credits" fill={theme.success} radius={[0, 4, 4, 0]} />
          </BarChart>
        </ChartFrame>
        <ChartFrame title="User activity distribution" hint="High / medium / low / inactive" height={240}>
          <PieChart>
            <Pie data={bandCounts} dataKey="value" nameKey="name" innerRadius={48} outerRadius={80} paddingAngle={2} label={({ name }) => name}>
              {bandCounts.map((entry, i) => <Cell key={entry.name} fill={PIE_KEYS[i % PIE_KEYS.length]} />)}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
            <Legend />
          </PieChart>
        </ChartFrame>
      </div>

      <div className="rpt-grid cols-2" style={{ marginBottom: 18 }}>
        <ChartFrame title="Generation categories" hint="Tool-derived; prompts are not shown" height={220}>
          <BarChart data={categories} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="category" tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Type of output', position: 'insideBottom', offset: -4, fill: theme.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Generations', angle: -90, position: 'insideLeft', fill: theme.axis, fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Bar dataKey="generations" name="Generations" fill={theme.primary} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartFrame>
        <ChartFrame title="Credit efficiency" hint="Credits vs successful generations by user" height={220}>
          <BarChart data={[...users].sort((a, b) => (b.credits || 0) - (a.credits || 0)).slice(0, 8)} margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
            <CartesianGrid stroke={theme.grid} vertical={false} />
            <XAxis dataKey="name" tick={{ fill: theme.axis, fontSize: 10 }} interval={0} label={{ value: 'Employee', position: 'insideBottom', offset: -4, fill: theme.axis, fontSize: 11 }} />
            <YAxis tick={{ fill: theme.axis, fontSize: 11 }} label={{ value: 'Volume', angle: -90, position: 'insideLeft', fill: theme.axis, fontSize: 11 }} />
            <Tooltip content={<ChartTooltip />} />
            <Legend />
            <Bar dataKey="credits" name="Credits" fill="#f59e0b" radius={[4, 4, 0, 0]} />
            <Bar dataKey="successfulGenerations" name="Successful gens" fill={theme.success} radius={[4, 4, 0, 0]} />
          </BarChart>
        </ChartFrame>
      </div>

      <h3 className="rpt-card-title" style={{ margin: '8px 0 10px' }}>Teams</h3>
      <DataTable
        initialSort="credits"
        onRowClick={(row) => { setReportType('team'); setTeam(row.name); }}
        columns={[
          { key: 'name', label: 'Team' },
          { key: 'lead', label: 'Lead' },
          { key: 'users', label: 'Users', num: true },
          { key: 'activeUsers', label: 'Active', num: true },
          { key: 'usageHours', label: 'Hours', num: true },
          { key: 'generations', label: 'Gens', num: true },
          { key: 'credits', label: 'Credits', num: true },
          { key: 'successRate', label: 'Success %', num: true },
        ]}
        rows={teamRows}
      />

      <h3 className="rpt-card-title" style={{ margin: '22px 0 10px' }}>Users</h3>
      <DataTable
        initialSort="credits"
        onRowClick={(row) => onOpenUser?.(row.userId, row.name, 'output')}
        columns={[
          { key: 'name', label: 'Employee' },
          { key: 'department', label: 'Team' },
          { key: 'usageHours', label: 'Hours', num: true },
          { key: 'sessions', label: 'Sessions', num: true },
          { key: 'generations', label: 'Gens', num: true },
          { key: 'credits', label: 'Credits', num: true },
          { key: 'successRate', label: 'Success %', num: true },
          { key: 'toolsUsed', label: 'Tools', num: true },
          { key: 'engagementScore', label: 'Engagement', num: true },
          { key: 'usageBand', label: 'Band' },
        ]}
        rows={users}
      />

      <h3 className="rpt-card-title" style={{ margin: '22px 0 10px' }}>Management actions</h3>
      <div className="ui-actions">
        {actions.length === 0 && <p className="rpt-sec-sub">No prioritised actions for this window.</p>}
        {actions.map((a) => (
          <article key={`${a.kind}-${a.target}-${a.title}`} className="ui-action">
            <div className="ui-action-meta">
              <span className={`rpt-pill ${a.priority === 1 ? 'warn' : 'muted'}`}>P{a.priority}</span>
              <span className="rpt-rec-type user">{a.kind}</span>
              <span className="rpt-sec-sub">{a.target}</span>
            </div>
            <h4>{a.title}</h4>
            <p>{a.action}</p>
          </article>
        ))}
      </div>

      {anomalies.length > 0 && (
        <>
          <h3 className="rpt-card-title" style={{ margin: '22px 0 10px' }}>Flags for review</h3>
          <p className="rpt-sec-sub" style={{ marginBottom: 10 }}>These are review flags, not a determination of misuse.</p>
          <DataTable
            columns={[
              { key: 'userName', label: 'User' },
              { key: 'kind', label: 'Kind' },
              { key: 'finding', label: 'Finding' },
              { key: 'recommendedAction', label: 'Action' },
            ]}
            rows={anomalies}
          />
        </>
      )}

      <p className="ui-method">
        {data?.methodology?.engagement} {data?.methodology?.usageTime} {data?.methodology?.category}
      </p>
      {toast && <div className="rpt-canvas-toast">{toast}</div>}
    </div>
  );
};

const IndividualPanel = ({ user }) => {
  const log = user.generationLog || [];
  const previewLog = log.slice(0, 80);
  return (
    <div className="ui-profile">
      <div className="ui-profile-grid">
        <div><span>Employee ID</span><b>{user.employeeId}</b></div>
        <div><span>Email</span><b>{user.email || 'Not set'}</b></div>
        <div><span>Team</span><b>{user.department}</b></div>
        <div><span>Role</span><b>{user.role}</b></div>
        <div><span>Department lead</span><b>{user.teamLead}</b></div>
        <div><span>Account</span><b>{user.accountStatus}</b></div>
        <div><span>Active days</span><b>{user.activeDays}</b></div>
        <div><span>Time using tools</span><b>{user.toolTimeLabel || `${user.toolTimeHours || 0}h`}</b></div>
        <div><span>Generations</span><b>{user.generations}</b></div>
        <div><span>Credits</span><b>{user.credits}</b></div>
        <div><span>Success rate</span><b>{user.successRate}%</b></div>
        <div><span>Top client</span><b>{user.primaryClient || 'Not linked'}</b></div>
      </div>
      <h4 className="ui-subhead">Tools</h4>
      <DataTable
        columns={[
          { key: 'tool', label: 'Tool' },
          { key: 'category', label: 'Category' },
          { key: 'generations', label: 'Gens', num: true },
          { key: 'timeSpentNote', label: 'Time' },
          { key: 'launches', label: 'Launches', num: true },
          { key: 'credits', label: 'Credits', num: true },
          { key: 'successRate', label: 'Success %', num: true },
          { key: 'lastUsed', label: 'Last used' },
        ]}
        rows={user.tools || []}
      />
      <h4 className="ui-subhead">Credits by client</h4>
      <DataTable
        initialSort="credits"
        columns={[
          { key: 'client', label: 'Client' },
          { key: 'generations', label: 'Gens', num: true },
          { key: 'credits', label: 'Credits', num: true },
          { key: 'share', label: 'Share %', num: true },
          { key: 'tools', label: 'Tools' },
        ]}
        rows={user.clients || []}
      />
      <h4 className="ui-subhead">Every generation</h4>
      <p className="ui-wizard-note">
        Client and tool for each captured generation. ChatGPT is one row per conversation and is not client-mapped.
        {log.length > previewLog.length ? ` Showing ${previewLog.length} of ${log.length} here. Download the person report for the full list.` : ''}
      </p>
      <DataTable
        initialSort="date"
        columns={[
          { key: 'date', label: 'Date' },
          { key: 'client', label: 'Client' },
          { key: 'tool', label: 'Tool' },
          { key: 'category', label: 'Type' },
          { key: 'generations', label: 'Gens', num: true },
          { key: 'credits', label: 'Credits', num: true },
          { key: 'status', label: 'Status' },
          { key: 'task', label: 'Task' },
        ]}
        rows={previewLog}
      />
    </div>
  );
};

const TeamPanel = ({ team, onOpenUser }) => (
  <div className="ui-profile" style={{ marginBottom: 18 }}>
    <div className="ui-profile-grid">
      <div><span>Team</span><b>{team.name}</b></div>
      <div><span>Lead</span><b>{team.lead}</b></div>
      <div><span>Users</span><b>{team.users}</b></div>
      <div><span>Active</span><b>{team.activeUsers}</b></div>
      <div><span>Hours</span><b>{team.usageHours}</b></div>
      <div><span>Credits</span><b>{team.credits}</b></div>
    </div>
    <DataTable
      initialSort="credits"
      onRowClick={(row) => onOpenUser?.(row.userId, row.name, 'output')}
      columns={[
        { key: 'name', label: 'Employee' },
        { key: 'usageHours', label: 'Hours', num: true },
        { key: 'sessions', label: 'Sessions', num: true },
        { key: 'generations', label: 'Gens', num: true },
        { key: 'credits', label: 'Credits', num: true },
        { key: 'successRate', label: 'Success %', num: true },
        { key: 'toolsUsed', label: 'Tools', num: true },
      ]}
      rows={team.members || []}
    />
  </div>
);

export default UsageIntelligence;
