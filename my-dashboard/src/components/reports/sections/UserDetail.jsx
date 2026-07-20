import React, { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { generationRecordsAPI } from '../../../services/api';
import { reportsAPI } from '../../../services/reports';
import { formatNumber, formatFull, initialsOf } from '../utils/format';
import { ToCanvasButton } from './ExecutiveDashboard';

const daysSince = (iso) => {
  if (!iso) return Infinity;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return Infinity;
  return Math.floor((Date.now() - dt.getTime()) / 86_400_000);
};

// Transparent, derived 0–100 indices (not stored metrics).
const engagementScore = (p) => {
  const vol = Math.min(60, Math.round(Math.pow(p.totalGenerations || 0, 0.6) * 6));
  const d = daysSince(p.lastActivityAt);
  const recency = d <= 2 ? 40 : d <= 7 ? 30 : d <= 30 ? 18 : 6;
  return Math.min(100, vol + recency);
};
const maturityScore = (p) => {
  const total = p.totalGenerations || 0;
  if (!total) return 0;
  const videoRatio = (p.videoCount || 0) / total; // richer/video output
  const projects = Math.min(1, (p.topProjects?.length || 0) / 5);
  const tags = Math.min(1, (p.topTags?.length || 0) / 8);
  return Math.round(videoRatio * 40 + projects * 30 + tags * 30);
};

const Meter = ({ value, tone = 'primary' }) => {
  const color = tone === 'success' ? 'var(--color-success)' : tone === 'warning' ? 'var(--color-warning)' : 'var(--color-primary)';
  return (
    <div style={{ height: 8, borderRadius: 6, background: 'var(--color-secondary)', overflow: 'hidden', marginTop: 8 }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: '100%', background: color, borderRadius: 6 }} />
    </div>
  );
};

const lastActiveLabel = (iso) => {
  const d = daysSince(iso);
  if (d === Infinity) return 'No recent activity';
  if (d === 0) return 'Active today';
  if (d === 1) return 'Active yesterday';
  return `Active ${d} days ago`;
};

// `mode` decides what level 3 means: 'activity' (from Active Users) shows the
// login timeline; 'output' (from Generations / Videos / Images / Cost) shows the
// days they generated on; 'chat' (from ChatGPT) shows when they actually chatted.
const UserDetail = ({ userId, userName, onBack, onAddToCanvas, mode = 'activity', provider, focusDate }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'userProfile', userId],
    queryFn: () => generationRecordsAPI.getUserProfile(userId),
    enabled: !!userId,
    staleTime: 60_000,
  });

  const p = data?.data;
  const eng = useMemo(() => (p ? engagementScore(p) : 0), [p]);
  const mat = useMemo(() => (p ? maturityScore(p) : 0), [p]);

  return (
    <div>
      <button className="rpt-back-btn" onClick={onBack}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M15 18l-6-6 6-6" /></svg>
        Back
      </button>

      {isLoading && !p ? (
        <div className="rpt-loading">Loading user profile…</div>
      ) : isError ? (
        <div className="rpt-error">Failed to load profile: {error?.response?.data?.detail || error?.message}</div>
      ) : !p ? (
        <div className="rpt-loading">No profile found for {userName || `user #${userId}`}.</div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
            {p.avatar
              ? <img className="rpt-user-av" style={{ width: 52, height: 52 }} src={p.avatar} alt="" />
              : <span className="rpt-user-av" style={{ width: 52, height: 52, fontSize: 18 }}>{initialsOf(p.name)}</span>}
            <div>
              <h2 className="rpt-sec-title" style={{ fontSize: 22 }}>{p.name}</h2>
              <p className="rpt-sec-sub" style={{ marginTop: 2 }}>
                <span className="rpt-pill muted">{p.department || 'Unassigned'}</span>{' '}
                {p.topModel && <span className="rpt-pill muted">Top model · {p.topModel}</span>}{' '}
                <span style={{ marginLeft: 6, fontSize: 12 }}>{lastActiveLabel(p.lastActivityAt)}</span>
              </p>
            </div>
          </div>

          <div className="rpt-kpi-grid">
            <div className="rpt-kpi"><div className="rpt-kpi-label">Total Generations</div><div className="rpt-kpi-value">{formatNumber(p.totalGenerations)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Videos</div><div className="rpt-kpi-value">{formatNumber(p.videoCount)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Images</div><div className="rpt-kpi-value">{formatNumber(p.imageCount)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Credits Consumed</div><div className="rpt-kpi-value">{formatFull(p.creditsBurned)}</div></div>
            <div className="rpt-kpi">
              <div className="rpt-kpi-label">Engagement Score</div>
              <div className="rpt-kpi-value">{eng}<span className="unit">/100</span></div>
              <Meter value={eng} tone="success" />
            </div>
            <div className="rpt-kpi">
              <div className="rpt-kpi-label">AI Maturity Score</div>
              <div className="rpt-kpi-value">{mat}<span className="unit">/100</span></div>
              <Meter value={mat} tone="primary" />
            </div>
          </div>

          <div className="rpt-grid cols-2">
            <div className="rpt-card">
              <div className="rpt-card-head"><h3 className="rpt-card-title">Top projects</h3></div>
              {(p.topProjects || []).length ? (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8 }}>
                  {p.topProjects.map((proj) => (
                    <li key={proj.projectId} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                      <span>{proj.name || 'Untitled project'}</span>
                      <b style={{ fontVariantNumeric: 'tabular-nums' }}>{formatNumber(proj.count)}</b>
                    </li>
                  ))}
                </ul>
              ) : <p className="rpt-kpi-prev">No project activity yet.</p>}
            </div>

            <div className="rpt-card">
              <div className="rpt-card-head"><h3 className="rpt-card-title">Signature styles (tags)</h3></div>
              {(p.topTags || []).length ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {p.topTags.map((t) => (
                    <span key={t.tag} className="rpt-pill muted">{t.tag} · {t.count}</span>
                  ))}
                </div>
              ) : <p className="rpt-kpi-prev">No tags recorded.</p>}
            </div>
          </div>

          <p className="rpt-kpi-prev" style={{ marginTop: 14 }}>
            Engagement &amp; AI-maturity are derived indices (volume, recency, output richness and project/style diversity) — directional signals, not stored scores.
          </p>
        </>
      )}

      {mode === 'chat' ? (
        <ChatTimeline userId={userId} userName={userName} focusDate={focusDate} onAddToCanvas={onAddToCanvas} />
      ) : mode === 'output' ? (
        <GenerationTimeline userId={userId} userName={userName} provider={provider} focusDate={focusDate} onAddToCanvas={onAddToCanvas} />
      ) : (
        <LoginTimeline userId={userId} userName={userName} focusDate={focusDate} onAddToCanvas={onAddToCanvas} />
      )}
    </div>
  );
};

// Level 5 — the actual message thread of one conversation.
const ChatThread = ({ conversationId }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'chatgpt', 'messages', conversationId],
    queryFn: () => reportsAPI.chatgptConversationMessages({ conversationId }),
    enabled: !!conversationId,
    staleTime: 60_000,
  });

  const messages = data?.messages || [];

  if (isLoading) return <p className="rpt-kpi-prev" style={{ padding: '8px 10px' }}>Loading messages…</p>;
  if (isError) {
    return (
      <p className="rpt-error" style={{ padding: '8px 10px' }}>
        Failed to load messages: {error?.response?.data?.detail || error?.message}
      </p>
    );
  }
  if (messages.length === 0) {
    return <p className="rpt-kpi-prev" style={{ padding: '8px 10px' }}>No message content captured for this chat.</p>;
  }

  return (
    <div className="rpt-chat-thread">
      {messages.map((m, i) => (
        <div key={i} className={`rpt-chat-msg ${m.role}`}>
          <span className="rpt-chat-role">{m.role === 'user' ? 'Prompt' : 'Response'}</span>
          <div className="rpt-chat-body">
            {m.text || <span className="rpt-muted">(empty)</span>}
            {m.truncated && (
              <span className="rpt-muted"> … truncated ({formatNumber(m.length)} chars)</span>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};

// Level 4 of the chat drill — the individual conversations from one day.
const ChatDayDetail = ({ userId, userName, date, onClose, onAddToCanvas }) => {
  const [openChat, setOpenChat] = useState(null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'chatgpt', 'conversations', userId, date],
    queryFn: () => reportsAPI.chatgptConversations({ userId, date }),
    enabled: !!userId && !!date,
    staleTime: 60_000,
  });

  const convos = data?.conversations || [];
  const t = data?.totals || {};
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
  const dayName = date
    ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })
    : '';

  return (
    <div className="rpt-card" style={{ marginTop: 12, borderLeft: '3px solid var(--color-primary)' }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title" style={{ fontSize: 14 }}>{dayName}</h3>
        <span className="rpt-card-hint">
          {formatNumber(t.conversations)} chats · {formatNumber(t.prompts)} prompts · {formatNumber(t.messages)} messages
        </span>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Chats to canvas"
            title="Add this day's chat list to the Report Builder"
            onClick={() => onAddToCanvas(
              { kind: 'live-chat-day', userId, userName, date },
              `Chats — ${userName || 'user'}, ${date}`,
            )}
          />
        )}
        <button className="rpt-mini-btn" onClick={onClose}>Close</button>
      </div>

      {isLoading && <p className="rpt-kpi-prev">Loading chats…</p>}
      {isError && <p className="rpt-error">Failed to load: {error?.response?.data?.detail || error?.message}</p>}
      {!isLoading && !isError && convos.length === 0 && <p className="rpt-kpi-prev">No chats that day.</p>}

      {convos.length > 0 && (
        <div style={{ maxHeight: 300, overflowY: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '4px', width: 56 }}>Time</th>
                <th style={{ padding: '4px' }}>Chat</th>
                <th style={{ padding: '4px' }}>Model</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Prompts</th>
                <th style={{ padding: '4px', textAlign: 'right' }}>Messages</th>
                <th style={{ padding: '4px', width: 78 }} aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {convos.map((c) => (
                <React.Fragment key={c.conversationId}>
                  <tr
                    onClick={() => setOpenChat(openChat === c.conversationId ? null : c.conversationId)}
                    style={{
                      borderTop: '1px solid var(--color-border)',
                      cursor: 'pointer',
                      background: openChat === c.conversationId ? 'var(--color-secondary)' : undefined,
                    }}
                    title="Read the messages in this chat"
                  >
                    <td style={{ padding: '4px', whiteSpace: 'nowrap' }}>{time(c.time)}</td>
                    <td style={{ padding: '4px' }}>
                      <span style={{ marginRight: 6, opacity: 0.5 }}>{openChat === c.conversationId ? '▾' : '▸'}</span>
                      {c.title}
                      {c.url && (
                        <a
                          href={c.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          onClick={(e) => e.stopPropagation()}
                          style={{ marginLeft: 6, fontSize: 11 }}
                        >
                          ↗
                        </a>
                      )}
                    </td>
                    <td style={{ padding: '4px' }}>{c.model || '—'}</td>
                    <td style={{ padding: '4px', textAlign: 'right' }}>{formatNumber(c.prompts)}</td>
                    <td style={{ padding: '4px', textAlign: 'right' }}>{formatNumber(c.messages)}</td>
                    <td style={{ padding: '4px', textAlign: 'right' }}>
                      {onAddToCanvas && (
                        <button
                          className="rpt-mini-btn"
                          title="Add this chat's messages to the Report Builder"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddToCanvas(
                              { kind: 'live-chat-messages', conversationId: c.conversationId, userName, title: c.title, date },
                              `Chat messages — ${c.title}`,
                            );
                          }}
                        >
                          + canvas
                        </button>
                      )}
                    </td>
                  </tr>
                  {openChat === c.conversationId && (
                    <tr>
                      <td colSpan={6} style={{ padding: '4px 4px 10px' }}>
                        <ChatThread conversationId={c.conversationId} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// Level 3 for a ChatGPT user: when they actually chatted, not when they logged in.
const ChatTimeline = ({ userId, userName, focusDate, onAddToCanvas }) => {
  const [openDate, setOpenDate] = useState(focusDate || null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'chatgpt', 'user-timeline', userId],
    queryFn: () => reportsAPI.chatgptUserTimeline({ userId }),
    enabled: !!userId,
    staleTime: 60_000,
  });

  const rows = data?.timeline || [];
  const totals = data?.totals || {};
  const day = (iso) => (iso
    ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' })
    : '—');
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
  const peak = rows.reduce((m, r) => Math.max(m, r.conversations || 0), 0);

  return (
    <div className="rpt-card" style={{ marginTop: 18 }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title">Chat timeline</h3>
        <span className="rpt-card-hint">
          {totals.days
            ? `${totals.days} days · ${formatNumber(totals.conversations)} chats · ${formatNumber(totals.messages)} messages · click a date`
            : 'Days this person chatted'}
        </span>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add this chat timeline to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-chat-timeline', userId, userName }, `Chat timeline — ${userName || 'user'}`)}
          />
        )}
      </div>

      {isLoading && <p className="rpt-kpi-prev">Loading chat timeline…</p>}
      {isError && <p className="rpt-error">Failed to load: {error?.response?.data?.detail || error?.message}</p>}
      {!isLoading && !isError && rows.length === 0 && <p className="rpt-kpi-prev">No ChatGPT activity recorded.</p>}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '6px 4px' }}>Date</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Chats</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Prompts</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Messages</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Avg depth</th>
                <th style={{ padding: '6px 4px' }}>Chat window</th>
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
                  title="See the chats from this day"
                >
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{day(r.date)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      <span
                        aria-hidden="true"
                        style={{
                          display: 'inline-block', height: 6, borderRadius: 3,
                          width: peak ? `${Math.max(6, (r.conversations / peak) * 52)}px` : 0,
                          background: 'var(--color-primary)', opacity: 0.55,
                        }}
                      />
                      <b>{formatNumber(r.conversations)}</b>
                    </span>
                  </td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.prompts)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.messages)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(r.avgDepth)}</td>
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{time(r.firstAt)} – {time(r.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openDate && (
        <ChatDayDetail
          userId={userId}
          userName={userName}
          date={openDate}
          onClose={() => setOpenDate(null)}
          onAddToCanvas={onAddToCanvas}
        />
      )}
    </div>
  );
};

// Level 3 when you arrive from an output KPI: the days this person actually
// generated on, and what each day produced. Clicking a date opens the same
// day panel as the login timeline.
const GenerationTimeline = ({ userId, userName, provider, focusDate, onAddToCanvas }) => {
  // Arriving from a day on the trend chart, open that day straight away.
  const [openDate, setOpenDate] = useState(focusDate || null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'user', 'gen-timeline', userId, provider || 'all'],
    queryFn: () => reportsAPI.userGenerationTimeline({ userId, provider }),
    enabled: !!userId,
    staleTime: 60_000,
  });

  const rows = data?.timeline || [];
  const totals = data?.totals || {};
  const day = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' }) : '—');
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
  const peak = rows.reduce((m, r) => Math.max(m, r.generations || 0), 0);

  return (
    <div className="rpt-card" style={{ marginTop: 18 }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title">Generation timeline</h3>
        <span className="rpt-card-hint">
          {totals.days
            ? `${totals.days} generating days · ${formatNumber(totals.generations)} generations · ${formatFull(totals.credits)} credits · click a date for that day`
            : 'Days this person generated on'}
        </span>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title={`Add ${userName || 'this user'}'s generation timeline to the Report Builder`}
            onClick={() => onAddToCanvas({ kind: 'live-user-generations', userId, userName, provider }, `Generation timeline — ${userName || 'user'}`)}
          />
        )}
      </div>

      {isLoading && <p className="rpt-kpi-prev">Loading generation timeline…</p>}
      {isError && <p className="rpt-error">Failed to load: {error?.response?.data?.detail || error?.message}</p>}
      {!isLoading && !isError && rows.length === 0 && <p className="rpt-kpi-prev">No generations recorded for this person.</p>}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '6px 4px' }}>Date</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Generations</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Videos</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Images</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Credits</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Avg / gen</th>
                <th style={{ padding: '6px 4px' }}>Window</th>
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
                  title="See this day's generations and credits"
                >
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{day(r.date)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                      <span
                        aria-hidden="true"
                        style={{
                          display: 'inline-block', height: 6, borderRadius: 3,
                          width: peak ? `${Math.max(6, (r.generations / peak) * 56)}px` : 0,
                          background: 'var(--color-primary)', opacity: 0.55,
                        }}
                      />
                      <b>{formatNumber(r.generations)}</b>
                    </span>
                  </td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.videos)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatNumber(r.images)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(r.credits)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(r.avgCredits)}</td>
                  <td style={{ padding: '6px 4px', whiteSpace: 'nowrap' }}>{time(r.firstAt)} – {time(r.lastAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {openDate && (
        <DayDetail
          userId={userId}
          userName={userName}
          date={openDate}
          provider={provider}
          onClose={() => setOpenDate(null)}
          onAddToCanvas={onAddToCanvas}
        />
      )}
    </div>
  );
};

// What this person actually did on one specific day.
const DayDetail = ({ userId, userName, date, provider, onClose, onAddToCanvas }) => {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'user', 'day', userId, date, provider || 'all'],
    queryFn: () => reportsAPI.userDay({ userId, date, provider }),
    enabled: !!userId && !!date,
    staleTime: 60_000,
  });

  const d = data || {};
  const t = d.totals || {};
  const act = d.activity || {};
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
  const dayLabel = date ? new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }) : '';

  return (
    <div className="rpt-card" style={{ marginTop: 12, borderLeft: '3px solid var(--color-primary)' }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title" style={{ fontSize: 14 }}>{dayLabel}</h3>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title="Add this day's tasks, tool usage and generations to the Report Builder"
            onClick={() => onAddToCanvas({ kind: 'live-user-day', userId, userName, date, provider }, `Day detail — ${userName || 'user'}, ${date}`)}
          />
        )}
        <button className="rpt-mini-btn" onClick={onClose}>Close</button>
      </div>

      {isLoading && <p className="rpt-kpi-prev">Loading day…</p>}
      {isError && <p className="rpt-error">Failed to load: {error?.response?.data?.detail || error?.message}</p>}

      {!isLoading && !isError && (
        <>
          <div className="rpt-kpi-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 12 }}>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Session</div><div className="rpt-kpi-value">{formatFull(act.sessionMinutes || 0)}<span className="unit">min</span></div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Generations</div><div className="rpt-kpi-value">{formatNumber(t.generations || 0)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Credits</div><div className="rpt-kpi-value">{formatFull(t.credits || 0)}</div></div>
            <div className="rpt-kpi"><div className="rpt-kpi-label">Task actions</div><div className="rpt-kpi-value">{formatNumber((t.tasksCreated || 0) + (t.taskActions || 0))}</div></div>
          </div>

          <p className="rpt-kpi-prev" style={{ marginBottom: 12 }}>
            Login <b>{time(act.loginTime)}</b> · Logout <b>{time(act.logoutTime)}</b> · Active <b>{formatFull(act.activeMinutes || 0)}m</b> · Status <b>{act.status || '—'}</b>
          </p>

          {/* Tool usage */}
          <div className="rpt-card-head"><h3 className="rpt-card-title" style={{ fontSize: 13 }}>Tool usage</h3></div>
          {(d.toolUsage || []).length ? (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              {d.toolUsage.map((x) => (
                <span key={x.tool} className="rpt-pill muted">{x.tool} · {formatNumber(x.events)} events · {formatFull(x.credits)} cr</span>
              ))}
            </div>
          ) : <p className="rpt-kpi-prev">No tool usage recorded.</p>}

          {/* Tasks */}
          <div className="rpt-card-head"><h3 className="rpt-card-title" style={{ fontSize: 13 }}>Tasks</h3></div>
          {((d.tasksCreated || []).length + (d.taskActions || []).length) ? (
            <ul style={{ margin: '0 0 12px', paddingLeft: 18, fontSize: 12 }}>
              {(d.tasksCreated || []).map((x) => (
                <li key={`c-${x.taskNumber}`}>Created <b>{x.taskNumber}</b> — {x.title} <span className="rpt-pill muted">{x.status}</span></li>
              ))}
              {(d.taskActions || []).map((x, i) => (
                <li key={`a-${i}`}>{time(x.time)} — <b>{x.action}</b> {x.statusTo ? `→ ${x.statusTo}` : ''} on {x.taskNumber} <span className="rpt-muted">{x.title}</span></li>
              ))}
            </ul>
          ) : <p className="rpt-kpi-prev">No task activity that day.</p>}

          {/* Generations */}
          <div className="rpt-card-head">
            <h3 className="rpt-card-title" style={{ fontSize: 13 }}>Generations</h3>
            <span className="rpt-card-hint">
              {d.generationsTruncated
                ? `showing first ${formatNumber((d.generations || []).length)} of ${formatNumber(t.generations)}`
                : `${formatNumber((d.generations || []).length)} captured`}
            </span>
          </div>
          {(d.generations || []).length ? (
            <div style={{ maxHeight: 260, overflowY: 'auto' }}>
              <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                <thead><tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                  <th style={{ padding: '4px' }}>Time</th><th style={{ padding: '4px' }}>Model</th>
                  <th style={{ padding: '4px', textAlign: 'right' }}>Credits</th><th style={{ padding: '4px' }}>Prompt</th>
                </tr></thead>
                <tbody>
                  {d.generations.map((g, i) => (
                    <tr key={i} style={{ borderTop: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '4px', whiteSpace: 'nowrap' }}>{time(g.time)}</td>
                      <td style={{ padding: '4px' }}>{g.model || '—'}</td>
                      <td style={{ padding: '4px', textAlign: 'right' }}>{g.credits == null ? '—' : formatFull(g.credits)}</td>
                      <td style={{ padding: '4px' }}>{(g.prompt || '—').slice(0, 90)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="rpt-kpi-prev">No generations that day.</p>}
        </>
      )}
    </div>
  );
};

// Real login/session history for this person, from captured activity.
const LoginTimeline = ({ userId, userName, focusDate, onAddToCanvas }) => {
  // Arriving from a specific day on a chart, open that day straight away.
  const [openDate, setOpenDate] = useState(focusDate || null);
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['reports', 'user', 'timeline', userId],
    queryFn: () => reportsAPI.userTimeline({ userId }),
    enabled: !!userId,
    staleTime: 60_000,
  });

  const rows = data?.timeline || [];
  const totals = data?.totals || {};
  const time = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');
  const day = (d) => (d ? new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '—');

  return (
    <div className="rpt-card" style={{ marginTop: 18 }}>
      <div className="rpt-card-head">
        <h3 className="rpt-card-title">Login timeline</h3>
        <span className="rpt-card-hint">
          {totals.days ? `${totals.days} active days · ${formatFull(totals.sessionMinutes)} min total · click a date for that day` : 'When this person logged in'}
        </span>
        {onAddToCanvas && (
          <ToCanvasButton
            label="Move to canvas"
            title={`Add ${userName || 'this user'}'s login timeline to the Report Builder`}
            onClick={() => onAddToCanvas({ kind: 'live-user-timeline', userId, userName }, `Login timeline — ${userName || 'user'}`)}
          />
        )}
      </div>

      {isLoading && <p className="rpt-kpi-prev">Loading timeline…</p>}
      {isError && <p className="rpt-error">Failed to load timeline: {error?.response?.data?.detail || error?.message}</p>}
      {!isLoading && !isError && rows.length === 0 && <p className="rpt-kpi-prev">No login activity recorded.</p>}

      {rows.length > 0 && (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          <table className="rpt-table" style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--color-text-muted)' }}>
                <th style={{ padding: '6px 4px' }}>Date</th>
                <th style={{ padding: '6px 4px' }}>Login</th>
                <th style={{ padding: '6px 4px' }}>Logout</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Session</th>
                <th style={{ padding: '6px 4px', textAlign: 'right' }}>Active</th>
                <th style={{ padding: '6px 4px' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.date}
                  onClick={() => setOpenDate(openDate === r.date ? null : r.date)}
                  className={openDate === r.date ? 'rpt-row-active' : undefined}
                  style={{
                    borderTop: '1px solid var(--color-border)',
                    cursor: 'pointer',
                    background: openDate === r.date ? 'var(--color-secondary)' : undefined,
                  }}
                  title="See tasks, tool usage and generations for this day"
                >
                  <td style={{ padding: '6px 4px' }}>{day(r.date)}</td>
                  <td style={{ padding: '6px 4px' }}>{time(r.loginTime)}</td>
                  <td style={{ padding: '6px 4px' }}>{time(r.logoutTime)}</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(r.sessionMinutes)}m</td>
                  <td style={{ padding: '6px 4px', textAlign: 'right' }}>{formatFull(r.activeMinutes)}m</td>
                  <td style={{ padding: '6px 4px' }}><span className="rpt-pill muted">{r.status || '—'}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Login timeline is not tool-scoped, so the day panel stays unfiltered. */}
      {openDate && (
        <DayDetail
          userId={userId}
          userName={userName}
          date={openDate}
          onClose={() => setOpenDate(null)}
          onAddToCanvas={onAddToCanvas}
        />
      )}
    </div>
  );
};

export default UserDetail;
