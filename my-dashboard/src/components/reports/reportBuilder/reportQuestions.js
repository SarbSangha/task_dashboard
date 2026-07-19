// Curated question library for the custom Report Builder.
// Each question carries the context needed to render it as a report section.
// Grounded in the Reports module's real metrics.

export const QUESTION_CATEGORIES = [
  'Executive', 'Kling', 'ChatGPT', 'Cost', 'User', 'Prompt', 'Task', 'Recommendations',
];

const RAW_QUESTIONS = [
  // Executive
  { id: 'q-ex-1', cat: 'Executive', q: 'How many people are actively using the platform, and is it growing?', why: 'The headline signal for whether the AI investment is taking root.', metric: 'Active Users + MoM growth %', decision: 'Set the pace of rollout and enablement.' },
  { id: 'q-ex-2', cat: 'Executive', q: 'Is AI adoption accelerating or plateauing?', why: 'Distinguishes durable transformation from an early spike.', metric: 'Adoption growth rate', decision: 'Reallocate change-management budget.' },
  { id: 'q-ex-3', cat: 'Executive', q: 'What is the measurable ROI of AI adoption to date?', why: 'Board-level accountability for spend vs return.', metric: 'Net ROI % (requires baseline)', decision: 'Set the next fiscal AI budget.' },
  { id: 'q-ex-4', cat: 'Executive', q: 'Which departments benefit most — and least — from AI?', why: 'Reveals where transformation is real vs stalled.', metric: 'AI value contribution by department', decision: 'Target training and re-investment.' },
  { id: 'q-ex-5', cat: 'Executive', q: 'What is the total cost of AI operations, and is it under control?', why: 'Prevents runaway consumption eroding ROI.', metric: 'Total AI spend + cost per active user', decision: 'Set consumption guardrails.' },
  { id: 'q-ex-6', cat: 'Executive', q: 'Are we producing more output as adoption grows?', why: 'Connects usage to real throughput, not vanity metrics.', metric: 'Output per active user', decision: 'Confirm usage is producing value.' },

  // Kling
  { id: 'q-kl-1', cat: 'Kling', q: 'How many videos did users generate from Kling in the period?', why: 'Core output measure for the primary video engine.', metric: 'Total Kling videos + trend', decision: 'Plan credit capacity for demand.' },
  { id: 'q-kl-2', cat: 'Kling', q: 'Who are the top Kling creators?', why: 'Identifies power users and champions.', metric: 'Videos + success rate per user', decision: 'Recognise and scale their practices.' },
  { id: 'q-kl-3', cat: 'Kling', q: 'Which departments generate the most video content?', why: 'Shows where video work concentrates.', metric: 'Videos by department', decision: 'Allocate credits to heavy teams.' },
  { id: 'q-kl-4', cat: 'Kling', q: 'What is the Kling generation success rate?', why: 'Reliability drains time, credits and trust.', metric: 'Success vs failure %', decision: 'Escalate reliability fixes.' },
  { id: 'q-kl-5', cat: 'Kling', q: 'When are peak Kling usage hours?', why: 'Peaks drive capacity and support planning.', metric: 'Generations by hour', decision: 'Align capacity to peaks.' },
  { id: 'q-kl-6', cat: 'Kling', q: 'How much Kling credit does each user consume in the selected period?', why: 'Shows which users/accounts drive credit spend so budgets and caps can be targeted.', metric: 'Credits & ₹ cost per Kling account (user), for the date range', decision: 'Cap or coach the heaviest consumers; plan credit purchases.' },

  // ChatGPT
  { id: 'q-cg-1', cat: 'ChatGPT', q: 'How much is ChatGPT being used across the org?', why: 'Measures conversational-AI adoption.', metric: 'Conversations · prompts · users', decision: 'Size support and seats.' },
  { id: 'q-cg-2', cat: 'ChatGPT', q: 'Which GPT models are used most?', why: 'Model mix drives cost and capability policy.', metric: 'Model share %', decision: 'Guide model routing and governance.' },
  { id: 'q-cg-3', cat: 'ChatGPT', q: 'Who are the ChatGPT power users?', why: 'Finds heavy adopters and champions.', metric: 'Conversations + prompts per user', decision: 'Convert to internal mentors.' },
  { id: 'q-cg-4', cat: 'ChatGPT', q: 'How deep are conversations (prompts per chat)?', why: 'Signals prompting sophistication.', metric: 'Avg prompts per conversation', decision: 'Target prompting enablement.' },

  // Cost
  { id: 'q-co-1', cat: 'Cost', q: 'What is total AI cost (credits) and where does it go?', why: 'You cannot optimise what you cannot see.', metric: 'Total credits + breakdown', decision: 'Target the largest cost buckets.' },
  { id: 'q-co-2', cat: 'Cost', q: 'How much spend is wasted on failed generations?', why: 'Waste is the fastest cost to recover.', metric: 'Wasted credits + %', decision: 'Fund reliability fixes.' },
  { id: 'q-co-3', cat: 'Cost', q: 'What is the cost per successful output?', why: 'Unit economics decide whether to scale.', metric: 'Credits per successful output', decision: 'Optimise models and prompts.' },
  { id: 'q-co-4', cat: 'Cost', q: 'Which departments and tools drive the most spend?', why: 'Concentration guides budgets and caps.', metric: 'Credit share by dept and tool', decision: 'Allocate budgets and set caps.' },

  // User
  { id: 'q-us-1', cat: 'User', q: 'What are our DAU / WAU / MAU?', why: 'The canonical engagement denominators.', metric: 'DAU · WAU · MAU + stickiness', decision: 'Track engagement cadence.' },
  { id: 'q-us-2', cat: 'User', q: 'Do users keep using AI after first adoption?', why: 'Retention is the truest signal of value.', metric: 'D1 / D7 / D30 cohort retention', decision: 'Fix the week retention collapses.' },
  { id: 'q-us-3', cat: 'User', q: 'Who are our AI champions?', why: 'Champions hold the playbook worth spreading.', metric: 'AI Maturity Score + level', decision: 'Stand up a mentor program.' },
  { id: 'q-us-4', cat: 'User', q: 'What is the workforce AI-maturity distribution?', why: 'Sizes the enablement gap.', metric: 'Users per maturity level', decision: 'Plan enablement investment.' },
  { id: 'q-us-5', cat: 'User', q: 'Who is at risk of disengaging?', why: 'Early signals enable cheap intervention.', metric: 'Churn-risk user count', decision: 'Trigger re-engagement.' },

  // Prompt
  { id: 'q-pr-1', cat: 'Prompt', q: 'Which prompts consistently generate successful outputs?', why: 'Best prompts become reusable templates.', metric: 'Prompt success rate', decision: 'Promote to a golden library.' },
  { id: 'q-pr-2', cat: 'Prompt', q: 'What are our golden prompts, and who created them?', why: 'Institutional AI knowledge worth sharing.', metric: 'Uses × success rate', decision: 'Publish to a shared library.' },
  { id: 'q-pr-3', cat: 'Prompt', q: 'Who are our best prompt engineers?', why: 'Identifies who improves AI for everyone.', metric: 'Prompt Performance Score', decision: 'Recruit as champions.' },
  { id: 'q-pr-4', cat: 'Prompt', q: 'Are users getting better at prompting over time?', why: 'Measures enablement impact honestly.', metric: 'Prompt success rate over time', decision: 'Sustain or change coaching.' },

  // Task
  { id: 'q-ta-1', cat: 'Task', q: 'How much work is getting completed, and how fast?', why: 'The business-outcome layer of adoption.', metric: 'Completed + avg cycle time', decision: 'Set throughput targets and SLAs.' },
  { id: 'q-ta-2', cat: 'Task', q: 'Do AI-active users complete more tasks than non-AI users?', why: 'The honest AI value signal (correlation).', metric: 'Cohort throughput delta', decision: 'Justify and scale enablement.' },
  { id: 'q-ta-3', cat: 'Task', q: 'Where are the biggest bottlenecks?', why: 'Bottlenecks cap the whole process throughput.', metric: 'Dwell time by status', decision: 'Re-resource the slowest stage.' },
  { id: 'q-ta-4', cat: 'Task', q: 'Are we delivering on time?', why: 'Reliability of delivery is an operational promise.', metric: 'On-time completion %', decision: 'Adjust capacity or commitments.' },

  // Recommendations
  { id: 'q-re-1', cat: 'Recommendations', q: 'What are the highest-value next actions?', why: 'Turns insight into evidence-based decisions.', metric: 'Ranked recommendations + confidence', decision: 'Fund the highest-confidence actions.' },
  { id: 'q-re-2', cat: 'Recommendations', q: 'Which departments need an enablement drive?', why: 'Directs enablement where the gap is largest.', metric: 'Adoption gap vs org average', decision: 'Run targeted enablement.' },
  { id: 'q-re-3', cat: 'Recommendations', q: 'Where can we cut AI cost without losing value?', why: 'Protects margin as usage scales.', metric: 'Waste % and cost outliers', decision: 'Route, cap or renegotiate.' },
];

// Per-question data readiness, grounded in what the platform actually captures.
// level: 'available' (data exists) | 'needs_capture' (partial/degenerate) | 'future' (not captured / needs a model).
// `note` explains a partial/missing case so the generated report can say WHY.
const READINESS = {
  // Executive
  'q-ex-1': { readiness: 'available' },
  'q-ex-2': { readiness: 'available' },
  'q-ex-3': { readiness: 'future', dataNote: 'ROI needs a pre-AI productivity baseline that is not captured' },
  'q-ex-4': { readiness: 'needs_capture', dataNote: 'per-department AI value needs employee→generation attribution' },
  'q-ex-5': { readiness: 'needs_capture', dataNote: 'total ₹ is available; the per-department split is not attributable yet' },
  'q-ex-6': { readiness: 'needs_capture', dataNote: 'output-per-user needs per-employee attribution' },
  // Kling
  'q-kl-1': { readiness: 'available' },
  'q-kl-2': { readiness: 'needs_capture', dataNote: 'Kling runs under shared logins, so it resolves to accounts, not individual creators' },
  'q-kl-3': { readiness: 'future', dataNote: 'department is not captured on Kling generations (single shared ADMIN login)' },
  'q-kl-4': { readiness: 'needs_capture', dataNote: 'every generation is captured as “active” — real failure status is not recorded' },
  'q-kl-5': { readiness: 'available' },
  'q-kl-6': { readiness: 'available', dataNote: 'attributed to the person who generated (captured per generation); a small share logs under the shared Administrator account' },
  // ChatGPT
  'q-cg-1': { readiness: 'available' },
  'q-cg-2': { readiness: 'available' },
  'q-cg-3': { readiness: 'needs_capture', dataNote: 'per-user ChatGPT attribution is partial' },
  'q-cg-4': { readiness: 'available' },
  // Cost
  'q-co-1': { readiness: 'needs_capture', dataNote: 'total credits/₹ available; department/tool breakdown is partial' },
  'q-co-2': { readiness: 'needs_capture', dataNote: 'waste needs real failure status (all generations are “active”)' },
  'q-co-3': { readiness: 'needs_capture', dataNote: 'needs a real success signal to isolate successful outputs' },
  'q-co-4': { readiness: 'needs_capture', dataNote: 'per-department spend needs employee attribution' },
  // User
  'q-us-1': { readiness: 'available' },
  'q-us-2': { readiness: 'available' },
  'q-us-3': { readiness: 'needs_capture', dataNote: 'maturity score inputs are partial' },
  'q-us-4': { readiness: 'needs_capture' },
  'q-us-5': { readiness: 'needs_capture', dataNote: 'churn-risk scoring model not built yet' },
  // Prompt
  'q-pr-1': { readiness: 'needs_capture', dataNote: 'prompt success needs a real success signal' },
  'q-pr-2': { readiness: 'needs_capture' },
  'q-pr-3': { readiness: 'needs_capture', dataNote: 'per-engineer attribution is partial under shared logins' },
  'q-pr-4': { readiness: 'needs_capture' },
  // Task
  'q-ta-1': { readiness: 'available' },
  'q-ta-2': { readiness: 'needs_capture', dataNote: 'cohort delta needs AI usage tied to individuals' },
  'q-ta-3': { readiness: 'available' },
  'q-ta-4': { readiness: 'available' },
  // Recommendations
  'q-re-1': { readiness: 'needs_capture' },
  'q-re-2': { readiness: 'needs_capture' },
  'q-re-3': { readiness: 'needs_capture', dataNote: 'depends on real failure/waste capture' },
};

export const REPORT_QUESTIONS = RAW_QUESTIONS.map((q) => ({
  ...q,
  readiness: READINESS[q.id]?.readiness || 'needs_capture',
  dataNote: READINESS[q.id]?.dataNote || '',
}));

export const READINESS_META = {
  available: { badge: '✅', label: 'Data available', color: '#15803d' },
  needs_capture: { badge: '🟡', label: 'Partial data', color: '#b45309' },
  future: { badge: '🔴', label: 'No data captured yet', color: '#b91c1c' },
};

// Question -> live answer binding. `api` is a reportsAPI method; `items` are
// [dotted-path-into-response, label, unit?]. Only questions with real data are
// bound; the report then renders the actual numbers instead of a placeholder.
export const ANSWER_BINDINGS = {
  // Executive
  'q-ex-1': { api: 'usersSummary', items: [['kpis.activeUsers.value', 'Active users'], ['kpis.avgSessionMinutes.value', 'Avg session', 'min']] },
  'q-ex-2': { api: 'executive', items: [['kpis.aiAdoptionRate.value', 'AI adoption', '%'], ['kpis.aiGenerations.value', 'AI generations']] },
  'q-ex-5': { api: 'costSummary', items: [['kpis.totalCost.value', 'Total cost', '₹'], ['kpis.totalCredits.value', 'Total credits']] },
  'q-ex-6': { api: 'executive', items: [['kpis.aiGenerations.value', 'AI generations'], ['kpis.activeUsers.value', 'Active users']] },
  // Kling
  'q-kl-1': { api: 'klingSummary', items: [['kpis.totalVideos.value', 'Total videos'], ['kpis.creditsConsumed.value', 'Credits', 'cr'], ['kpis.uniqueUsers.value', 'Accounts']] },
  'q-kl-2': { api: 'klingSummary', items: [['kpis.uniqueUsers.value', 'Active accounts'], ['kpis.avgVideosPerUser.value', 'Avg videos/account']] },
  'q-kl-4': { api: 'klingSummary', items: [['kpis.successRate.value', 'Success rate', '%']] },
  'q-kl-5': { api: 'klingTiming', items: [['peakHour.hour', 'Peak hour (IST)'], ['peakDay.day', 'Busiest day']] },
  // Table answer: credit consumption per generating PERSON for the date range
  // (splits shared Kling accounts back to the individual, via usage-event user_id).
  'q-kl-6': {
    api: 'klingAccountsByUser',
    table: {
      columns: ['User', 'Email', 'Generations', 'Credits', 'Cost', 'Share'],
      rows: (d) => (d.accounts || []).slice(0, 200).map((a) => [
        a.label,
        a.accountEmail || '',
        Number(a.generations || 0).toLocaleString(),
        Number(a.credits || 0).toLocaleString(undefined, { maximumFractionDigits: 1 }),
        `${d.currency || 'INR'} ${Number(a.cost || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`,
        `${a.creditSharePct ?? 0}%`,
      ]),
    },
  },
  // ChatGPT
  'q-cg-1': { api: 'chatgptSummary', items: [['kpis.conversations.value', 'Conversations'], ['kpis.prompts.value', 'Prompts'], ['kpis.uniqueUsers.value', 'Users']] },
  'q-cg-4': { api: 'chatgptSummary', items: [['kpis.avgPromptsPerConversation.value', 'Prompts/chat']] },
  // Cost
  'q-co-1': { api: 'costSummary', items: [['kpis.totalCredits.value', 'Total credits'], ['kpis.totalCost.value', 'Total cost', '₹']] },
  'q-co-2': { api: 'costSummary', items: [['kpis.wastedCredits.value', 'Wasted credits'], ['wastedPct', 'Wasted', '%']] },
  'q-co-3': { api: 'costSummary', items: [['kpis.costPerOutput.value', 'Credits/output']] },
  // User
  'q-us-1': { api: 'usersSummary', items: [['kpis.activeUsers.value', 'Active users'], ['kpis.avgSessionMinutes.value', 'Avg session', 'min']] },
  // Task
  'q-ta-1': { api: 'tasksSummary', items: [['kpis.tasksCompleted.value', 'Tasks completed'], ['kpis.avgCycleHours.value', 'Avg cycle', 'h']] },
  'q-ta-4': { api: 'tasksSummary', items: [['kpis.onTimeRate.value', 'On-time', '%']] },
};

const getPath = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

export const resolveAnswerItems = (binding, data) =>
  binding.items.map(([path, label, unit]) => {
    let v = getPath(data, path);
    if (v === null || v === undefined || v === '') return { label, value: '—' };
    if (typeof v === 'number') v = Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return { label, value: unit ? `${v} ${unit}` : `${v}` };
  });

export const resolveAnswerTable = (binding, data) => ({
  columns: binding.table.columns,
  rows: binding.table.rows(data) || [],
});

export const answerApiFor = (id) => ANSWER_BINDINGS[id]?.api || null;
