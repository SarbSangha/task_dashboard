// Generates a self-contained, print-ready report in the Ritz Media World
// template style (navy + gold cover, KPI cards, tables, numbered sections).
// Returns a complete HTML document string suitable for an <iframe srcdoc> or a new tab.

import { questionFor } from './blockQuestions';


// The RMWeye dashboard mark, inlined so the generated report stays a single
// self-contained file (it gets emailed and exported — no external fetches).
export const EYE_LOGO_SVG = `<svg viewBox="0 0 64 64" width="100%" height="100%" role="img" aria-label="RMWeye">
  <defs><linearGradient id="eyeBg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#1f3b63"/><stop offset="100%" stop-color="#0f1d34"/>
  </linearGradient></defs>
  <rect width="64" height="64" rx="14" fill="url(#eyeBg)"/>
  <path d="M32 15C19 15 8 23 4 32c4 9 15 17 28 17s24-8 28-17c-4-9-15-17-28-17zm0 27a10 10 0 1 1 0-20 10 10 0 0 1 0 20z" fill="#dbeafe"/>
  <circle cx="32" cy="32" r="6" fill="#60a5fa"/>
  <circle cx="34" cy="30" r="2.2" fill="#ffffff"/>
</svg>`;

// Same mark as a faint tiled background. Encoded as a data URI so it survives
// export; the navy is dropped to a low opacity so text stays readable.
const WATERMARK_SVG = encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220" viewBox="0 0 220 220">`
  + `<g opacity="0.045" transform="translate(110 110) rotate(-30) translate(-56 -56)">`
  + `<path d="M56 22C33 22 14 36 7 56c7 20 26 34 49 34s42-14 49-34c-7-20-26-34-49-34zm0 48a14 14 0 1 1 0-28 14 14 0 0 1 0 28z" fill="#101f3f"/>`
  + `<circle cx="56" cy="56" r="8" fill="#101f3f"/>`
  + `</g></svg>`,
);
const WATERMARK_URL = `data:image/svg+xml,${WATERMARK_SVG}`;

const esc = (s) => `${s == null ? '' : s}`
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const num = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return Number(v).toLocaleString(undefined, { maximumFractionDigits: 1 });
};

// Pull a compact KPI list out of a live reports payload.
const execKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.activeUsers?.value), label: 'Active Users' },
    { value: num(k.aiGenerations?.value), label: 'AI Generations' },
    { value: num(k.videosGenerated?.value), label: 'Videos' },
    { value: `${num(k.aiAdoptionRate?.value)}%`, label: 'AI Adoption' },
    { value: num(k.aiCost?.value), label: 'Credits' },
  ];
};
const klingKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.totalVideos?.value), label: 'Kling Videos' },
    { value: num(k.uniqueUsers?.value), label: 'Creators' },
    { value: `${num(k.successRate?.value)}%`, label: 'Success Rate' },
    { value: num(k.creditsConsumed?.value), label: 'Credits' },
  ];
};
const costKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.totalCredits?.value), label: 'Total Credits' },
    { value: num(k.costPerOutput?.value), label: 'Cost / Output' },
    { value: num(k.wastedCredits?.value), label: 'Wasted Credits' },
  ];
};
const usersKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.activeUsers?.value), label: 'Active Users' },
    { value: num(d?.dau), label: 'DAU' },
    { value: num(d?.wau), label: 'WAU' },
    { value: num(d?.mau), label: 'MAU' },
    { value: `${num(k.avgSessionMinutes?.value)}m`, label: 'Avg Session' },
  ];
};
const tasksKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.tasksCompleted?.value), label: 'Tasks Completed' },
    { value: `${num(k.completionRate?.value)}%`, label: 'Completion Rate' },
    { value: `${num(k.avgCycleHours?.value)}h`, label: 'Avg Cycle' },
    { value: `${num(k.onTimeRate?.value)}%`, label: 'On-Time' },
  ];
};
const promptsKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.totalPrompts?.value), label: 'Prompts' },
    { value: num(k.uniquePrompts?.value), label: 'Unique Prompts' },
    { value: `${num(k.successfulPct?.value)}%`, label: 'Success' },
    { value: `${num(k.reuseRate?.value)}%`, label: 'Reuse Rate' },
    { value: num(k.avgLength?.value), label: 'Avg Length' },
  ];
};
const chatgptKpis = (d) => {
  const k = d?.kpis || {};
  return [
    { value: num(k.conversations?.value), label: 'Conversations' },
    { value: num(k.prompts?.value), label: 'Prompts' },
    { value: num(k.responses?.value), label: 'Responses' },
    { value: num(k.uniqueUsers?.value), label: 'Users' },
    { value: num(k.avgPromptsPerConversation?.value), label: 'Prompts / Chat' },
  ];
};

// ---- Sub-section extractors ----
const retentionKpis = (d) => {
  const w = d?.windows || {};
  return [
    { value: `${num(w.d1)}%`, label: 'D1 Retention' },
    { value: `${num(w.d7)}%`, label: 'D7 Retention' },
    { value: `${num(w.d30)}%`, label: 'D30 Retention' },
    { value: num(d?.churnRisk), label: 'Churn Risk' },
  ];
};
const powerUsersKpis = (d) => {
  const top = (d?.users || [])[0];
  return [
    { value: num(d?.totalGenerations), label: 'Total Generations' },
    { value: `${num(d?.concentration?.top10SharePct)}%`, label: 'Top-10 Share' },
    { value: top ? top.name : '—', label: 'Top User' },
  ];
};
const maturityKpis = (d) => {
  const dist = d?.distribution || [];
  const lvl = (name) => (dist.find((x) => x.level === name) || {}).count;
  return [
    { value: num(lvl('AI Champion')), label: 'AI Champions' },
    { value: num(lvl('Practitioner')), label: 'Practitioners' },
    { value: num(lvl('Explorer')), label: 'Explorers' },
    { value: num(lvl('Beginner')), label: 'Beginners' },
  ];
};
const goldenKpis = (d) => {
  const s = d?.stats || {};
  return [
    { value: num(s.goldenCount), label: 'Golden Prompts' },
    { value: num(s.uniquePrompts), label: 'Unique Prompts' },
    { value: `${num(s.reuseRate)}%`, label: 'Reuse Rate' },
    { value: num(s.scanned), label: 'Prompts Scanned' },
  ];
};
const promptEngineersKpis = (d) => {
  const eng = d?.engineers || [];
  const top = eng[0];
  return [
    { value: num(eng.length), label: 'Prompt Engineers' },
    { value: top ? top.name : '—', label: 'Top Engineer' },
    { value: top ? num(top.performanceScore) : '—', label: 'Top Score' },
  ];
};
const aiImpactKpis = (d) => {
  const dl = d?.deltas || {};
  return [
    { value: `${num(dl.throughputPct)}%`, label: 'Throughput Δ (AI vs non-AI)' },
    { value: `${num(dl.cycleFasterPct)}%`, label: 'Cycle Time Faster' },
  ];
};

// ---- Simple print-safe chart/table renderers (no JS libs in the report HTML) ----
const barsHtml = (items, labelWidth = 84) => {
  const max = items.reduce((m, i) => Math.max(m, Number(i.value) || 0), 0) || 1;
  return `<div class="bars">${items.map((i) => {
    const pct = Math.round(((Number(i.value) || 0) / max) * 100);
    return `<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:11px">
      <span style="width:${labelWidth}px;flex:none;color:#5b6472;text-align:right">${esc(i.label)}</span>
      <span style="flex:1;background:#eef1f5;border-radius:3px;height:12px;overflow:hidden"><span style="display:block;height:100%;width:${pct}%;background:#2f6fdb"></span></span>
      <span style="width:60px;text-align:right;font-weight:600">${esc(i.value)}</span>
    </div>`;
  }).join('')}</div>`;
};
const simpleTableHtml = (columns, rows) => `<table class="tbl">
  <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
  <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;

// ---- Kling sub-section extractors (mirror the Kling Analytics dashboard) ----
const hourLabel = (h) => { const n = Number(h); if (n === 0) return '12a'; if (n === 12) return '12p'; return n < 12 ? `${n}a` : `${n - 12}p`; };
const klingDailyItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.videos }));
const klingDeptItems = (d) => (d?.byDepartment || []).map((x) => ({ label: x.department || '—', value: x.videos }));
const klingHourItems = (d) => (d?.byHour || []).map((x) => ({ label: hourLabel(x.hour), value: x.videos }));
const klingOutcomeKpis = (d) => {
  const sv = d?.successVsFailure || [];
  const get = (l) => (sv.find((x) => x.label === l) || {}).count || 0;
  const s = get('Success'); const f = get('Failure'); const tot = s + f;
  return [
    { value: num(s), label: 'Successful' },
    { value: num(f), label: 'Failed' },
    { value: `${tot ? Math.round((s / tot) * 1000) / 10 : 0}%`, label: 'Success Rate' },
  ];
};
const klingLeaderboardRows = (d) => (d?.users || []).slice(0, 25).map((u) => [
  u.rank, u.name || '—', u.department || '—', num(u.videos), `${num(u.successRate)}%`, num(u.credits),
]);

// ---- ChatGPT sub-section extractors (mirror the ChatGPT Analytics dashboard) ----
const cgDailyItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.conversations }));
const cgModelItems = (d) => (d?.byModel || []).map((x) => ({ label: x.model || '—', value: x.conversations }));
const cgDeptItems = (d) => (d?.byDepartment || []).map((x) => ({ label: x.department || '—', value: x.conversations }));
const cgHourItems = (d) => (d?.byHour || []).map((x) => ({ label: hourLabel(x.hour), value: x.conversations }));
const cgUserRows = (d) => (d?.users || []).slice(0, 25).map((u) => [
  u.rank, u.name || '—', u.department || '—', num(u.conversations), num(u.prompts), num(u.avgDepth),
]);

// ---- User Intelligence sub-parts ----
const uaDailyItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.activeUsers }));
const uaSessionItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.avgSessionMin }));
const uaDeptItems = (d) => (d?.byDepartment || []).map((x) => ({ label: x.department || '—', value: x.activeUsers }));
const maturityItems = (d) => (d?.distribution || []).map((x) => ({ label: x.level || '—', value: x.count }));
const powerUserRows = (d) => (d?.users || []).slice(0, 25).map((u) => [
  u.rank, u.name || '—', u.department || '—', num(u.generations), num(u.credits), num(u.activeDays), u.level || '—', num(u.maturityScore),
]);

// ---- Task Intelligence sub-parts ----
const taskDailyRows = (d) => (d?.daily || []).slice(-30).map((x) => [x.date, num(x.created), num(x.completed)]);
const taskDeptRows = (d) => (d?.byDepartment || []).map((x) => [x.department || '—', num(x.created), num(x.completed), `${num(x.completionRate)}%`]);
const taskPriorityRows = (d) => (d?.byPriority || []).map((x) => [x.priority || '—', num(x.created), num(x.completed), `${num(x.completionRate)}%`]);
const aiCohortRows = (d) => Object.entries(d?.cohorts || {}).map(([k, v]) => [
  k, num(v?.users), num(v?.tasks), num(v?.completed), num(v?.completedPerUser), `${num(v?.completionRate)}%`, num(v?.avgCycleHours),
]);
const aiDeptRows = (d) => (d?.departmentScatter || []).map((x) => [
  x.department || '—', `${num(x.aiAdoptionPct)}%`, num(x.completedPerUser), num(x.users),
]);

// ---- Prompt Intelligence sub-parts ----
const promptVolumeItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.prompts }));
const promptSuccessItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.successRate }));
const promptThemeItems = (d) => (d?.topThemes || []).map((x) => ({ label: x.theme || x.label || '—', value: x.count ?? x.prompts }));
const promptModelRows = (d) => (d?.successByModel || []).map((x) => [x.model || '—', num(x.prompts), `${num(x.successRate)}%`]);
const goldenRows = (d) => (d?.golden || []).slice(0, 20).map((g) => [
  `${(g.prompt || '').slice(0, 70)}${(g.prompt || '').length > 70 ? '…' : ''}`,
  num(g.uses), `${num(g.successRate)}%`, num(g.uniqueUsers), num(g.credits), g.creator?.name || '—',
]);
const engineerRows = (d) => (d?.engineers || []).slice(0, 25).map((e) => [
  e.name || '—', e.department || '—', num(e.prompts), num(e.uniquePrompts), `${num(e.successRate)}%`, num(e.credits), num(e.performanceScore),
]);

// ---- Cost Intelligence sub-parts ----
const costTrendItems = (d) => (d?.daily || []).slice(-30).map((x) => ({ label: x.date, value: x.credits }));
const costDeptItems = (d) => (d?.byDepartment || []).map((x) => ({ label: x.department || '—', value: x.credits }));
const costToolItems = (d) => (d?.byProvider || []).map((x) => ({ label: x.provider || '—', value: x.credits }));
const costSpenderRows = (d) => (d?.topUsers || []).slice(0, 25).map((u) => [
  u.rank, u.name || '—', u.department || '—', num(u.credits), `${d?.currency || 'INR'} ${num(u.cost)}`, num(u.generations), num(u.creditsPerOutput),
]);

// Exposed so the builder can bake live values into a saved definition (snapshotItems).
export const liveSnapshotItems = (kind, live) => {
  if (kind === 'live-exec') return live?.exec ? execKpis(live.exec) : [];
  if (kind === 'live-kling') return live?.kling ? klingKpis(live.kling) : [];
  if (kind === 'live-cost') return live?.cost ? costKpis(live.cost) : [];
  if (kind === 'live-users') return live?.users ? usersKpis(live.users) : [];
  if (kind === 'live-tasks') return live?.tasks ? tasksKpis(live.tasks) : [];
  if (kind === 'live-prompts') return live?.prompts ? promptsKpis(live.prompts) : [];
  if (kind === 'live-chatgpt') return live?.chatgpt ? chatgptKpis(live.chatgpt) : [];
  if (kind === 'live-retention') return live?.retention ? retentionKpis(live.retention) : [];
  if (kind === 'live-power-users') return live?.powerUsers ? powerUsersKpis(live.powerUsers) : [];
  if (kind === 'live-maturity') return live?.powerUsers ? maturityKpis(live.powerUsers) : [];
  if (kind === 'live-golden-prompts') return live?.golden ? goldenKpis(live.golden) : [];
  if (kind === 'live-prompt-leaderboard') return live?.engineers ? promptEngineersKpis(live.engineers) : [];
  if (kind === 'live-ai-impact') return live?.aiImpact ? aiImpactKpis(live.aiImpact) : [];
  if (kind === 'live-kling-trend') return live?.klingTrends ? klingDailyItems(live.klingTrends) : [];
  if (kind === 'live-kling-dept') return live?.klingTrends ? klingDeptItems(live.klingTrends) : [];
  if (kind === 'live-kling-hours') return live?.klingTrends ? klingHourItems(live.klingTrends) : [];
  if (kind === 'live-kling-outcomes') return live?.klingTrends ? klingOutcomeKpis(live.klingTrends) : [];
  if (kind === 'live-kling-leaderboard') return [];
  if (kind === 'live-cg-trend') return live?.chatgptTrends ? cgDailyItems(live.chatgptTrends) : [];
  if (kind === 'live-cg-models') return live?.chatgptTrends ? cgModelItems(live.chatgptTrends) : [];
  if (kind === 'live-cg-dept') return live?.chatgptTrends ? cgDeptItems(live.chatgptTrends) : [];
  if (kind === 'live-cg-hours') return live?.chatgptTrends ? cgHourItems(live.chatgptTrends) : [];
  if (kind === 'live-cg-users') return [];
  if (kind === 'live-ua-daily') return live?.activityTrends ? uaDailyItems(live.activityTrends) : [];
  if (kind === 'live-ua-session') return live?.activityTrends ? uaSessionItems(live.activityTrends) : [];
  if (kind === 'live-ua-dept') return live?.activityTrends ? uaDeptItems(live.activityTrends) : [];
  if (kind === 'live-maturity-dist') return live?.powerUsers ? maturityItems(live.powerUsers) : [];
  if (kind === 'live-prompt-volume') return live?.promptsTrends ? promptVolumeItems(live.promptsTrends) : [];
  if (kind === 'live-prompt-success') return live?.promptsTrends ? promptSuccessItems(live.promptsTrends) : [];
  if (kind === 'live-prompt-themes') return live?.promptsTrends ? promptThemeItems(live.promptsTrends) : [];
  if (kind === 'live-cost-trend') return live?.costBreakdown ? costTrendItems(live.costBreakdown) : [];
  if (kind === 'live-cost-dept') return live?.costBreakdown ? costDeptItems(live.costBreakdown) : [];
  if (kind === 'live-cost-tool') return live?.costBreakdown ? costToolItems(live.costBreakdown) : [];
  return [];
};

/* ---- Executive drill levels (parameterised blocks; data baked per block) ---- */
const minLabel = (v) => `${num(v)} min`;
const clock = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};
const dayStamp = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const activeUserRows = (d) => (d?.users || []).slice(0, 60).map((u) => [
  num(u.rank), esc(u.name), esc(u.department || '—'),
  num(u.activeDays), num(u.sessionMinutes), num(u.activeMinutes),
]);
const chatDayRows = (d) => (d?.conversations || []).map((c) => [
  clock(c.time), esc(c.title || 'Untitled chat'), esc(c.model || '—'),
  num(c.prompts), num(c.messages),
]);
const chatMessagesHtml = (d) => {
  const msgs = d?.messages || [];
  if (!msgs.length) return '<p class="muted">No message content captured for this chat.</p>';
  return `<div class="thread">${msgs.map((m) => `
    <div class="msg ${m.role === 'user' ? 'u' : 'a'}">
      <span class="msg-role">${m.role === 'user' ? 'Prompt' : 'Response'}</span>
      <div class="msg-body">${esc(m.text || '(empty)')}${m.truncated ? ` <em>… truncated (${num(m.length)} chars)</em>` : ''}</div>
    </div>`).join('')}</div>`;
};
const chatTimelineRows = (d) => (d?.timeline || []).map((r) => [
  dayStamp(r.date), num(r.conversations), num(r.prompts), num(r.messages),
  num(r.avgDepth), `${clock(r.firstAt)} – ${clock(r.lastAt)}`,
]);
const promptUserRows = (d) => (d?.users || []).map((u) => [
  num(u.rank), esc(u.name), esc(u.department || '—'),
  num(u.uses), `${num(u.successPct)}%`, num(u.credits), dayStamp(u.lastAt),
]);
const promptAuthorRows = (d) => (d?.users || []).slice(0, 60).map((u) => [
  num(u.rank), esc(u.name), esc(u.department || '—'),
  num(u.prompts), num(u.uniquePrompts), num(u.reusedPrompts), `${num(u.reuseRate)}%`, num(u.avgLength),
]);
const promptTimelineRows = (d) => (d?.timeline || []).map((r) => [
  dayStamp(r.date), num(r.prompts), num(r.uniquePrompts), num(r.reusedPrompts),
  `${num(r.reuseRate)}%`, num(r.avgLength),
]);
const promptListRows = (d) => (d?.prompts || []).slice(0, 60).map((p) => [
  `${num(p.uses)}x`, esc((p.prompt || '').slice(0, 220)), num(p.credits), `${num(p.successPct)}%`,
]);
const taskLoadRows = (d) => (d?.users || []).slice(0, 60).map((u) => [
  num(u.rank), esc(u.name), esc(u.department || '—'),
  num(u.created), num(u.createdCompleted), num(u.received), num(u.receivedCompleted),
  u.received ? `${num(u.completionRate)}%` : '—',
]);
const contributorRows = (d) => (d?.users || []).slice(0, 60).map((u) => [
  num(u.rank), esc(u.name), esc(u.department || '—'),
  num(u.generations), num(u.videos), num(u.images),
  num(u.credits), num(u.activeDays), `${num(u.sharePct)}%`,
]);
const genTimelineRows = (d) => (d?.timeline || []).map((r) => [
  dayStamp(r.date), num(r.generations), num(r.videos), num(r.images),
  num(r.credits), num(r.avgCredits), `${clock(r.firstAt)} – ${clock(r.lastAt)}`,
]);
const timelineRows = (d) => (d?.timeline || []).map((r) => [
  dayStamp(r.date), clock(r.loginTime), clock(r.logoutTime),
  minLabel(r.sessionMinutes), minLabel(r.activeMinutes), esc(r.status || '—'),
]);
const dayKpis = (d) => {
  const t = d?.totals || {};
  const a = d?.activity || {};
  return [
    { label: 'Session', value: minLabel(a.sessionMinutes) },
    { label: 'Generations', value: num(t.generations) },
    { label: 'Credits', value: num(t.credits) },
    { label: 'Task actions', value: num((t.tasksCreated || 0) + (t.taskActions || 0)) },
  ];
};
const dayToolRows = (d) => (d?.toolUsage || []).map((x) => [esc(x.tool || '—'), num(x.events), num(x.credits)]);
const dayTaskRows = (d) => [
  ...(d?.tasksCreated || []).map((x) => ['Created', esc(x.taskNumber), esc(x.title), esc(x.status || '—')]),
  ...(d?.taskActions || []).map((x) => [esc(x.action || 'Action'), esc(x.taskNumber), esc(x.title), esc(x.statusTo || '—')]),
];
const dayGenRows = (d) => (d?.generations || []).slice(0, 60).map((g) => [
  clock(g.time), esc(g.model || '—'), g.credits == null ? '—' : num(g.credits), esc((g.prompt || '—').slice(0, 120)),
]);

const kpiCardsHtml = (items) => `
  <div class="kpis">
    ${items.map((it) => `
      <div class="kpi">
        <div class="kpi-value">${esc(it.value)}</div>
        <div class="kpi-label">${esc(it.label)}</div>
      </div>`).join('')}
  </div>`;

// Every block states the question it answers, pulled from the same registry the
// dashboard uses — so the printed report and the screen can never disagree.
const questionHtml = (block) => {
  const q = block.question || questionFor(block.kind);
  return q ? `<p class="qline"><strong>Question:</strong> ${esc(q)}</p>` : '';
};

function blockHtml(block, idx, live) {
  const html = blockBody(block, idx, live);
  const q = questionHtml(block);
  if (!q) return html;
  const at = html.indexOf('</h2>');
  return at === -1 ? html : `${html.slice(0, at + 5)}${q}${html.slice(at + 5)}`;
}

const sectionHead = (n, title) => `<h2 class="sec"><span class="sec-n">${n}.</span> ${esc(title)}</h2>`;

// Data-availability check for a question section, so the report never presents a
// question as "answered" when the platform has no data behind it.
const DATA_META = {
  available: { badge: '✅', label: 'Data available', color: '#15803d', bg: '#e9f7ef' },
  needs_capture: { badge: '🟡', label: 'Partial data', color: '#b45309', bg: '#fdf3e7' },
  future: { badge: '🔴', label: 'No data captured yet', color: '#b91c1c', bg: '#fdecec' },
};
const dataCheckHtml = (block) => {
  const level = block.readiness || (block.metric ? 'needs_capture' : null);
  if (!level) return '';
  const m = DATA_META[level] || DATA_META.needs_capture;
  const note = block.dataNote
    ? ` — ${esc(block.dataNote)}`
    : (level === 'available' ? ' — attach a matching live-data block to show figures for the selected period.' : '');
  return `<p class="datacheck" style="margin:6px 0 10px;padding:6px 10px;border-radius:6px;font-size:12px;color:${m.color};background:${m.bg}">${m.badge} <strong>${m.label}</strong>${note}</p>`;
};

// When the question is bound to live data, render the real answer (KPI cards)
// instead of the placeholder banner. Partial (needs_capture) still shows a caveat.
const answerBanner = '<p class="datacheck" style="margin:6px 0 8px;padding:6px 10px;border-radius:6px;font-size:12px;color:#15803d;background:#e9f7ef">✅ <strong>Answer</strong> — live data for the selected period</p>';
const partialCaveat = (block) => (block.readiness === 'needs_capture' && block.dataNote
  ? `<p class="datacheck" style="margin:2px 0 8px;padding:6px 10px;border-radius:6px;font-size:11px;color:#b45309;background:#fdf3e7">🟡 Partial — ${esc(block.dataNote)}</p>`
  : '');

const answerHtml = (block) => {
  if (block.answerTable && Array.isArray(block.answerTable.rows) && block.answerTable.rows.length) {
    const { columns, rows } = block.answerTable;
    const table = `<table class="tbl">
      <thead><tr>${columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r) => `<tr>${r.map((cell) => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
    </table>`;
    return `${answerBanner}${partialCaveat(block)}${table}`;
  }
  if (Array.isArray(block.answerItems) && block.answerItems.length) {
    return `${answerBanner}${partialCaveat(block)}${kpiCardsHtml(block.answerItems)}`;
  }
  return dataCheckHtml(block);
};

function blockBody(block, idx, live) {
  const n = idx + 1;
  switch (block.kind) {
    case 'question':
      return `
        <section class="block">
          ${sectionHead(n, block.q)}
          ${block.why ? `<p class="lead"><strong>Why it matters:</strong> ${esc(block.why)}</p>` : ''}
          ${answerHtml(block)}
          <div class="qmeta">
            ${block.metric ? `<div class="qmeta-item"><span class="qmeta-lab">Metric</span><span class="qmeta-val">${esc(block.metric)}</span></div>` : ''}
            ${block.decision ? `<div class="qmeta-item"><span class="qmeta-lab">Decision</span><span class="qmeta-val">${esc(block.decision)}</span></div>` : ''}
          </div>
        </section>`;
    case 'text':
      return `
        <section class="block">
          ${sectionHead(n, block.heading || 'Narrative')}
          <p class="body">${esc(block.body || '').replace(/\n/g, '<br>')}</p>
        </section>`;
    case 'kpis':
      return `
        <section class="block">
          ${sectionHead(n, block.heading || 'Performance Metrics')}
          ${kpiCardsHtml((block.items || []).filter((i) => i.label || i.value))}
        </section>`;
    case 'live-exec':
      return `<section class="block">${sectionHead(n, 'Executive Performance Metrics')}${live.exec ? kpiCardsHtml(execKpis(live.exec)) : '<p class="muted">No data available for the selected range.</p>'}</section>`;

    /* Executive drill levels — each carries its own baked snapshot in block.drill. */
    case 'live-active-users': {
      const d = block.drill;
      const rows = activeUserRows(d);
      const win = (block.start && block.end
        ? (block.start === block.end ? ` on ${dayStamp(block.start)}` : ` between ${dayStamp(block.start)} and ${dayStamp(block.end)}`)
        : ' in the reporting period') + (block.department ? ` in ${esc(block.department)}` : '');
      return `<section class="block">${sectionHead(n, block.label ? `${esc(block.label)} — Active Users` : 'Active Users')}
        <p class="lead">Everyone who logged in or was tracked active${win}.</p>
        ${rows.length ? simpleTableHtml(['#', 'User', 'Department', 'Active days', 'Session (min)', 'Active (min)'], rows) : '<p class="muted">No active users in this period.</p>'}</section>`;
    }
    case 'live-contributors': {
      const d = block.drill;
      const rows = contributorRows(d);
      const what = esc(block.metricTitle || 'AI Generations');
      const bits = [
        block.provider ? `${esc(block.provider)} only` : null,
        block.department ? `${esc(block.department)} department` : null,
        block.hour != null ? `${esc(block.hour)}:00–${esc((Number(block.hour) + 1) % 24)}:00 IST` : null,
        block.date ? `on ${dayStamp(block.date)}` : null,
      ].filter(Boolean);
      const scope = bits.length ? ` (${bits.join(', ')})` : '';
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, `${what} — Contributors`)}
        <p class="lead">Who produced the output behind ${what.toLowerCase()}${scope} in the reporting period${
          d ? ` — ${num(t.generations)} generations and ${num(t.credits)} credits across ${num(d.count)} people` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['#', 'User', 'Department', 'Generations', 'Videos', 'Images', 'Credits', 'Active days', 'Share'], rows) : '<p class="muted">No generations recorded in this period.</p>'}</section>`;
    }
    case 'live-user-generations': {
      const d = block.drill;
      const rows = genTimelineRows(d);
      const who = esc(block.userName || d?.user?.name || 'User');
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, `Generation Timeline — ${who}`)}
        <p class="lead">The days ${who} generated on${block.provider ? ` with ${esc(block.provider)}` : ''}${
          d ? ` — ${num(t.generations)} generations and ${num(t.credits)} credits across ${num(t.days)} days` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['Date', 'Generations', 'Videos', 'Images', 'Credits', 'Avg / gen', 'Window'], rows) : '<p class="muted">No generations recorded.</p>'}</section>`;
    }
    case 'live-chat-day': {
      const d = block.drill;
      const rows = chatDayRows(d);
      const who = esc(block.userName || 'User');
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, `Chats — ${who}, ${dayStamp(block.date)}`)}
        <p class="lead">Every ChatGPT conversation ${who} had that day${
          d ? ` — ${num(t.conversations)} chats, ${num(t.prompts)} prompts, ${num(t.messages)} messages` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['Time', 'Chat', 'Model', 'Prompts', 'Messages'], rows) : '<p class="muted">No chats that day.</p>'}</section>`;
    }
    case 'live-chat-messages': {
      const d = block.drill;
      const t = d?.totals || {};
      const title = esc(block.title || d?.conversation?.title || 'Chat');
      return `<section class="block">${sectionHead(n, `Chat Messages — ${title}`)}
        <p class="lead">Full message thread${block.userName ? ` for ${esc(block.userName)}` : ''}${
          d ? ` — ${num(t.prompts)} prompts and ${num(t.responses)} responses` : ''
        }.</p>
        ${chatMessagesHtml(d)}</section>`;
    }
    case 'live-chat-timeline': {
      const d = block.drill;
      const rows = chatTimelineRows(d);
      const who = esc(block.userName || d?.user?.name || 'User');
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, `Chat Timeline — ${who}`)}
        <p class="lead">When ${who} actually used ChatGPT${
          d ? ` — ${num(t.conversations)} chats and ${num(t.messages)} messages across ${num(t.days)} days` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['Date', 'Chats', 'Prompts', 'Messages', 'Avg depth', 'Chat window'], rows) : '<p class="muted">No ChatGPT activity recorded.</p>'}</section>`;
    }
    case 'live-prompt-detail': {
      const d = block.drill;
      const t = d?.totals || {};
      const rows = promptUserRows(d);
      return `<section class="block">${sectionHead(n, 'Prompt Detail')}
        <p class="lead">${esc((block.promptText || d?.prompt || '').slice(0, 400))}</p>
        ${d ? kpiCardsHtml([
          { value: num(t.uses), label: 'Uses' },
          { value: num(t.people), label: 'People' },
          { value: `${num(t.successPct)}%`, label: 'Success' },
          { value: num(t.credits), label: 'Credits' },
        ]) : ''}
        <h3 class="subsec">Who used it</h3>
        ${rows.length ? simpleTableHtml(['#', 'User', 'Department', 'Uses', 'Success', 'Credits', 'Last used'], rows) : '<p class="muted">No usage in this period.</p>'}</section>`;
    }
    case 'live-prompt-contributors': {
      const d = block.drill;
      const rows = promptAuthorRows(d);
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, block.mode === 'reuse' ? 'Prompt Reuse by Person' : 'Prompts by Person')}
        <p class="lead">Prompt volume, uniqueness and reuse per person${
          d ? ` — ${num(t.prompts)} prompts, ${num(t.uniquePrompts)} unique (${num(t.reuseRate)}% reuse)` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['#', 'User', 'Department', 'Prompts', 'Unique', 'Reused', 'Reuse rate', 'Avg length'], rows) : '<p class="muted">No prompts in this period.</p>'}</section>`;
    }
    case 'live-prompt-timeline': {
      const d = block.drill;
      const rows = promptTimelineRows(d);
      const who = esc(block.userName || d?.user?.name || 'User');
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, `Prompt Timeline — ${who}`)}
        <p class="lead">Day-by-day prompt activity for ${who}${
          d ? ` — ${num(t.prompts)} prompts across ${num(t.days)} days, ${num(t.uniquePrompts)} unique` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['Date', 'Prompts', 'Unique', 'Reused', 'Reuse rate', 'Avg length'], rows) : '<p class="muted">No prompts recorded.</p>'}</section>`;
    }
    case 'live-prompt-list': {
      const d = block.drill;
      const rows = promptListRows(d);
      const who = esc(block.userName || 'User');
      const head = block.repeatedOnly ? `Reused Prompts — ${who}` : `Prompts — ${who}${block.date ? `, ${dayStamp(block.date)}` : ''}`;
      const t = d?.totals || {};
      return `<section class="block">${sectionHead(n, head)}
        <p class="lead">${block.repeatedOnly ? 'Prompts this person used more than once' : 'The prompts written'}${
          d ? ` — ${num(t.distinct)} distinct across ${num(t.uses)} uses` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['Uses', 'Prompt', 'Credits', 'Success'], rows) : '<p class="muted">No prompts in this scope.</p>'}</section>`;
    }
    case 'live-task-contributors': {
      const d = block.drill;
      const rows = taskLoadRows(d);
      const t = d?.totals || {};
      const scope = block.scopeLabel ? ` — ${esc(block.scopeLabel)}` : '';
      return `<section class="block">${sectionHead(n, `Task Load by Person${scope}`)}
        <p class="lead">Tasks each person raised versus tasks assigned to them, with completion on received work${
          d ? ` — ${num(t.created)} tasks created, ${num(t.completed)} completed (${num(t.completionRate)}%)` : ''
        }.</p>
        ${rows.length ? simpleTableHtml(['#', 'User', 'Department', 'Created', 'Created · done', 'Received', 'Received · done', 'Completion'], rows) : '<p class="muted">No tasks in this scope.</p>'}</section>`;
    }
    case 'live-user-timeline': {
      const d = block.drill;
      const rows = timelineRows(d);
      const who = esc(block.userName || d?.user?.name || 'User');
      return `<section class="block">${sectionHead(n, `Login Timeline — ${who}`)}
        <p class="lead">Day-by-day login, logout and active time for ${who}.</p>
        ${rows.length ? simpleTableHtml(['Date', 'Login', 'Logout', 'Session', 'Active', 'Status'], rows) : '<p class="muted">No login activity recorded.</p>'}</section>`;
    }
    case 'live-user-day': {
      const d = block.drill;
      const who = esc(block.userName || d?.user?.name || 'User');
      const when = dayStamp(block.date);
      if (!d) return `<section class="block">${sectionHead(n, `Day Detail — ${who}`)}<p class="muted">No data available.</p></section>`;
      const tools = dayToolRows(d);
      const tasks = dayTaskRows(d);
      const gens = dayGenRows(d);
      return `<section class="block">${sectionHead(n, `Day Detail — ${who}, ${when}`)}
        <p class="lead">Everything ${who} did on ${when}: session, tool usage, tasks and generations.</p>
        ${kpiCardsHtml(dayKpis(d))}
        <h3 class="subsec">Tool usage</h3>
        ${tools.length ? simpleTableHtml(['Tool', 'Events', 'Credits'], tools) : '<p class="muted">No tool usage recorded.</p>'}
        <h3 class="subsec">Tasks</h3>
        ${tasks.length ? simpleTableHtml(['Action', 'Task', 'Title', 'Status'], tasks) : '<p class="muted">No task activity that day.</p>'}
        <h3 class="subsec">Generations</h3>
        ${d.generationsTruncated ? `<p class="muted">Showing the first ${num(gens.length)} of ${num(d.totals?.generations)} generations.</p>` : ''}
        ${gens.length ? simpleTableHtml(['Time', 'Model', 'Credits', 'Prompt'], gens) : '<p class="muted">No generations that day.</p>'}</section>`;
    }
    case 'live-kling':
      return `<section class="block">${sectionHead(n, 'Kling Video Intelligence')}${live.kling ? kpiCardsHtml(klingKpis(live.kling)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cost':
      return `<section class="block">${sectionHead(n, 'Cost Intelligence')}${live.cost ? kpiCardsHtml(costKpis(live.cost)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-users':
      return `<section class="block">${sectionHead(n, 'User Intelligence')}${live.users ? kpiCardsHtml(usersKpis(live.users)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-tasks':
      return `<section class="block">${sectionHead(n, 'Task Intelligence')}${live.tasks ? kpiCardsHtml(tasksKpis(live.tasks)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-prompts':
      return `<section class="block">${sectionHead(n, 'Prompt Intelligence')}${live.prompts ? kpiCardsHtml(promptsKpis(live.prompts)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-chatgpt':
      return `<section class="block">${sectionHead(n, 'ChatGPT Intelligence')}${live.chatgpt ? kpiCardsHtml(chatgptKpis(live.chatgpt)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-retention':
      return `<section class="block">${sectionHead(n, 'User Retention')}${live.retention ? kpiCardsHtml(retentionKpis(live.retention)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-power-users':
      return `<section class="block">${sectionHead(n, 'Power Users')}${live.powerUsers ? kpiCardsHtml(powerUsersKpis(live.powerUsers)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-maturity':
      return `<section class="block">${sectionHead(n, 'User AI Maturity')}${live.powerUsers ? kpiCardsHtml(maturityKpis(live.powerUsers)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-golden-prompts':
      return `<section class="block">${sectionHead(n, 'Golden Prompt Library')}${live.golden ? kpiCardsHtml(goldenKpis(live.golden)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-prompt-leaderboard':
      return `<section class="block">${sectionHead(n, 'Prompt Leaderboard')}${live.engineers ? kpiCardsHtml(promptEngineersKpis(live.engineers)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-ai-impact':
      return `<section class="block">${sectionHead(n, 'Task AI Impact')}${live.aiImpact ? kpiCardsHtml(aiImpactKpis(live.aiImpact)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-kling-trend':
      return `<section class="block">${sectionHead(n, 'Video Generation Trend')}${live.klingTrends ? barsHtml(klingDailyItems(live.klingTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-kling-dept':
      return `<section class="block">${sectionHead(n, 'Generation by Department')}${live.klingTrends ? barsHtml(klingDeptItems(live.klingTrends), 110) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-kling-hours':
      return `<section class="block">${sectionHead(n, 'Peak Usage Hours')}${live.klingTrends ? barsHtml(klingHourItems(live.klingTrends), 40) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-kling-outcomes':
      return `<section class="block">${sectionHead(n, 'Success vs Failure')}${live.klingTrends ? kpiCardsHtml(klingOutcomeKpis(live.klingTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-kling-leaderboard':
      return `<section class="block">${sectionHead(n, 'Creator Leaderboard')}${live.klingUsers ? simpleTableHtml(['#', 'User', 'Department', 'Videos', 'Success', 'Credits'], klingLeaderboardRows(live.klingUsers)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cg-trend':
      return `<section class="block">${sectionHead(n, 'Conversation Volume Trend')}${live.chatgptTrends ? barsHtml(cgDailyItems(live.chatgptTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cg-models':
      return `<section class="block">${sectionHead(n, 'ChatGPT Model Mix')}${live.chatgptTrends ? barsHtml(cgModelItems(live.chatgptTrends), 110) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cg-dept':
      return `<section class="block">${sectionHead(n, 'Conversations by Department')}${live.chatgptTrends ? barsHtml(cgDeptItems(live.chatgptTrends), 110) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cg-hours':
      return `<section class="block">${sectionHead(n, 'ChatGPT Peak Usage Hours')}${live.chatgptTrends ? barsHtml(cgHourItems(live.chatgptTrends), 40) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cg-users':
      return `<section class="block">${sectionHead(n, 'ChatGPT Top Users')}${live.chatgptUsers ? simpleTableHtml(['#', 'User', 'Department', 'Conversations', 'Prompts', 'Avg Depth'], cgUserRows(live.chatgptUsers)) : '<p class="muted">No data available.</p>'}</section>`;
    // ---- User Intelligence ----
    case 'live-ua-daily':
      return `<section class="block">${sectionHead(n, 'Daily Active Users')}${live.activityTrends ? barsHtml(uaDailyItems(live.activityTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-ua-session':
      return `<section class="block">${sectionHead(n, 'Average Session Duration (min)')}${live.activityTrends ? barsHtml(uaSessionItems(live.activityTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-ua-dept':
      return `<section class="block">${sectionHead(n, 'Active Users by Department')}${live.activityTrends ? barsHtml(uaDeptItems(live.activityTrends), 110) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-maturity-dist':
      return `<section class="block">${sectionHead(n, 'AI Maturity Distribution')}${live.powerUsers ? barsHtml(maturityItems(live.powerUsers), 100) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-power-users-table':
      return `<section class="block">${sectionHead(n, 'Power Users')}${live.powerUsers ? simpleTableHtml(['#', 'User', 'Department', 'Generations', 'Credits', 'Active Days', 'Level', 'Score'], powerUserRows(live.powerUsers)) : '<p class="muted">No data available.</p>'}</section>`;
    // ---- Task Intelligence ----
    case 'live-task-trend':
      return `<section class="block">${sectionHead(n, 'Tasks Created vs Completed')}${live.tasksTrends ? simpleTableHtml(['Date', 'Created', 'Completed'], taskDailyRows(live.tasksTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-task-dept':
      return `<section class="block">${sectionHead(n, 'Tasks by Department')}${live.tasksTrends ? simpleTableHtml(['Department', 'Created', 'Completed', 'Completion'], taskDeptRows(live.tasksTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-task-priority':
      return `<section class="block">${sectionHead(n, 'Tasks by Priority')}${live.tasksTrends ? simpleTableHtml(['Priority', 'Created', 'Completed', 'Completion'], taskPriorityRows(live.tasksTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-ai-cohorts':
      return `<section class="block">${sectionHead(n, 'AI vs Non-AI Cohorts')}${live.aiImpact ? simpleTableHtml(['Cohort', 'Users', 'Tasks', 'Completed', 'Per User', 'Completion', 'Avg Cycle (h)'], aiCohortRows(live.aiImpact)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-ai-dept':
      return `<section class="block">${sectionHead(n, 'Department: AI Adoption vs Productivity')}${live.aiImpact ? simpleTableHtml(['Department', 'AI Adoption', 'Completed / User', 'Users'], aiDeptRows(live.aiImpact)) : '<p class="muted">No data available.</p>'}</section>`;
    // ---- Prompt Intelligence ----
    case 'live-prompt-volume':
      return `<section class="block">${sectionHead(n, 'Prompt Volume')}${live.promptsTrends ? barsHtml(promptVolumeItems(live.promptsTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-prompt-success':
      return `<section class="block">${sectionHead(n, 'Prompt Success Rate Over Time')}${live.promptsTrends ? barsHtml(promptSuccessItems(live.promptsTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-prompt-themes':
      return `<section class="block">${sectionHead(n, 'Top Prompt Themes')}${live.promptsTrends ? barsHtml(promptThemeItems(live.promptsTrends), 110) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-prompt-models':
      return `<section class="block">${sectionHead(n, 'Prompt Success by Model')}${live.promptsTrends ? simpleTableHtml(['Model', 'Prompts', 'Success Rate'], promptModelRows(live.promptsTrends)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-golden-table':
      return `<section class="block">${sectionHead(n, 'Golden Prompt Library')}${live.golden ? simpleTableHtml(['Prompt', 'Uses', 'Success', 'Users', 'Credits', 'Creator'], goldenRows(live.golden)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-engineers-table':
      return `<section class="block">${sectionHead(n, 'Prompt Engineers')}${live.engineers ? simpleTableHtml(['Engineer', 'Department', 'Prompts', 'Unique', 'Success', 'Credits', 'Score'], engineerRows(live.engineers)) : '<p class="muted">No data available.</p>'}</section>`;
    // ---- Cost Intelligence ----
    case 'live-cost-trend':
      return `<section class="block">${sectionHead(n, 'Credit Spend Trend')}${live.costBreakdown ? barsHtml(costTrendItems(live.costBreakdown)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cost-dept':
      return `<section class="block">${sectionHead(n, 'Credit Spend by Department')}${live.costBreakdown ? barsHtml(costDeptItems(live.costBreakdown), 110) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cost-tool':
      return `<section class="block">${sectionHead(n, 'Credit Share by Tool')}${live.costBreakdown ? barsHtml(costToolItems(live.costBreakdown), 90) : '<p class="muted">No data available.</p>'}</section>`;
    case 'live-cost-spenders':
      return `<section class="block">${sectionHead(n, 'Top Credit Spenders')}${live.costBreakdown ? simpleTableHtml(['#', 'User', 'Department', 'Credits', 'Cost', 'Outputs', 'Cr/Output'], costSpenderRows(live.costBreakdown)) : '<p class="muted">No data available.</p>'}</section>`;
    case 'table': {
      const cols = block.columns || ['Project Phase', 'Target Date', 'Allocation', 'Status'];
      return `
        <section class="block">
          ${sectionHead(n, block.title || 'Structural Overview & Projections')}
          <table class="tbl">
            <thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
            <tbody>
              ${(block.rows || []).map((row) => `<tr>${cols.map((_c, ci) => `<td>${esc(row[ci] || '')}</td>`).join('')}</tr>`).join('')}
            </tbody>
          </table>
        </section>`;
    }
    default:
      return '';
  }
}

export function buildReportHtml({ branding = {}, blocks = [], live = {}, meta = {} }) {
  const isSpec = meta.kind === 'specification';
  const navy = branding.navy || '#101f3f';
  const gold = branding.gold || '#c99a2e';
  const grey = '#f4f6f8';
  const brand = branding.brandName || 'RITZ MEDIA WORLD';
  const year = new Date().getFullYear();
  const wordmarkParts = brand.split(' ');
  const wordmark = wordmarkParts.length > 1
    ? `${wordmarkParts.slice(0, -1).join(' ')} <strong>${wordmarkParts.slice(-1)}</strong>`
    : `<strong>${brand}</strong>`;

  const logoHtml = branding.logo
    ? `<img class="logo-img" src="${branding.logo}" alt="logo">`
    : `<div class="logo-mark">${EYE_LOGO_SVG}</div>`;

  const specRibbon = isSpec
    ? `<div style="background:#fdecec;border:1px solid #f3b4b4;color:#8a1c1c;padding:10px 14px;margin:0 0 14px;border-radius:8px;font-size:12.5px">
         <strong>ANALYTICS SPECIFICATION — planned analytics, not validated data.</strong>
         This document describes reports the platform is designed to produce; the underlying data is not yet captured for the selected questions.
       </div>`
    : '';
  const body = specRibbon + blocks.map((b, i) => blockHtml(b, i, live)).join('\n');
  const docTitle = `${esc(branding.title || 'Corporate Report')}${isSpec ? ' — Analytics Specification' : ''}`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${docTitle}</title>
<style>
  :root{ --navy:${navy}; --gold:${gold}; --grey:${grey}; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:#e9edf2; color:#1c2634;
    font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .toolbar{ position:sticky; top:0; z-index:10; display:flex; gap:10px; justify-content:flex-end;
    padding:12px 16px; background:#0c1526; }
  .toolbar button{ font-size:13px; font-weight:600; border:0; border-radius:8px; padding:9px 16px; cursor:pointer;
    background:var(--gold); color:#1c2634; }
  .toolbar button.ghost{ background:transparent; color:#e6ebf2; border:1px solid #33415a; }
  .page{ width:210mm; min-height:297mm; margin:16px auto; background:#fff; box-shadow:0 6px 30px rgba(0,0,0,.2); }
  .content{ padding:0 18mm 24mm; }

  /* Cover */
  .cover{ page-break-after:always; }
  .cover-bar{ height:16px; background:var(--gold); }
  .cover-hero{ background:var(--navy); color:#fff; padding:34mm 18mm 30mm; }
  .cover-brand{ display:flex; align-items:center; gap:14px; }
  .logo-img{ width:56px; height:56px; object-fit:contain; background:#fff1; border-radius:8px; }
  .logo-mark{ width:52px; height:52px; border-radius:10px; display:flex; align-items:center; justify-content:center;
    background:var(--gold); color:var(--navy); font-weight:800; font-size:20px; letter-spacing:.02em; }
  .cover-wordmark{ font-size:19px; letter-spacing:.18em; text-transform:uppercase; color:#e9edf5; }
  .cover-wordmark strong{ color:var(--gold); }
  .cover-title-wrap{ padding:26mm 18mm 0; }
  .cover-title{ font-size:40px; line-height:1.1; font-weight:800; color:var(--navy); margin:0 0 14px; max-width:16ch; }
  .cover-sub{ font-size:17px; letter-spacing:.14em; text-transform:uppercase; color:var(--gold); font-weight:600; margin:0; }
  .cover-meta{ margin:70mm 18mm 0; padding-top:16px; border-top:1px solid #d5dbe4;
    display:grid; grid-template-columns:1fr 1fr; gap:8px 24px; font-size:13px; color:#5a6675; }
  .cover-meta b{ color:#1c2634; }

  /* Sections */
  .content{ padding-top:20mm; }
  h2.sec{ font-size:20px; color:var(--navy); margin:0 0 8px; padding-bottom:8px; border-bottom:2px solid var(--gold); }
  h2.sec .sec-n{ color:var(--gold); }
  .block{ margin:0 0 22px; break-inside:avoid; }
  p.lead{ background:var(--grey); border-left:4px solid var(--gold); padding:12px 14px; font-size:13.5px; color:#2b3646; margin:12px 0; border-radius:0 6px 6px 0; }
  p.body{ font-size:13.5px; line-height:1.6; color:#2b3646; }
  p.muted{ font-size:13px; color:#8a95a4; }
  p.qline{ margin:8px 0 10px; padding:7px 11px; font-size:12px; color:#3c4756; background:#f4f6fa; border-left:3px solid var(--navy); border-radius:0 5px 5px 0; }
  p.qline strong{ color:var(--navy); letter-spacing:.02em; }
  .thread{ display:flex; flex-direction:column; gap:7px; margin-top:6px; }
  .msg{ display:grid; grid-template-columns:66px 1fr; gap:8px; align-items:start; page-break-inside:avoid; }
  .msg-role{ padding:2px 6px; font-size:9px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; text-align:center; border-radius:3px; }
  .msg.u .msg-role{ color:#fff; background:var(--navy); }
  .msg.a .msg-role{ color:#2b3646; background:#e7ebf1; }
  .msg-body{ padding:6px 9px; font-size:11.5px; line-height:1.5; color:#2b3646; background:#f7f9fc; border:1px solid #e3e8ef; border-radius:5px; white-space:pre-wrap; overflow-wrap:anywhere; }
  h3.subsec{ font-size:14px; color:var(--navy); margin:16px 0 6px; text-transform:uppercase; letter-spacing:.06em; }
  .qmeta{ display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-top:6px; }
  .qmeta-item{ border:1px solid #e3e8ee; border-left:3px solid var(--gold); border-radius:6px; padding:9px 12px; }
  .qmeta-lab{ display:block; font-size:10px; letter-spacing:.08em; text-transform:uppercase; color:#8a95a4; font-weight:700; margin-bottom:2px; }
  .qmeta-val{ font-size:13px; color:#1c2634; font-weight:500; }

  /* KPI cards */
  .kpis{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:8px 0; }
  .kpi{ background:var(--navy); border-radius:8px; padding:22px 14px; text-align:center; }
  .kpi-value{ font-size:30px; font-weight:800; color:var(--gold); line-height:1; }
  .kpi-label{ margin-top:8px; font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:#c4ccd8; }

  /* Table */
  table.tbl{ width:100%; border-collapse:collapse; font-size:13px; }
  table.tbl th{ background:var(--navy); color:#fff; text-align:left; padding:11px 14px; font-weight:600; }
  table.tbl td{ padding:11px 14px; color:#2b3646; border-bottom:1px solid #e6eaf0; }
  table.tbl tbody tr:nth-child(even){ background:var(--grey); }

  /* Faint tiled brand watermark behind the report body. Sits on .content so the
     cover stays clean, and repeats naturally across every printed page. */
  .content{ background-image:url("${WATERMARK_URL}"); background-repeat:repeat; background-position:center top; }
  .content > *{ position:relative; }

  .logo-mark svg{ display:block; width:100%; height:100%; }
  .foot-eye{ width:16px; height:16px; vertical-align:-3px; margin-right:6px; display:inline-block; }
  .foot-eye svg{ display:block; width:100%; height:100%; }

  .docfoot{ margin-top:10mm; padding:10px 18mm; border-top:1px solid #e0e5ec; font-size:11px; color:#8a95a4;
    display:flex; justify-content:space-between; }

  /* Browsers drop background colours when printing unless told otherwise, which
     would strip the navy cover, the KPI cards, the table headers and the zebra
     rows — i.e. the entire corporate template. Force them everywhere. */
  html{ -webkit-print-color-adjust:exact; print-color-adjust:exact; }

  @media print{
    *, *::before, *::after{
      -webkit-print-color-adjust:exact !important;
      print-color-adjust:exact !important;
    }
    html,body{ background:#fff; }
    .toolbar{ display:none; }
    .page{ width:auto; min-height:auto; margin:0; box-shadow:none; }
    /* Keep the cover full-bleed and on its own sheet. */
    .cover{ page-break-after:always; break-after:page; }
    .cover-hero{ padding:34mm 18mm 30mm; }
    /* Don't split a section or a table row across sheets. */
    .block{ break-inside:avoid; page-break-inside:avoid; }
    h2.sec{ break-after:avoid; page-break-after:avoid; }
    table.tbl{ break-inside:auto; }
    table.tbl tr{ break-inside:avoid; page-break-inside:avoid; }
    table.tbl thead{ display:table-header-group; }
    .kpis{ break-inside:avoid; page-break-inside:avoid; }
    @page{ size:A4; margin:0; }
  }
</style></head>
<body>
  <div class="toolbar">
    <button class="ghost" onclick="window.close()">Close</button>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>

  <div class="page">
    <!-- Cover -->
    <div class="cover">
      <div class="cover-bar"></div>
      <div class="cover-hero">
        <div class="cover-brand">${logoHtml}<span class="cover-wordmark">${wordmark}</span></div>
      </div>
      <div class="cover-title-wrap">
        <h1 class="cover-title">${esc(branding.title || 'Corporate Performance & Strategic Growth Report')}</h1>
        <p class="cover-sub">${esc(branding.subtitle || 'AI Intelligence Report')}</p>
      </div>
      <div class="cover-meta">
        <span>Prepared For: <b>${esc(branding.preparedFor || 'Executive Board')}</b></span>
        <span>Date: <b>${esc(branding.date || new Date().toLocaleDateString())}</b></span>
        <span>Prepared By: <b>${esc(branding.preparedBy || 'Analytics & BI Office')}</b></span>
        <span>Document ID: <b>${esc(branding.docId || `RMW-${year}-AI01`)}</b></span>
      </div>
    </div>

    <!-- Body -->
    <div class="content">
      ${body || '<p class="muted">Add questions or data blocks to build the report.</p>'}
      <div class="docfoot">
        <span><span class="foot-eye">${EYE_LOGO_SVG}</span>${esc(brand)} © ${year} | ${esc(branding.confidential || 'Confidential')}</span>
        <span>AI Intelligence Report</span>
      </div>
    </div>
  </div>
</body></html>`;
}

export default buildReportHtml;
