// Reads Cursor's local data (prompts + per-response tokens) and the account's
// usage events. Has no dependency on the VS Code API, so it can be tested in plain Node.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- locating Cursor's database ----------

function defaultDbPath() {
  const home = os.homedir();
  switch (process.platform) {
    case 'win32':
      return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'),
        'Cursor', 'User', 'globalStorage', 'state.vscdb');
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
    default:
      return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'),
        'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
}

// ---------- SQLite access (built-in node:sqlite first, sql.js fallback) ----------

async function openDb(dbPath) {
  if (!fs.existsSync(dbPath)) throw new Error(`Cursor database not found at ${dbPath}`);

  // 1) node:sqlite — reads the file in place, low memory.
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    return {
      all: (sql, params = []) => db.prepare(sql).all(...params),
      close: () => db.close(),
      engine: 'node:sqlite',
    };
  } catch (_) { /* not available in this runtime */ }

  // 2) sql.js (WebAssembly) — loads the whole file into memory.
  const initSqlJs = require('sql.js/dist/sql-wasm.js');
  const SQL = await initSqlJs({
    locateFile: f => path.join(path.dirname(require.resolve('sql.js/dist/sql-wasm.js')), f),
  });
  const db = new SQL.Database(fs.readFileSync(dbPath));
  return {
    all: (sql, params = []) => {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    close: () => db.close(),
    engine: 'sql.js',
  };
}

// ---------- helpers ----------

function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const s = String(v);
  if (/^\d+$/.test(s)) { const n = Number(s); return n < 1e12 ? n * 1000 : n; }
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function parseJson(s) { try { return JSON.parse(s); } catch { return null; } }

// ---------- reading auth from the database ----------

function readAuth(db) {
  const rows = db.all(
    "SELECT key, CAST(value AS TEXT) AS value FROM ItemTable WHERE key IN ('cursorAuth/accessToken','cursorAuth/cachedEmail','cursorAuth/stripeMembershipType')"
  );
  const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
  const token = m['cursorAuth/accessToken'];
  let userId = null;
  if (token) {
    const payload = parseJson(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8'));
    if (payload && payload.sub) userId = String(payload.sub).split('|').pop();
  }
  return {
    token: token || null,
    userId,
    email: m['cursorAuth/cachedEmail'] || null,
    plan: m['cursorAuth/stripeMembershipType'] || null,
  };
}

// ---------- reading prompts from the chat history ----------

/**
 * Returns one record per prompt you typed: the text, when it was sent,
 * and the tokens/models of every AI response that followed it.
 */
function readPrompts(db, { sinceMs = 0, includeText = true, maxTextChars = 4000 } = {}) {
  const hasTable = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='cursorDiskKV'").length > 0;
  if (!hasTable) return [];

  // Conversation names + message order
  const composers = new Map();
  for (const r of db.all(`
      SELECT key,
             json_extract(CAST(value AS TEXT), '$.name') AS name,
             json_extract(CAST(value AS TEXT), '$.createdAt') AS createdAt,
             json_extract(CAST(value AS TEXT), '$.fullConversationHeadersOnly') AS headers
      FROM cursorDiskKV WHERE key LIKE 'composerData:%'`)) {
    const id = String(r.key).slice('composerData:'.length);
    const headers = parseJson(r.headers) || [];
    composers.set(id, {
      name: r.name || null,
      createdAt: toMs(r.createdAt),
      order: new Map(headers.map((h, i) => [h.bubbleId, i])),
    });
  }

  // Individual messages ("bubbles")
  const byComposer = new Map();
  for (const r of db.all(`
      SELECT key,
             json_extract(CAST(value AS TEXT), '$.type') AS type,
             json_extract(CAST(value AS TEXT), '$.createdAt') AS createdAt,
             json_extract(CAST(value AS TEXT), '$.tokenCount.inputTokens') AS inTok,
             json_extract(CAST(value AS TEXT), '$.tokenCount.outputTokens') AS outTok,
             json_extract(CAST(value AS TEXT), '$.modelInfo.modelName') AS model,
             json_extract(CAST(value AS TEXT), '$.isAgentic') AS agentic,
             json_extract(CAST(value AS TEXT), '$.unifiedMode') AS mode,
             json_extract(CAST(value AS TEXT), '$.text') AS text
      FROM cursorDiskKV WHERE key LIKE 'bubbleId:%'`)) {
    const parts = String(r.key).split(':');
    if (parts.length < 3) continue;
    const composerId = parts[1];
    const bubbleId = parts.slice(2).join(':');
    if (!byComposer.has(composerId)) byComposer.set(composerId, []);
    byComposer.get(composerId).push({
      bubbleId,
      type: num(r.type),
      ts: toMs(r.createdAt),
      inTok: num(r.inTok),
      outTok: num(r.outTok),
      model: r.model && r.model !== 'default' ? String(r.model) : (r.model === 'default' ? 'auto' : null),
      agentic: r.agentic === 1 || r.agentic === true,
      mode: r.mode,
      text: r.text || '',
    });
  }

  const prompts = [];
  for (const [composerId, bubbles] of byComposer) {
    const meta = composers.get(composerId) || { name: null, order: new Map() };

    bubbles.sort((a, b) => {
      const oa = meta.order.get(a.bubbleId), ob = meta.order.get(b.bubbleId);
      if (oa !== undefined && ob !== undefined) return oa - ob;
      return (a.ts || 0) - (b.ts || 0);
    });

    let current = null;
    let lastTs = meta.createdAt || null;
    for (const b of bubbles) {
      if (b.ts) lastTs = b.ts; else b.ts = lastTs;

      if (b.type === 1) { // a prompt you sent
        current = {
          id: `${composerId}:${b.bubbleId}`,
          conversationId: composerId,
          conversationName: meta.name,
          ts: b.ts,
          endTs: b.ts,
          text: includeText ? b.text.slice(0, maxTextChars) : '',
          textTruncated: includeText && b.text.length > maxTextChars,
          mode: b.mode === 1 ? 'ask' : b.mode === 2 ? 'agent' : b.agentic ? 'agent' : null,
          models: b.model ? [b.model] : [], // Cursor 3 stores the model on the prompt itself
          inputTokens: 0,
          outputTokens: 0,
          responses: 0,
        };
        prompts.push(current);
      } else if (current) { // AI responses / tool steps that followed it
        current.inputTokens += b.inTok;
        current.outputTokens += b.outTok;
        current.responses += 1;
        if (b.ts && b.ts > current.endTs) current.endTs = b.ts;
        if (b.model && !current.models.includes(b.model)) current.models.push(b.model);
      }
    }
  }

  return prompts
    .filter(p => p.ts && p.ts >= sinceMs)
    .sort((a, b) => a.ts - b.ts);
}

// ---------- reading account usage events from cursor.com ----------

async function fetchUsageEvents(auth, { startMs, endMs = Date.now(), pageSize = 500, fetchImpl = fetch } = {}) {
  if (!auth || !auth.token || !auth.userId) throw new Error('Not signed in to Cursor (no access token found).');

  const cookie = `WorkosCursorSessionToken=${auth.userId}%3A%3A${auth.token}`;
  const events = [];
  let page = 1;
  let total = Infinity;

  while (events.length < total && page <= 50) {
    const res = await fetchImpl('https://cursor.com/api/dashboard/get-filtered-usage-events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://cursor.com',
        Referer: 'https://cursor.com/dashboard',
        Cookie: cookie,
      },
      body: JSON.stringify({ teamId: 0, startDate: String(startMs), endDate: String(endMs), page, pageSize }),
    });
    if (!res.ok) throw new Error(`cursor.com usage request failed: HTTP ${res.status}`);
    const data = await res.json();
    const batch = data.usageEventsDisplay || [];
    total = num(data.totalUsageEventsCount) || batch.length;
    for (const e of batch) events.push(normalizeEvent(e));
    if (batch.length === 0) break;
    page += 1;
  }
  return events;
}

function normalizeEvent(e) {
  const t = e.tokenUsage || {};
  const ts = toMs(e.timestamp);
  const ev = {
    ts,
    model: e.model || 'unknown',
    kind: e.kind || null,
    maxMode: !!e.maxMode,
    inputTokens: num(t.inputTokens),
    outputTokens: num(t.outputTokens),
    cacheReadTokens: num(t.cacheReadTokens),
    cacheWriteTokens: num(t.cacheWriteTokens),
    totalCents: t.totalCents === undefined ? null : num(t.totalCents),
    chargedCents: e.chargedCents === undefined ? null : num(e.chargedCents),
    requestsCosts: e.requestsCosts === undefined ? null : num(e.requestsCosts),
    isChargeable: !!e.isChargeable,
  };
  ev.id = `${ev.ts}:${ev.model}:${ev.inputTokens}:${ev.outputTokens}:${ev.cacheReadTokens}`;
  return ev;
}

module.exports = { defaultDbPath, openDb, readAuth, readPrompts, fetchUsageEvents, normalizeEvent, toMs };
