import React, { useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { reportsAPI } from '../../../services/reports';
import SectionHeader from '../primitives/SectionHeader';
import DataTable from '../primitives/DataTable';
import { formatNumber, formatFull, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';
import PromptDetailModal from './PromptDetailModal';

const UserCell = ({ row }) => (
  <span className="rpt-user-cell">
    {row.avatar
      ? <img className="rpt-user-av" src={row.avatar} alt="" />
      : <span className="rpt-user-av">{initialsOf(row.name)}</span>}
    <span>{row.name}</span>
  </span>
);

const dayLabel = (iso) => (iso
  ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
  : '—');
const timeLabel = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');

const reusePill = (rate) => {
  const cls = rate >= 30 ? 'good' : rate >= 10 ? 'warn' : 'muted';
  return <span className={`rpt-pill ${cls}`}>{rate}%</span>;
};

// Level 4 — the actual prompt texts, grouped so a prompt used ten times is one
// row with a use count.
const PromptList = ({ userId, userName, date, repeatedOnly, filters, onAddToCanvas, onClose }) => {
  const [openPrompt, setOpenPrompt] = useState(null);
  const q = useQuery({
    queryKey: ['reports', 'prompts', 'list', userId, date || '', repeatedOnly ? 'reused' : 'all', filters],
    queryFn: () => reportsAPI.promptsList({ ...filters, userId, date, repeatedOnly, limit: 200 }),
    staleTime: 60_000,
  });

  const prompts = q.data?.prompts || [];
  const totals = q.data?.totals || {};
  const heading = repeatedOnly ? `Reused prompts — ${userName || 'user'}` : `Prompts on ${dayLabel(date)}`;

  return (
    <div className="rpt-card" style={{ marginTop: 12, borderLeft: '3px solid var(--color-primary)' }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title" style={{ fontSize: 14 }}>{heading}</h3>
        <span className="rpt-card-hint">
          {formatNumber(totals.distinct)} distinct · {formatNumber(totals.uses)} uses
        </span>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add these prompts to the Report Builder"
            onClick={() => onAddToCanvas(
              { kind: 'live-prompt-list', userId, userName, date, repeatedOnly },
              repeatedOnly ? `Reused prompts — ${userName || 'user'}` : `Prompts — ${userName || 'user'}`,
            )}
          />
        )}
        {onClose && <button className="rpt-mini-btn" onClick={onClose}>Close</button>}
      </div>

      {q.isLoading && <p className="rpt-kpi-prev">Loading prompts…</p>}
      {q.isError && <p className="rpt-error">Failed to load: {q.error?.response?.data?.detail || q.error?.message}</p>}
      {!q.isLoading && !q.isError && prompts.length === 0 && (
        <p className="rpt-kpi-prev">{repeatedOnly ? 'This person never reused a prompt.' : 'No prompts that day.'}</p>
      )}

      {prompts.length > 0 && (
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '6px 4px', width: 52 }}>Uses</th>
                <th style={{ padding: '6px 4px' }}>Prompt</th>
                <th style={{ padding: '6px 4px', textAlign: 'right', width: 66 }}>Credits</th>
                <th style={{ padding: '6px 4px', width: 96 }}>Window</th>
              </tr>
            </thead>
            <tbody>
              {prompts.map((p) => (
                <tr
                  key={p.rank}
                  onClick={() => setOpenPrompt(p)}
                  style={{ borderTop: '1px solid var(--color-border)', cursor: 'pointer' }}
                  title="See who used this prompt and what it produced"
                >
                  <td style={{ padding: '6px 4px' }}>
                    <span className={`rpt-pill ${p.uses > 1 ? 'warn' : 'muted'}`}>{p.uses}×</span>
                  </td>
                  <td style={{ padding: '6px 4px', lineHeight: 1.45 }}>
                    {p.prompt.slice(0, 260)}{p.prompt.length > 260 ? '…' : ''}
                  </td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(p.credits)}</td>
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{timeLabel(p.firstAt)}–{timeLabel(p.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openPrompt && (
        <PromptDetailModal
          promptHash={openPrompt.promptHash}
          promptText={openPrompt.prompt}
          filters={filters}
          onClose={() => setOpenPrompt(null)}
          onAddToCanvas={onAddToCanvas}
        />
      )}
    </div>
  );
};

// Level 3 — the days this person prompted on. Clicking a date lists the prompts.
const PromptTimeline = ({ userId, userName, filters, onAddToCanvas }) => {
  const [openDate, setOpenDate] = useState(null);
  const q = useQuery({
    queryKey: ['reports', 'prompts', 'user-timeline', userId, filters],
    queryFn: () => reportsAPI.promptsUserTimeline({ ...filters, userId }),
    staleTime: 60_000,
  });

  const rows = q.data?.timeline || [];
  const totals = q.data?.totals || {};

  return (
    <div className="rpt-card" style={{ marginTop: 18 }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title">Prompt timeline</h3>
        <span className="rpt-card-hint">
          {totals.days
            ? `${totals.days} days · ${formatNumber(totals.prompts)} prompts · ${formatNumber(totals.uniquePrompts)} unique · click a date`
            : 'Days this person prompted on'}
        </span>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add this prompt timeline to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-prompt-timeline', userId, userName }, `Prompt timeline — ${userName || 'user'}`)}
          />
        )}
      </div>

      {q.isLoading && <p className="rpt-kpi-prev">Loading prompt timeline…</p>}
      {q.isError && <p className="rpt-error">Failed to load: {q.error?.response?.data?.detail || q.error?.message}</p>}
      {!q.isLoading && !q.isError && rows.length === 0 && <p className="rpt-kpi-prev">No prompts recorded.</p>}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '6px 4px' }}>Date</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Prompts</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Unique</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Reused</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Reuse rate</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Avg length</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.date}
                  onClick={() => setOpenDate(openDate === r.date ? null : r.date)}
                  style={{
                    borderTop: '1px solid var(--color-border)',
                    cursor: 'pointer',
                    background: openDate === r.date ? 'var(--color-secondary)' : undefined,
                  }}
                  title="See the prompts written that day"
                >
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{dayLabel(r.date)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}><b>{formatNumber(r.prompts)}</b></td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.uniquePrompts)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.reusedPrompts)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{reusePill(r.reuseRate)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.avgLength)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openDate && (
        <PromptList
          userId={userId}
          userName={userName}
          date={openDate}
          onAddToCanvas={onAddToCanvas}
          onClose={() => setOpenDate(null)}
        />
      )}
    </div>
  );
};

// Level 2 — who wrote the prompts. `mode` decides what opening a person shows:
// 'volume' goes to their day-by-day timeline, 'reuse' goes straight to the
// prompts they actually repeated (which is the question that card asks).
const PromptDrill = ({ mode = 'volume', filters, onAddToCanvas }) => {
  const [openUser, setOpenUser] = useState(null);
  const q = useQuery({
    queryKey: ['reports', 'prompts', 'contributors', filters],
    queryFn: () => reportsAPI.promptsContributors({ ...filters, limit: 200 }),
    placeholderData: keepPreviousData,
    staleTime: 60_000,
  });

  const users = q.data?.users || [];
  const totals = q.data?.totals || {};
  const isReuse = mode === 'reuse';
  const title = isReuse ? 'Prompt Reuse by Person' : 'Prompts by Person';

  const columns = [
    { key: 'rank', label: '#', sortable: false, render: (r) => <span className={`rpt-rank ${r.rank <= 3 ? 'top' : ''}`}>{r.rank}</span> },
    { key: 'name', label: 'User', render: (r) => <UserCell row={r} /> },
    { key: 'department', label: 'Department', render: (r) => <span className="rpt-pill muted">{r.department}</span> },
    { key: 'prompts', label: 'Prompts', num: true, render: (r) => formatNumber(r.prompts) },
    { key: 'uniquePrompts', label: 'Unique', num: true, render: (r) => formatNumber(r.uniquePrompts) },
    { key: 'reusedPrompts', label: 'Reused', num: true, render: (r) => formatNumber(r.reusedPrompts) },
    { key: 'reuseRate', label: 'Reuse rate', num: true, render: (r) => reusePill(r.reuseRate) },
    { key: 'avgLength', label: 'Avg length', num: true, render: (r) => formatNumber(r.avgLength) },
  ];

  if (q.isError) {
    return (
      <div>
        <SectionHeader title={title} />
        <div className="rpt-error">Failed to load: {q.error?.response?.data?.detail || q.error?.message}</div>
      </div>
    );
  }

  return (
    <div>
      <SectionHeader
        title={title}
        subtitle={isReuse
          ? 'Who leans on proven prompts instead of rewriting every time — click a person to see the prompts they actually reused.'
          : 'Who wrote the prompts in this period — click a person for their day-by-day activity, then a date for the prompts themselves.'}
      >
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add this prompt table to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-prompt-contributors', mode }, title)}
          />
        )}
      </SectionHeader>

      {q.isLoading ? (
        <div className="rpt-card" style={{ padding: 16 }}>Loading prompt authors…</div>
      ) : users.length === 0 ? (
        <div className="rpt-card" style={{ padding: 16 }}>No prompts in this period.</div>
      ) : (
        <>
          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 14 }}>{users.length} people</h3>
            <span className="rpt-card-hint">
              {formatNumber(totals.prompts)} prompts · {formatNumber(totals.uniquePrompts)} unique · {totals.reuseRate}% reuse
            </span>
          </div>
          <DataTable
            columns={columns}
            rows={users}
            initialSort={isReuse ? 'reuseRate' : 'prompts'}
            onRowClick={(row) => setOpenUser(openUser?.userId === row.userId ? null : row)}
          />

          {openUser && (isReuse ? (
            <PromptList
              userId={openUser.userId}
              userName={openUser.name}
              repeatedOnly
              filters={filters}
              onAddToCanvas={onAddToCanvas}
              onClose={() => setOpenUser(null)}
            />
          ) : (
            <PromptTimeline
              userId={openUser.userId}
              userName={openUser.name}
              filters={filters}
              onAddToCanvas={onAddToCanvas}
            />
          ))}
        </>
      )}
    </div>
  );
};

export default PromptDrill;
