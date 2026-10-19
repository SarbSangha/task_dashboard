import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import ToolLogo, { toolColor } from '../../common/ToolLogo';
import Dropdown from './Dropdown';
import {
  Avatar,
  DeptPill,
  Icon,
  ICONS,
  OutputLink,
  ShareBar,
  Skel,
  fmtINR,
  fmtNum,
  parseToolsUsed,
  sortRows,
} from './shared';

const SORTS = [
  { value: 'spend:desc', label: 'Spend · High → low', key: 'spend', dir: 'desc' },
  { value: 'spend:asc', label: 'Spend · Low → high', key: 'spend', dir: 'asc' },
  { value: 'credits:desc', label: 'Credits · High → low', key: 'credits', dir: 'desc' },
  { value: 'credits:asc', label: 'Credits · Low → high', key: 'credits', dir: 'asc' },
  { value: 'outputs:desc', label: 'Outputs · High → low', key: 'outputs', dir: 'desc' },
  { value: 'outputs:asc', label: 'Outputs · Low → high', key: 'outputs', dir: 'asc' },
  { value: 'tools:desc', label: 'Tools used · Most first', key: 'tools', dir: 'desc' },
  { value: 'tools:asc', label: 'Tools used · Fewest first', key: 'tools', dir: 'asc' },
  { value: 'days:desc', label: 'Active days · Most first', key: 'days', dir: 'desc' },
  { value: 'name:asc', label: 'Name · A → Z', key: 'name', dir: 'asc' },
  { value: 'name:desc', label: 'Name · Z → A', key: 'name', dir: 'desc' },
];

const SORT_COLS = [
  { key: 'spend', num: true, sort: (u) => u.spendRupees },
  { key: 'credits', num: true, sort: (u) => u.credits },
  { key: 'outputs', num: true, sort: (u) => u.generations },
  { key: 'tools', num: true, sort: (u) => (u.toolsUsed || []).length },
  { key: 'days', num: true, sort: (u) => u.activeDays },
  { key: 'name', sort: (u) => u.userName },
];

const MAX_COMPARE = 6;

/**
 * Full "People report": every person with at least one generation in the
 * current selection, with their tool mix, top client and recent outputs.
 */
export default function PeopleReportModal({ open, onClose, users, log, period, loading, onDrill, onOpenOutput, onCompare }) {
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('all');
  const [sortKey, setSortKey] = useState('spend:desc');
  const [expanded, setExpanded] = useState(null);
  const [picked, setPicked] = useState([]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const people = useMemo(() => (users || []).filter((u) => Number(u.generations) > 0), [users]);

  const deptOptions = useMemo(() => {
    const counts = new Map();
    people.forEach((u) => counts.set(u.department, (counts.get(u.department) || 0) + 1));
    return [
      { value: 'all', label: 'All departments', meta: people.length },
      ...[...counts.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([d, n]) => ({ value: d, label: d, meta: n })),
    ];
  }, [people]);

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const filtered = people.filter(
      (u) =>
        (dept === 'all' || u.department === dept) &&
        (!needle || `${u.userName} ${u.department} ${u.toolsUsedText} ${u.topClient}`.toLowerCase().includes(needle))
    );
    const s = SORTS.find((o) => o.value === sortKey);
    return sortRows(filtered, SORT_COLS, s ? { key: s.key, dir: s.dir } : null);
  }, [people, q, dept, sortKey]);

  const totals = useMemo(
    () =>
      rows.reduce(
        (acc, u) => ({
          outputs: acc.outputs + Number(u.generations || 0),
          credits: acc.credits + Number(u.credits || 0),
          spend: acc.spend + Number(u.spendRupees || 0),
        }),
        { outputs: 0, credits: 0, spend: 0 }
      ),
    [rows]
  );

  const logByUser = useMemo(() => {
    const map = new Map();
    (log || []).forEach((r) => {
      if (!map.has(r.userId)) map.set(r.userId, []);
      map.get(r.userId).push(r);
    });
    return map;
  }, [log]);

  const togglePick = (id) =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : prev.length >= MAX_COMPARE ? prev : [...prev, id]));

  const exportCsv = () => {
    const headers = ['Person', 'Department', 'Tools used', 'Top client', 'Outputs', 'Active days', 'Credits', 'Spent (₹)', 'Per output (₹)', 'Share %'];
    const lines = [
      headers.join(','),
      ...rows.map((u) =>
        [u.userName, u.department, u.toolsUsedText, u.topClient, u.generations, u.activeDays, u.credits, u.spendRupees, u.avgSpendPerOutput, u.sharePct]
          .map((v) => `"${v == null ? '' : String(v).replace(/"/g, '""')}"`)
          .join(',')
      ),
    ];
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `RMW_people_${period?.start || ''}_to_${period?.end || ''}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  if (!open) return null;

  return createPortal(
    <div className="zpm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="zpm" role="dialog" aria-modal="true" aria-labelledby="zpm-title">
        <header className="zpm-head">
          <div className="zpm-title">
            <span className="zpm-title-icon">
              <Icon d={ICONS.people} size={20} />
            </span>
            <div>
              <h3 id="zpm-title">People report</h3>
              <p>
                Everyone who generated something{period?.label ? ` · ${period.label}` : ''}
              </p>
            </div>
          </div>
          <button type="button" className="zrs-icon-btn" onClick={onClose} aria-label="Close">
            <Icon d={ICONS.close} />
          </button>
        </header>

        <section className="zpm-stats">
          {[
            ['People', loading ? null : fmtNum(rows.length)],
            ['Outputs', loading ? null : fmtNum(totals.outputs)],
            ['Credits', loading ? null : fmtNum(totals.credits)],
            ['Spent', loading ? null : fmtINR(totals.spend)],
            ['Per person', loading ? null : fmtINR(rows.length ? totals.spend / rows.length : 0)],
          ].map(([label, val]) => (
            <div key={label} className="zpm-stat">
              <span>{label}</span>
              {val == null ? <Skel w="70%" h={20} r={6} /> : <b>{val}</b>}
            </div>
          ))}
        </section>

        <section className="zpm-tools">
          <label className="zrs-search zpm-search">
            <Icon d={ICONS.search} size={16} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, tools, clients…" />
            {q && (
              <button type="button" className="zrs-search-clear" onClick={() => setQ('')} aria-label="Clear search">
                ×
              </button>
            )}
          </label>
          <Dropdown value={dept} options={deptOptions} onChange={setDept} label="Department" searchable />
          <Dropdown
            value={sortKey}
            options={SORTS}
            onChange={setSortKey}
            label="Sort people"
            align="right"
            menuWidth={240}
          />
          <button type="button" className="zrs-btn" onClick={exportCsv} disabled={!rows.length}>
            <Icon d={ICONS.download} size={15} />
            CSV
          </button>
        </section>

        {picked.length > 0 && (
          <div className="zpm-compare-bar">
            <span>
              {picked.length} selected to compare{picked.length >= MAX_COMPARE ? ` (max ${MAX_COMPARE})` : ''}
            </span>
            <button type="button" className="zrs-reset" onClick={() => setPicked([])}>
              Clear
            </button>
            <button
              type="button"
              className="zrs-btn primary"
              disabled={picked.length < 2}
              onClick={() => onCompare(picked)}
              title={picked.length < 2 ? 'Pick at least two people' : 'Compare side by side'}
            >
              <Icon d={ICONS.compare} size={15} />
              Compare {picked.length}
            </button>
          </div>
        )}

        <div className="zpm-body">
          {loading ? (
            <ul className="zpm-list">
              {Array.from({ length: 7 }).map((_, i) => (
                <li key={i} className="zpm-row skel">
                  <Skel w={18} h={18} r={5} />
                  <Skel w={34} h={34} r={999} />
                  <div className="zpm-skel-lines">
                    <Skel w={`${40 + ((i * 17) % 30)}%`} h={11} />
                    <Skel w={`${25 + ((i * 11) % 25)}%`} h={9} />
                  </div>
                  <Skel w={70} h={11} />
                  <Skel w={70} h={11} />
                  <Skel w={90} h={11} />
                </li>
              ))}
            </ul>
          ) : rows.length === 0 ? (
            <div className="zrs-empty">No one matches this selection.</div>
          ) : (
            <ul className="zpm-list">
              {rows.map((u, idx) => {
                const id = u.userId;
                const isOpen = expanded === id;
                const tools = parseToolsUsed(u.toolsUsed);
                const toolTotal = tools.reduce((s, t) => s + t.count, 0) || 1;
                const recent = (logByUser.get(id) || []).slice(0, 8);
                return (
                  <li key={id ?? u.userName} className={`zpm-row-wrap${isOpen ? ' open' : ''}`}>
                    <div className="zpm-row">
                      <input
                        type="checkbox"
                        className="zpm-pick"
                        checked={picked.includes(id)}
                        onChange={() => togglePick(id)}
                        aria-label={`Select ${u.userName} to compare`}
                        disabled={!picked.includes(id) && picked.length >= MAX_COMPARE}
                      />
                      <span className="zpm-rank">{idx + 1}</span>
                      <button
                        type="button"
                        className="zpm-who"
                        onClick={() => setExpanded(isOpen ? null : id)}
                        aria-expanded={isOpen}
                      >
                        <Avatar name={u.userName} size={34} />
                        <span className="zpm-who-text">
                          <b>{u.userName}</b>
                          <span>
                            <DeptPill name={u.department} />
                          </span>
                        </span>
                      </button>
                      <span className="zpm-toolmix" title={u.toolsUsedText}>
                        <span className="zpm-mixbar">
                          {tools.map((t) => (
                            <i key={t.tool} style={{ width: `${(t.count / toolTotal) * 100}%`, background: toolColor(t.tool) }} />
                          ))}
                        </span>
                        <span className="zpm-logos">
                          {tools.slice(0, 4).map((t) => (
                            <ToolLogo key={t.tool} name={t.tool} size={16} />
                          ))}
                          {tools.length > 4 && <small>+{tools.length - 4}</small>}
                        </span>
                      </span>
                      <span className="zpm-metric">
                        <b>{fmtNum(u.generations)}</b>
                        <small>outputs</small>
                      </span>
                      <span className="zpm-metric">
                        <b>{fmtNum(u.credits)}</b>
                        <small>credits</small>
                      </span>
                      <span className="zpm-metric money">
                        <b>{fmtINR(u.spendRupees)}</b>
                        <small>{fmtNum(u.sharePct)}% of spend</small>
                      </span>
                      <button
                        type="button"
                        className={`zpm-expand${isOpen ? ' on' : ''}`}
                        onClick={() => setExpanded(isOpen ? null : id)}
                        aria-label={isOpen ? 'Hide details' : 'Show details'}
                      >
                        <Icon d={ICONS.chevron} size={18} />
                      </button>
                    </div>

                    {isOpen && (
                      <div className="zpm-detail">
                        <div className="zpm-detail-grid">
                          <div className="zpm-facts">
                            <div>
                              <span>Active days</span>
                              <b>{u.activeDays}</b>
                            </div>
                            <div>
                              <span>Outputs / active day</span>
                              <b>{fmtNum(u.avgGenerationsPerActiveDay)}</b>
                            </div>
                            <div>
                              <span>Per output</span>
                              <b>{fmtINR(u.avgSpendPerOutput)}</b>
                            </div>
                            <div>
                              <span>Spend / month</span>
                              <b>{fmtINR(u.avgSpendPerMonth)}</b>
                            </div>
                            <div>
                              <span>Top client</span>
                              <b>{u.topClient}</b>
                            </div>
                            <div>
                              <span>What they made</span>
                              <b className="wrap">{u.whatGeneratedSummary}</b>
                            </div>
                          </div>
                          <div className="zpm-tool-bars">
                            <h5>Tool mix</h5>
                            {tools.length === 0 && <span className="zrs-muted">No tool data</span>}
                            {tools.map((t) => (
                              <div key={t.tool} className="zpm-tool-bar">
                                <span className="name">
                                  <ToolLogo name={t.tool} size={14} />
                                  {t.tool}
                                </span>
                                <span className="track">
                                  <i style={{ width: `${(t.count / toolTotal) * 100}%`, background: toolColor(t.tool) }} />
                                </span>
                                <span className="val">{fmtNum(t.count)}</span>
                              </div>
                            ))}
                            <ShareBar pct={u.sharePct} />
                          </div>
                        </div>

                        <div className="zpm-recent">
                          <h5>Recent generations</h5>
                          {recent.length === 0 ? (
                            <span className="zrs-muted">None in the loaded activity.</span>
                          ) : (
                            <ul>
                              {recent.map((r) => (
                                <li key={`${r.tool}-${r.recordId}`}>
                                  <ToolLogo name={r.tool} size={16} />
                                  <span className="when">
                                    {r.date} · {r.time}
                                  </span>
                                  <span className="what">
                                    <b>{r.outputType}</b>
                                    <span title={r.prompt}>{r.prompt}</span>
                                  </span>
                                  <span className="cost">{fmtINR(r.spendRupees)}</span>
                                  <OutputLink row={r} onOpen={onOpenOutput} />
                                </li>
                              ))}
                            </ul>
                          )}
                          <button type="button" className="zrs-link" onClick={() => onDrill({ user: id })}>
                            View all of {u.userName.split(' ')[0]}'s activity →
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
