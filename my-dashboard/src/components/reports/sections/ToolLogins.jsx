import React, { useMemo, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI, downloadBlobResponse } from '../../../services/reports';
import { presetRange } from '../utils/format';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';

const PRESETS = [
  { key: '7d', label: '7 Days' },
  { key: '30d', label: '30 Days' },
  { key: '90d', label: '90 Days' },
  { key: 'month', label: 'This month' },
  { key: 'prev_month', label: 'Last month' },
  { key: 'all', label: 'All Time' },
  { key: 'custom', label: 'Custom' },
];

const COLUMNS = [
  { key: 'dateTime', label: 'Date / time' },
  { key: 'userName', label: 'User' },
  { key: 'department', label: 'Team' },
  { key: 'tool', label: 'Tool' },
  { key: 'assignedAccount', label: 'Assigned account' },
];

const ToolLogins = () => {
  const [preset, setPreset] = useState('30d');
  const [range, setRange] = useState(() => presetRange('30d'));
  const [team, setTeam] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const setPresetKey = (key) => {
    setPreset(key);
    if (key !== 'custom') setRange(presetRange(key));
  };

  const directoryQuery = useQuery({
    queryKey: ['reports', 'tool-logins', 'directory'],
    queryFn: () => reportsAPI.usageDirectory(),
    staleTime: 10 * 60_000,
  });
  const teams = directoryQuery.data?.teams || [];
  const people = directoryQuery.data?.users || [];

  const params = useMemo(() => {
    const p = { start: range.start, end: range.end };
    if (team) p.department = team;
    if (userId) p.user = Number(userId);
    return p;
  }, [range, team, userId]);

  const dataQuery = useQuery({
    queryKey: ['reports', 'tool-logins', params],
    queryFn: () => reportsAPI.toolLogins(params),
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });

  const data = dataQuery.data;
  const rows = data?.toolLogins || [];

  const download = async () => {
    if (busy) return;
    setBusy(true);
    setToast('Generating workbook…');
    try {
      const res = await reportsAPI.toolLoginsWorkbook(params);
      downloadBlobResponse(res, 'Tool-Logins.xlsx');
      setToast('Tool logins downloaded.');
    } catch (err) {
      setToast(err?.response?.status === 403
        ? 'Admin access is required to generate this report.'
        : 'Could not generate the workbook. Try a shorter date range.');
    } finally {
      setBusy(false);
      setTimeout(() => setToast(''), 3600);
    }
  };

  return (
    <div>
      <SectionHeader
        title="Tool Logins"
        subtitle="Every time someone clicked Launch on a tool from the dashboard — who, which tool, the assigned account used, and when. Its own date range, independent of the other reports."
      >
        <div className="ui-head-actions">
          <button type="button" className="rpt-workbook-btn" onClick={download} disabled={busy}>
            {busy ? 'Generating…' : 'Download Excel'}
          </button>
        </div>
      </SectionHeader>

      <div className="ui-wizard">
        <label className="ui-field">
          <span>Date range</span>
          <div className="rpt-date-presets" role="group">
            {PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`rpt-date-preset ${preset === p.key ? 'active' : ''}`}
                onClick={() => setPresetKey(p.key)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </label>
        {preset === 'custom' && (
          <label className="ui-field">
            <span>Custom</span>
            <div className="rpt-date-inputs">
              <input
                type="date"
                className="rpt-input"
                value={range.start || ''}
                max={range.end || undefined}
                onChange={(e) => setRange((r) => ({ ...r, start: e.target.value }))}
                aria-label="Start date"
              />
              <span style={{ color: 'var(--color-text-muted)' }}>–</span>
              <input
                type="date"
                className="rpt-input"
                value={range.end || ''}
                min={range.start || undefined}
                onChange={(e) => setRange((r) => ({ ...r, end: e.target.value }))}
                aria-label="End date"
              />
            </div>
          </label>
        )}
        <label className="ui-field">
          <span>Team</span>
          <select className="rpt-select" value={team} onChange={(e) => { setTeam(e.target.value); setUserId(''); }}>
            <option value="">All teams</option>
            {teams.map((t) => <option key={t.name} value={t.name}>{t.name} ({t.userCount})</option>)}
          </select>
        </label>
        <label className="ui-field">
          <span>User</span>
          <select className="rpt-select" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All users</option>
            {people
              .filter((p) => !team || p.department === team)
              .map((p) => <option key={p.userId} value={p.userId}>{p.name} · {p.department}</option>)}
          </select>
        </label>
      </div>

      {toast && <div className="rpt-canvas-toast">{toast}</div>}

      {dataQuery.isLoading && !data && <div className="rpt-loading">Loading tool logins…</div>}
      {dataQuery.isError && (
        <div className="rpt-error">
          Failed to load: {dataQuery.error?.response?.data?.detail || dataQuery.error?.message}
        </div>
      )}

      {data && (
        <>
          <div className="ui-wizard-note">
            {data.period?.label} — {data.totalRows} login attempt{data.totalRows === 1 ? '' : 's'} across {data.uniqueUsers} user{data.uniqueUsers === 1 ? '' : 's'} and {data.uniqueTools} tool{data.uniqueTools === 1 ? '' : 's'}.
            {data.capped ? ' Showing the most recent rows for this range — narrow the date range to see the rest.' : ''}
          </div>
          <DataTable columns={COLUMNS} rows={rows} initialSort="dateTime" initialDir="desc" />
        </>
      )}
    </div>
  );
};

export default ToolLogins;
