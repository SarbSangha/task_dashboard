import React, { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI, downloadBlobResponse } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';

const COLUMNS = [
  { key: 'dateTime', label: 'Date / time' },
  { key: 'userName', label: 'User' },
  { key: 'department', label: 'Team' },
  { key: 'tool', label: 'Tool' },
  { key: 'assignedAccount', label: 'Assigned account' },
];

// Date, department, tool, account and user all come from the Reports panel's
// global filter bar (queryFilters) - this section has no filters of its own.
const ToolLogins = ({ filters }) => {
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const params = filters;

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
        subtitle="Every time someone clicked Launch on a tool from the dashboard — who, which tool, the assigned account used, and when. Uses the filters at the top of Reports."
      >
        <div className="ui-head-actions">
          <button type="button" className="rpt-workbook-btn" onClick={download} disabled={busy}>
            {busy ? 'Generating…' : 'Download Excel'}
          </button>
        </div>
      </SectionHeader>

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
