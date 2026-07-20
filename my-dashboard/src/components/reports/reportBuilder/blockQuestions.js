// The business question each report block answers.
//
// Single source of truth: the dashboard shows it under the chart title, the
// "Move to canvas" tooltip explains what you are adding, and the generated
// report prints it above the block. Keeping one map means the on-screen
// question and the printed question can never drift apart.

export const BLOCK_QUESTIONS = {
  // ---- Executive ----
  'live-exec': 'How is AI performing across the organisation this period — adoption, output and spend?',
  'live-active-users': 'Who was actually active in this period, and how much time did each person spend?',
  'live-contributors': 'Who produced the output, and how concentrated is production in a few people?',

  // ---- Kling ----
  'live-kling': 'How much video is Kling producing, at what success rate and what credit cost?',
  'live-kling-trend': 'Is Kling video generation growing, flat or declining day to day?',
  'live-kling-dept': 'Which departments generate the most Kling video, and where is adoption thin?',
  'live-kling-hours': 'At what times of day (IST) does Kling usage peak, and when is capacity idle?',
  'live-kling-outcomes': 'What share of Kling generations succeed, and how much spend is lost to failures?',
  'live-kling-leaderboard': 'Who are the most productive Kling creators, and how reliable is their output?',

  // ---- ChatGPT ----
  'live-chatgpt': 'How heavily is ChatGPT used — conversations, prompts and people reached?',
  'live-cg-trend': 'Is ChatGPT conversation volume rising or falling over time?',
  'live-cg-models': 'Which ChatGPT models does the team actually rely on?',
  'live-cg-dept': 'Which departments have adopted ChatGPT, and which have not?',
  'live-cg-hours': 'When during the working day is ChatGPT used most?',
  'live-cg-users': 'Who are the heaviest ChatGPT users and how deep are their conversations?',
  'live-chat-timeline': 'On which days did this person actually use ChatGPT, and how intensively?',
  'live-chat-day': 'What conversations did this person have on this specific day?',
  'live-chat-messages': 'What was actually asked and answered in this conversation?',

  // ---- Cost ----
  'live-cost': 'What is AI costing us, and how efficiently is that spend converted into output?',
  'live-cost-trend': 'Is credit spend accelerating, and are there unexpected spikes to investigate?',
  'live-cost-dept': 'Which departments consume the most credits, and how should budget be allocated?',
  'live-cost-tool': 'How is spend split across AI tools, and is any single tool dominating cost?',
  'live-cost-spenders': 'Who are the biggest credit spenders, and is their output worth the spend?',

  // ---- Users ----
  'live-users': 'How many people are active, how habitually, and how long are their sessions?',
  'live-ua-daily': 'Is daily active usage growing, and are there drop-offs to explain?',
  'live-ua-session': 'How long do people actually spend in the product each day?',
  'live-ua-dept': 'Which departments are actively using the platform, and which are dormant?',
  'live-retention': 'Do people come back after their first use, or is usage one-and-done?',
  'live-power-users': 'How dependent is our output on a small group of power users?',
  'live-power-users-table': 'Who are the power users, and what do they produce relative to everyone else?',
  'live-maturity': 'How mature is the workforce in its AI usage overall?',
  'live-maturity-dist': 'How many people sit at each AI maturity level, and where is the training gap?',
  'live-user-timeline': 'When did this person log in, and how long were they active each day?',
  'live-user-generations': 'On which days did this person generate, and what did each day cost?',
  'live-user-day': 'What exactly did this person do on this day — tasks, tools and generations?',

  // ---- Tasks ----
  'live-tasks': 'Are tasks getting completed on time, and how long is the delivery cycle?',
  'live-task-trend': 'Is the team creating work faster than it completes it?',
  'live-task-dept': 'Which departments complete their work, and which are falling behind?',
  'live-task-priority': 'Are high-priority tasks being finished first, or are they lagging?',
  'live-task-contributors': 'Who raises work versus who receives it, and who actually finishes it?',
  'live-ai-impact': 'Do people who use AI deliver more work, and faster, than those who do not?',
  'live-ai-cohorts': 'How do AI-using and non-AI cohorts compare on throughput and cycle time?',
  'live-ai-dept': 'Does higher AI adoption in a department translate into higher productivity?',

  // ---- Prompts ----
  'live-prompts': 'How effective are our prompts, and how much prompt knowledge is being reused?',
  'live-prompt-volume': 'How much prompting activity is happening over time?',
  'live-prompt-success': 'Is prompt quality improving — are more prompts producing usable output?',
  'live-prompt-models': 'Which models give the best success rate for the prompts we write?',
  'live-prompt-themes': 'What subjects does the team prompt about most?',
  'live-prompt-contributors': 'Who writes the prompts, and who reuses proven ones instead of rewriting?',
  'live-prompt-timeline': 'On which days did this person prompt, and how repetitive were they?',
  'live-prompt-list': 'Which exact prompts were written, and how often was each reused?',
  'live-prompt-detail': 'Who uses this prompt, and what output does it actually produce?',
  'live-golden-prompts': 'How much proven, reusable prompt knowledge have we captured?',
  'live-golden-table': 'Which prompts are proven winners worth publishing as templates?',
  'live-prompt-leaderboard': 'Who are our strongest prompt engineers?',
  'live-engineers-table': 'How do prompt engineers rank on volume, success and reuse?',
};

export const questionFor = (kind) => BLOCK_QUESTIONS[kind] || '';

export default BLOCK_QUESTIONS;
