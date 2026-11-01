(function installRmwFigmaNetworkTelemetry() {
  if (window.__rmwFigmaNetworkTelemetryInstalled) return;
  window.__rmwFigmaNetworkTelemetryInstalled = true;

  // MAIN-world interceptor for Figma's AI agent (figma.com). Same reason as
  // every other *-network.js here: only MAIN world sees the page's own fetch.
  //
  // Confirmed live (2026-10-30, Starter plan, agent in Figma Design):
  //   POST /api/cortex/assistant/chat
  //     body: {message: {clientId, createdAtMs, role: "user", content: [{type: "text", text}], ...},
  //            thread: {threadId, fileKey, startFileSeqNum}, userMessageOrigin: "assistant-thread", ...}
  //     -> text/event-stream of `data: {...}` lines (tool-call*, reasoning, text-delta,
  //        usage-info {turnActivity: {toolUseMs, numToolCalls, numLlmCalls}}, prompt-outcome, ...)
  //        and an x-cortex-request-uuid response header
  //   GET /api/files/{fileKey}/ai_credits/plan_user_action_credit_usage?user_action_uuid={message.clientId}
  //     -> {meta: {total_credit_usage, total_credit_cost, policy_totals}}  (what the credits icon shows)
  //   GET /api/plans/{planId}/ai_credits/plan_user_usage_summary
  //     -> {meta: {usage_summary: {metering_period, usage_buckets: [{type: "seat",
  //          balances: [{total, consumed, remaining}], daily_usage: {total, consumed}}]}}}
  // message.clientId IS the user_action_uuid: three prompts priced 24, 8 and 4
  // here matched the batch total (36) and the account's monthly "consumed".
  // The same text costs differently each time, so only Figma's number is used.
  //
  // This file reads; content-figma-capture.js forwards to the extension.
  const SOURCE = 'rmw-figma-network-telemetry';
  const CHAT_PATH_RE = /^\/api\/cortex\/assistant\/chat\/?$/;
  const PLAN_IN_URL_RE = /\/api\/plans\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\//i;
  const PLAN_PARAM_RE = /[?&]plan_id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  // A prompt's credits keep growing after its reply stream ends - when the
  // agent stops to ask a question the stream closes within ~100ms while the
  // agent works on for 15s+ (seen live: 8 at +10s, 10 a few seconds later).
  // So the cost is read until it holds still, and re-read for a while after.
  const CREDIT_CHECK_DELAYS_MS = [3000, 5000, 8000, 12000, 20000, 30000, 45000];
  const CREDIT_SETTLE_MIN_MS = 20000;            // never settle sooner than this after the reply
  const CREDIT_RECHECK_EVERY_MS = 60000;         // then re-read recent prompts this often...
  const CREDIT_RECHECK_FOR_MS = 20 * 60 * 1000;  // ...for this long, reporting any change
  const MAX_PROMPT_TEXT_CHARS = 20000;

  const rawFetch = window.fetch;
  let sniffedPlanId = null;

  function post(type, payload) {
    window.postMessage({ source: SOURCE, type, payload }, location.origin);
  }

  function pathOf(url) {
    try {
      const parsed = new URL(url, location.href);
      return parsed.origin === location.origin ? parsed.pathname : '';
    } catch {
      return '';
    }
  }

  function sniffPlanId(url) {
    const match = PLAN_IN_URL_RE.exec(url) || PLAN_PARAM_RE.exec(url);
    if (match) sniffedPlanId = match[1];
  }

  // window.INITIAL_OPTIONS.user_data also holds Figma's own tokens - read
  // the named fields below and nothing else.
  function pageContext() {
    const io = window.INITIAL_OPTIONS || {};
    const user = io.user_data || {};
    const file = io.editing_file || {};
    return {
      figmaUserId: user.id != null ? String(user.id) : null,
      figmaEmail: typeof user.email === 'string' ? user.email : null,
      planId: (typeof io.plan_id === 'string' && io.plan_id) || sniffedPlanId,
      planTier: typeof io.plan_tier === 'string' ? io.plan_tier : null,
      fileKey: typeof file.key === 'string' ? file.key : null,
      // INITIAL_OPTIONS describes the page Figma first loaded - stale after
      // opening a file from the file browser - so its name only counts when
      // its key matches the prompt's file; otherwise the tab title is used.
      fileName: typeof file.name === 'string' ? file.name : null,
      titleName: `${document.title || ''}`.replace(/\s+[–-]\s+Figma\s*$/, '').trim() || null,
    };
  }

  function figmaGet(path) {
    return rawFetch.call(window, path, {
      method: 'GET',
      credentials: 'include',
      headers: { 'X-Csrf-Bypass': 'yes' },
    }).then((response) => (response.ok ? response.json() : null)).catch(() => null);
  }

  // ---- balance ----
  let lastBalanceKey = '';

  async function reportBalance() {
    const ctx = pageContext();
    if (!ctx.planId) return;
    const body = await figmaGet(`/api/plans/${ctx.planId}/ai_credits/plan_user_usage_summary`);
    const summary = body?.meta?.usage_summary;
    const buckets = Array.isArray(summary?.usage_buckets) ? summary.usage_buckets : [];
    const bucket = buckets.find((b) => b?.type === 'seat') || buckets[0];
    const balance = (bucket?.balances || []).find((b) => b?.type === 'credit') || bucket?.balances?.[0];
    if (!balance) return;
    const payload = {
      figmaUserId: ctx.figmaUserId,
      figmaEmail: ctx.figmaEmail,
      planId: ctx.planId,
      planTier: ctx.planTier,
      periodStart: summary?.metering_period?.start_at || bucket?.starts_at || null,
      periodEnd: summary?.metering_period?.end_at || bucket?.expires_at || null,
      monthlyTotal: balance.total,
      monthlyConsumed: balance.consumed,
      monthlyRemaining: balance.remaining,
      dailyTotal: bucket?.daily_usage?.total ?? null,
      dailyConsumed: bucket?.daily_usage?.consumed ?? null,
      capturedAtMs: Date.now(),
    };
    const key = `${payload.periodStart}|${payload.monthlyConsumed}|${payload.dailyConsumed}`;
    if (key === lastBalanceKey) return;
    lastBalanceKey = key;
    post('FIGMA_BALANCE', payload);
  }

  // ---- one prompt ----
  async function readCredits(fileKey, uuid) {
    const body = await figmaGet(
      `/api/files/${encodeURIComponent(fileKey)}/ai_credits/plan_user_action_credit_usage?user_action_uuid=${encodeURIComponent(uuid)}`,
    );
    const usage = Number(body?.meta?.total_credit_usage);
    if (!body || !Number.isFinite(usage)) return null;
    const cost = Number(body?.meta?.total_credit_cost);
    return { credits: usage, creditCost: Number.isFinite(cost) ? cost : usage };
  }

  // Settled = the same non-zero figure twice in a row, at least
  // CREDIT_SETTLE_MIN_MS after the reply ended. Otherwise the last figure read.
  async function creditsFor(fileKey, uuid, finishedAtMs) {
    let last = null;
    for (let i = 0; i < CREDIT_CHECK_DELAYS_MS.length; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, CREDIT_CHECK_DELAYS_MS[i]));
      const now = await readCredits(fileKey, uuid);
      if (!now) continue;
      if (last && now.credits > 0 && now.credits === last.credits
          && Date.now() - finishedAtMs >= CREDIT_SETTLE_MIN_MS) {
        return { ...now, attempts: i + 1 };
      }
      last = now;
    }
    return last
      ? { ...last, attempts: CREDIT_CHECK_DELAYS_MS.length }
      : { credits: null, creditCost: null, attempts: CREDIT_CHECK_DELAYS_MS.length };
  }

  // Prompts already reported, re-read for a while in case Figma adds to them;
  // a changed figure is reported again (the backend keeps the newest).
  const recheck = new Map(); // uuid -> prompt record

  setInterval(async () => {
    for (const [uuid, rec] of recheck) {
      if (Date.now() - rec.finishedAtMs > CREDIT_RECHECK_FOR_MS) { recheck.delete(uuid); continue; }
      const now = await readCredits(rec.fileKey, uuid);
      if (now && now.credits !== rec.credits) {
        rec.credits = now.credits;
        rec.creditCost = now.creditCost;
        post('FIGMA_PROMPT', { ...rec });
        reportBalance();
      }
    }
  }, CREDIT_RECHECK_EVERY_MS);

  // When the agent stops to ask a question, the person's pick goes back as a
  // new user message (userMessageOrigin "mcp-client-side-tool-resume") whose
  // text is a <tool_result> block - Figma bills it as its own action. Show
  // the answer, not the markup.
  const TOOL_RESULT_RE = /^\s*<tool_result\b[^>]*>([\s\S]*?)<\/tool_result>\s*$/;

  function readableText(text) {
    const match = TOOL_RESULT_RE.exec(text);
    if (!match) return text;
    try {
      const result = JSON.parse(match[1].trim());
      const picked = Array.isArray(result?.selectedOptions) && result.selectedOptions.length
        ? result.selectedOptions.join(', ')
        : result?.message;
      if (picked) return `Answered the agent's question: ${picked}`;
    } catch {}
    return "Answered the agent's question";
  }

  function readPrompt(bodyText) {
    let body;
    try { body = JSON.parse(bodyText); } catch { return null; }
    const message = body?.message;
    const uuid = message?.clientId;
    if (!uuid || message?.role !== 'user') return null;
    const parts = Array.isArray(message.content) ? message.content : [];
    const text = readableText(parts.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n'));
    return {
      userActionUuid: String(uuid),
      threadId: body?.thread?.threadId ? String(body.thread.threadId) : null,
      fileKey: body?.thread?.fileKey ? String(body.thread.fileKey) : null,
      origin: typeof body?.userMessageOrigin === 'string' ? body.userMessageOrigin : null,
      promptText: text.slice(0, MAX_PROMPT_TEXT_CHARS),
      promptLength: text.length,
      promptedAtMs: Number(message.createdAtMs) || Date.now(),
    };
  }

  // Reads the event stream from a clone, so the page's own reader is untouched.
  async function readReply(response, copy, rec) {
    rec.requestUuid = response.headers.get('x-cortex-request-uuid');
    const reader = copy?.body?.getReader();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = '';
    const onEvent = (event) => {
      if (event?.type === 'usage-info') {
        const turn = event.turnActivity || {};
        rec.toolCalls = turn.numToolCalls ?? rec.toolCalls;
        rec.workMs = turn.toolUseMs ?? rec.workMs;
        rec.numLlmCalls = turn.numLlmCalls ?? rec.numLlmCalls;
      } else if (event?.type === 'prompt-outcome') {
        rec.outcome = `${event.outcome || event.status || 'completed'}`;
        try { rec.outcomeDetail = JSON.stringify(event).slice(0, 500); } catch {}
      } else if (event?.type === 'error') {
        rec.outcome = 'error';
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try { onEvent(JSON.parse(line.slice(5).trim())); } catch {}
      }
    }
  }

  const unreported = new Map(); // uuid -> prompt record, until sent

  async function trackPrompt(rec, replyPromise) {
    const ctx = pageContext();
    Object.assign(rec, {
      fileKey: rec.fileKey || ctx.fileKey,
      fileName: (rec.fileKey && ctx.fileKey && rec.fileKey !== ctx.fileKey ? null : ctx.fileName) || ctx.titleName,
      figmaUserId: ctx.figmaUserId,
      figmaEmail: ctx.figmaEmail,
      planId: ctx.planId,
      planTier: ctx.planTier,
      pageUrl: location.href,
    });
    unreported.set(rec.userActionUuid, rec);
    try {
      const { response, copy } = await replyPromise;
      if (!response.ok) rec.outcome = 'error';
      else await readReply(response, copy, rec);
    } catch {
      rec.outcome = rec.outcome || 'aborted'; // stopped by the person, or the connection dropped
    }
    rec.finishedAtMs = Date.now();
    rec.outcome = rec.outcome || 'completed';
    if (rec.fileKey) {
      const priced = await creditsFor(rec.fileKey, rec.userActionUuid, rec.finishedAtMs);
      rec.credits = priced.credits;
      rec.creditCost = priced.creditCost;
      rec.costAttempts = priced.attempts;
    }
    if (unreported.delete(rec.userActionUuid)) {
      post('FIGMA_PROMPT', { ...rec });
      if (rec.fileKey) recheck.set(rec.userActionUuid, rec);
    }
    reportBalance();
  }

  // Tab closing while a prompt is still being priced: send what is known;
  // the backend keeps it pending (no credits) rather than losing the prompt.
  window.addEventListener('pagehide', () => {
    for (const rec of unreported.values()) {
      post('FIGMA_PROMPT', { ...rec, credits: null, creditCost: null, finishedAtMs: rec.finishedAtMs || Date.now() });
    }
    unreported.clear();
  });

  // ---- fetch ----
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwFigmaFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const promise = rawFetch.apply(this, arguments);
      try {
        sniffPlanId(url);
        const method = `${(init && init.method) || (input && input.method) || 'GET'}`.toUpperCase();
        if (method === 'POST' && CHAT_PATH_RE.test(pathOf(url)) && typeof init?.body === 'string') {
          const rec = readPrompt(init.body);
          // Cloned as soon as the response exists - before the page's own
          // handlers (attached after this returns) can start reading it.
          if (rec) trackPrompt(rec, promise.then((response) => ({ response, copy: response.clone() })));
        }
      } catch {}
      return promise;
    };
  }

  // ---- XHR: only to learn the plan id from Figma's own calls ----
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    const rawOpen = OriginalXHR.prototype.open;
    OriginalXHR.prototype.open = function rmwFigmaXhrOpen(method, url, ...rest) {
      try { sniffPlanId(String(url)); } catch {}
      return rawOpen.call(this, method, url, ...rest);
    };
  }

  // The balance once per page, so the dashboard shows what is left even
  // before anyone prompts.
  setTimeout(() => { reportBalance().catch(() => {}); }, 8000);
})();
