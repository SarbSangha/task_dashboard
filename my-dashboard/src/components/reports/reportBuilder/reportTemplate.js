// Generates a self-contained, print-ready report in the Ritz Media World
// template style (navy + gold cover, KPI cards, tables, numbered sections).
// Returns a complete HTML document string suitable for an <iframe srcdoc> or a new tab.

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

// Exposed so the builder can bake live values into a saved definition (snapshotItems).
export const liveSnapshotItems = (kind, live) => {
  if (kind === 'live-exec') return live?.exec ? execKpis(live.exec) : [];
  if (kind === 'live-kling') return live?.kling ? klingKpis(live.kling) : [];
  if (kind === 'live-cost') return live?.cost ? costKpis(live.cost) : [];
  if (kind === 'live-users') return live?.users ? usersKpis(live.users) : [];
  if (kind === 'live-tasks') return live?.tasks ? tasksKpis(live.tasks) : [];
  if (kind === 'live-prompts') return live?.prompts ? promptsKpis(live.prompts) : [];
  if (kind === 'live-chatgpt') return live?.chatgpt ? chatgptKpis(live.chatgpt) : [];
  return [];
};

const kpiCardsHtml = (items) => `
  <div class="kpis">
    ${items.map((it) => `
      <div class="kpi">
        <div class="kpi-value">${esc(it.value)}</div>
        <div class="kpi-label">${esc(it.label)}</div>
      </div>`).join('')}
  </div>`;

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

function blockHtml(block, idx, live) {
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
    : `<div class="logo-mark">${esc(brand.replace(/[^A-Za-z]/g, '').slice(0, 2).toUpperCase() || 'R')}</div>`;

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

  .docfoot{ margin-top:10mm; padding:10px 18mm; border-top:1px solid #e0e5ec; font-size:11px; color:#8a95a4;
    display:flex; justify-content:space-between; }

  @media print{
    html,body{ background:#fff; }
    .toolbar{ display:none; }
    .page{ width:auto; min-height:auto; margin:0; box-shadow:none; }
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
        <span>${esc(brand)} © ${year} | ${esc(branding.confidential || 'Confidential')}</span>
        <span>AI Intelligence Report</span>
      </div>
    </div>
  </div>
</body></html>`;
}

export default buildReportHtml;
