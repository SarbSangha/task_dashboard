'use strict';

const vscode = require('vscode');
const os = require('os');
const fs = require('fs');
const claudeSetup = require('./lib/claudeSetup');
const { defaultDbPath, openDb, readAuth, readPrompts, fetchUsageEvents } = require('./lib/collector');

const DAY = 24 * 60 * 60 * 1000;
let timer = null;
let statusItem = null;
let output = null;
let syncing = false;
let warnedDisconnected = false;
let dashboardRejected = false;

function cfg() {
  const c = vscode.workspace.getConfiguration('cursorTracker');
  return {
    serverUrl: (c.get('serverUrl') || '').replace(/\/+$/, ''),
    apiKey: c.get('apiKey') || '',
    intervalMin: Math.max(1, c.get('syncIntervalMinutes') || 5),
    lookbackDays: Math.max(1, c.get('lookbackDays') || 3),
    firstSyncDays: Math.max(1, c.get('firstSyncDays') || 30),
    sendPromptText: c.get('sendPromptText') !== false,
    maxPromptChars: c.get('maxPromptChars') || 4000,
    fetchAccountUsage: c.get('fetchAccountUsage') !== false,
    dbPath: c.get('databasePath') || defaultDbPath(),
    userName: (c.get('userName') || '').trim(),
  };
}

// RMW dashboard mode. Only an admin can connect a computer: they create a
// one-time setup code for a person, and Connect to dashboard trades it for a
// token that works only from this computer. The token lives in SecretStorage
// (the OS credential store), not settings.json, and the address/person live in
// globalState, so neither can be swapped by editing settings - changing who
// this computer reports as always needs a new code from an admin.
const SECRET_KEY = 'cursorTracker.dashboardToken';
const CONNECTION_KEY = 'cursorTracker.dashboardConnection';
// Claude Code (terminal + VS Code) on this computer reports to the dashboard
// by itself once its settings say so. Its token comes from the dashboard for
// this computer's connection, so it always reports as the same person - and
// stops when the computer is disconnected or connected for someone else.
const CLAUDE_STATE_KEY = 'cursorTracker.claudeCode';

async function dashboardConnection(context) {
  const conn = context.globalState.get(CONNECTION_KEY);
  if (!conn || !conn.url) return null;
  const token = await context.secrets.get(SECRET_KEY);
  return token ? { ...conn, token } : null;
}

// Keeps each request well under nginx's default 1 MB body limit in front of the
// dashboard, whatever the prompt lengths. Always yields at least one batch so an
// empty sync still reaches the server (and proves the token works).
const MAX_BATCH_BYTES = 300 * 1024;
function* byteBatches(items, maxItems, maxBytes) {
  let batch = [], size = 0;
  for (const item of items) {
    const itemSize = Buffer.byteLength(JSON.stringify(item));
    if (batch.length && (batch.length >= maxItems || size + itemSize > maxBytes)) {
      yield batch;
      batch = []; size = 0;
    }
    batch.push(item); size += itemSize;
  }
  yield batch;
}

function log(msg) {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

async function post(url, apiKey, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let detail = text;
    try { detail = JSON.parse(text).detail || text; } catch {}
    const err = new Error(`Website rejected data: HTTP ${res.status} ${detail}`);
    err.status = res.status;
    err.detail = typeof detail === 'string' ? detail : JSON.stringify(detail);
    throw err;
  }
  return res.json().catch(() => ({}));
}

const deviceInfo = () => ({ id: vscode.env.machineId, name: os.hostname(), os: process.platform });

async function sync(context, { manual = false } = {}) {
  if (syncing) return;
  syncing = true; // claimed before any await, so overlapping calls can't both run
  try {
    const c = cfg();
    const dash = await dashboardConnection(context);
    if (!dash && (!c.serverUrl || !c.apiKey)) {
      setStatus('$(plug) Tracker: not connected', 'Ask an admin for a setup code, then click here to connect Cursor to the RMW dashboard', 'cursorTracker.connectDashboard');
      if (manual) vscode.commands.executeCommand('cursorTracker.connectDashboard');
      return;
    }
    // Rejected by the dashboard (disconnected by an admin): don't keep reading
    // Cursor's history on every timer tick - a manual sync or reconnect retries.
    if (dash && dashboardRejected && !manual) return;

    // No Cursor on this computer (VS Code used only for Claude Code): there's
    // no Cursor history to read. Claude Code reports by itself once connected.
    if (!fs.existsSync(c.dbPath)) {
      const cc = claudeSummary();
      if (cc.enabled) setStatus('$(graph) Tracker: Claude Code', `No Cursor on this computer.${claudeTooltip()}`, 'cursorTracker.openDashboard');
      else setStatus('$(plug) Tracker: Claude Code', 'No Cursor on this computer. Click to send this computer\'s Claude Code usage to the dashboard.', 'cursorTracker.connectClaude');
      if (manual) vscode.window.showInformationMessage(cc.enabled
        ? 'Cursor Tracker: no Cursor on this computer. Claude Code reports its usage by itself.'
        : 'Cursor Tracker: no Cursor on this computer. Run "Cursor Tracker: Connect Claude Code on this computer" to track Claude Code.');
      return;
    }

    setStatus('$(sync~spin) Tracker', 'Syncing Cursor usage…');
    await syncWith(context, c, dash, manual);
  } finally {
    syncing = false;
  }
}

async function syncWith(context, c, dash, manual) {
  let db;
  try {
    const lastSync = context.globalState.get('lastSyncMs');
    let sinceMs = Date.now() - (lastSync ? c.lookbackDays : c.firstSyncDays) * DAY;
    // After an admin switched this computer to another person, earlier
    // prompts were (or should have been) sent as the previous person.
    if (dash && dash.sendFromMs) sinceMs = Math.max(sinceMs, dash.sendFromMs);

    db = await openDb(c.dbPath);
    const auth = readAuth(db);
    const prompts = readPrompts(db, { sinceMs, includeText: c.sendPromptText, maxTextChars: c.maxPromptChars });
    db.close(); db = null;
    log(`Read ${prompts.length} prompts from local Cursor history (${c.dbPath}).`);

    let events = [];
    let usageError = null;
    if (c.fetchAccountUsage && !dash) { // only the standalone site uses these
      try {
        events = await fetchUsageEvents(auth, { startMs: sinceMs });
        log(`Fetched ${events.length} usage events from cursor.com.`);
      } catch (e) {
        usageError = e.message;
        log(`Could not fetch account usage: ${e.message}`);
      }
    }

    const device = {
      id: vscode.env.machineId,
      name: os.hostname(),
      person: c.userName || os.userInfo().username || os.hostname(),
      os: process.platform,
      appName: vscode.env.appName,
    };
    const user = { email: auth.email, plan: auth.plan };

    // Send in batches so large first syncs don't time out.
    const B = 400;
    let syncedAs = null;
    if (dash) {
      const url = `${dash.url}/api/providers/cursor/capture/prompts`;
      for (const batch of byteBatches(prompts, B, MAX_BATCH_BYTES)) {
        const result = await post(url, dash.token, {
          extension_version: context.extension.packageJSON.version,
          device: { id: device.id, name: device.name, os: device.os },
          account: user,
          prompts: batch,
        });
        syncedAs = result.user && result.user.name;
      }
    } else {
      const url = `${c.serverUrl}/api/ingest`;
      const total = Math.max(prompts.length, events.length);
      for (let i = 0; i === 0 || i < total; i += B) {
        await post(url, c.apiKey, {
          source: 'cursor-extension',
          version: context.extension.packageJSON.version,
          device, user,
          usageError,
          prompts: prompts.slice(i, i + B),
          events: events.slice(i, i + B),
        });
      }
    }
    if (syncedAs) log(`Sent ${prompts.length} prompts to the dashboard as ${syncedAs}.`);

    dashboardRejected = false;
    await context.globalState.update('lastSyncMs', Date.now());
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const todayPrompts = prompts.filter(p => p.ts >= today.getTime()).length;
    const who = dash ? ` as ${syncedAs || dash.userName}` : '';
    setStatus(`$(graph) ${todayPrompts} prompts today`, `Cursor usage synced${who} ${new Date().toLocaleTimeString()}.${claudeTooltip()} Click to open dashboard.`, 'cursorTracker.openDashboard');
    if (manual) vscode.window.showInformationMessage(`Cursor Tracker: sent ${prompts.length} prompts${who}.`);
  } catch (e) {
    log(`Sync failed: ${e.stack || e.message}`);
    if (dash && e.status === 401) {
      // Disconnected by an admin, or this token isn't this computer's.
      dashboardRejected = true;
      setStatus('$(warning) Tracker: disconnected', `${e.detail}`, 'cursorTracker.connectDashboard');
      if (manual || !warnedDisconnected) vscode.window.showWarningMessage(`Cursor Tracker: ${e.detail}`);
      warnedDisconnected = true;
    } else {
      setStatus('$(warning) Tracker', `Sync failed: ${e.message}`, 'cursorTracker.showLog');
      if (manual) vscode.window.showErrorMessage(`Cursor Tracker: ${e.message}`);
    }
  } finally {
    if (db) try { db.close(); } catch {}
  }
}

function setStatus(text, tooltip, command) {
  statusItem.text = text;
  statusItem.tooltip = tooltip;
  statusItem.command = command || 'cursorTracker.syncNow';
  statusItem.show();
}

function schedule(context) {
  if (timer) clearInterval(timer);
  timer = setInterval(() => sync(context), cfg().intervalMin * 60 * 1000);
}

async function configure() {
  const c = vscode.workspace.getConfiguration('cursorTracker');
  const url = await vscode.window.showInputBox({
    title: 'Cursor Tracker: dashboard URL',
    prompt: 'The address of your tracking website, e.g. https://usage.yoursite.com',
    value: c.get('serverUrl') || '',
    ignoreFocusOut: true,
  });
  if (url === undefined) return;
  const name = await vscode.window.showInputBox({
    title: 'Cursor Tracker: your name',
    prompt: 'Shown on the dashboard so usage from this computer is credited to you (e.g. Sarabjeet)',
    value: c.get('userName') || os.userInfo().username || '',
    ignoreFocusOut: true,
  });
  if (name === undefined) return;
  await c.update('userName', name.trim(), vscode.ConfigurationTarget.Global);
  const key = await vscode.window.showInputBox({
    title: 'Cursor Tracker: API key',
    prompt: 'The TRACKER_API_KEY you set on the server',
    value: c.get('apiKey') || '',
    password: true,
    ignoreFocusOut: true,
  });
  if (key === undefined) return;
  await c.update('serverUrl', url.trim(), vscode.ConfigurationTarget.Global);
  await c.update('apiKey', key.trim(), vscode.ConfigurationTarget.Global);
  vscode.commands.executeCommand('cursorTracker.syncNow');
}

async function connectDashboard(context) {
  const settings = vscode.workspace.getConfiguration('cursorTracker');
  const current = context.globalState.get(CONNECTION_KEY);
  const url = await vscode.window.showInputBox({
    title: 'Cursor Tracker: dashboard address',
    prompt: 'The admin copies it from RMW Data → Cursor → People & devices',
    value: (current && current.url) || settings.get('dashboardUrl') || '',
    ignoreFocusOut: true,
  });
  if (!url) return;
  const code = await vscode.window.showInputBox({
    title: 'Cursor Tracker: setup code',
    prompt: current
      ? `This computer sends prompts as ${current.userName}. Only an admin can change that: enter a new setup code from them.`
      : 'The one-time code (CUR-XXXX-XXXX) an admin created for you in People & devices',
    placeHolder: 'CUR-XXXX-XXXX',
    ignoreFocusOut: true,
  });
  if (!code) return;

  const base = url.trim().replace(/\/+$/, '');
  let parsed;
  try { parsed = new URL(base); } catch {
    vscode.window.showErrorMessage('Cursor Tracker: that dashboard address is not a valid URL.');
    return;
  }
  const isLocal = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocal)) {
    vscode.window.showErrorMessage('Cursor Tracker: the dashboard address must start with https:// (plain http is only allowed for localhost).');
    return;
  }
  let result;
  try {
    result = await post(`${base}/api/providers/cursor/connect`, null, {
      code: code.trim(),
      extension_version: context.extension.packageJSON.version,
      device: deviceInfo(),
    });
  } catch (e) {
    // The current connection (if any) stays exactly as it was.
    vscode.window.showErrorMessage(`Cursor Tracker: could not connect. ${e.detail || e.message}`);
    return;
  }

  await context.secrets.store(SECRET_KEY, result.token);
  await context.globalState.update(CONNECTION_KEY, {
    url: base,
    userName: result.user && result.user.name,
    sendFromMs: result.sendFromMs || null,
    connectedAt: Date.now(),
  });
  await context.globalState.update('lastSyncMs', undefined);
  await clearLegacyDashboardSettings();
  warnedDisconnected = false;
  dashboardRejected = false;
  log(`Connected to ${base} as ${result.user && result.user.name}.`);
  vscode.window.showInformationMessage(`Cursor Tracker: connected. This computer now sends Cursor prompts as ${result.user && result.user.name}.`);
  vscode.commands.executeCommand('cursorTracker.syncNow');
  await afterDashboardConnected(context);
}

async function afterDashboardConnected(context) {
  const state = context.globalState.get(CLAUDE_STATE_KEY);
  // Claude Code's token belonged to the previous connection and has stopped
  // working: get one for the new connection (and so the new person).
  if (state && state.enabled) {
    await connectClaude(context, { quiet: true });
    return;
  }
  if (!claudeSetup.claudeCodePresent()) return;
  const pick = await vscode.window.showInformationMessage(
    'Also track Claude Code on this computer (terminal and VS Code)?', 'Yes', 'Not now');
  if (pick === 'Yes') await connectClaude(context);
}

function claudeSummary() {
  try { return claudeSetup.status(); } catch (e) { return { enabled: false, error: e.message }; }
}

function claudeTooltip() {
  return claudeSummary().enabled ? ' Claude Code on this computer reports to the dashboard too.' : '';
}

async function connectClaude(context, { quiet = false } = {}) {
  const dash = await dashboardConnection(context);
  if (!dash) {
    if (quiet) return false;
    const pick = await vscode.window.showWarningMessage(
      'Cursor Tracker: connect this computer to the dashboard first, with a setup code from an admin. Claude Code then reports as the same person.',
      'Connect to dashboard');
    if (pick) await connectDashboard(context); // offers Claude Code once connected
    return false;
  }

  let st;
  try { st = claudeSetup.status(); } catch (e) {
    log(`Claude Code: ${e.message}`);
    if (!quiet) vscode.window.showErrorMessage(`Cursor Tracker: ${e.message}`);
    return false;
  }
  if (st.foreign) {
    // The person sends Claude Code telemetry to their own collector.
    if (quiet) { log(`Claude Code reports to ${st.endpoint}; left as it is.`); return false; }
    const pick = await vscode.window.showWarningMessage(
      `Claude Code on this computer already sends its telemetry to ${st.endpoint}. Send it to the dashboard instead?`,
      { modal: true }, 'Replace');
    if (pick !== 'Replace') return false;
  }

  let result;
  try {
    result = await post(`${dash.url}/api/providers/claude-code/connect`, dash.token, {
      extension_version: context.extension.packageJSON.version,
      device: deviceInfo(),
    });
  } catch (e) {
    log(`Claude Code connect failed: ${e.message}`);
    if (!quiet) vscode.window.showErrorMessage(`Cursor Tracker: could not connect Claude Code. ${e.detail || e.message}`);
    return false;
  }
  if (result.otlpPath && result.otlpPath !== claudeSetup.OTLP_PATH) {
    log(`Dashboard expects Claude Code at ${result.otlpPath}, this extension writes ${claudeSetup.OTLP_PATH}. Update the extension.`);
  }

  try {
    claudeSetup.enable({ dashboardUrl: dash.url, token: result.token, sendPromptText: cfg().sendPromptText });
  } catch (e) {
    log(`Claude Code: ${e.message}`);
    vscode.window.showErrorMessage(`Cursor Tracker: couldn't update Claude Code's settings. ${e.message}`);
    return false;
  }
  const name = (result.user && result.user.name) || dash.userName;
  await context.globalState.update(CLAUDE_STATE_KEY, { enabled: true, url: dash.url, userName: name, connectedAt: Date.now() });
  log(`Claude Code now reports to ${dash.url} as ${name} (${st.file}).`);

  const msg = `Cursor Tracker: Claude Code on this computer now reports its usage as ${name}. Restart open Claude Code sessions: in a terminal, exit and run claude again; in VS Code, reload the window.`;
  if (quiet) vscode.window.showInformationMessage(msg);
  else {
    const pick = await vscode.window.showInformationMessage(msg, 'Reload window');
    if (pick === 'Reload window') vscode.commands.executeCommand('workbench.action.reloadWindow');
  }
  return true;
}

async function disconnectClaude(context) {
  let r;
  try { r = claudeSetup.disable(); } catch (e) {
    vscode.window.showErrorMessage(`Cursor Tracker: ${e.message}`);
    return;
  }
  await context.globalState.update(CLAUDE_STATE_KEY, { enabled: false });
  const dash = await dashboardConnection(context);
  if (dash) {
    try {
      await post(`${dash.url}/api/providers/claude-code/disconnect`, dash.token, { device: deviceInfo() });
    } catch (e) {
      log(`Claude Code disconnect on the dashboard failed: ${e.message}`);
    }
  }
  log(r.changed ? `Claude Code tracking removed from ${r.file}.` : 'Claude Code was not reporting to the dashboard.');
  vscode.window.showInformationMessage(r.changed
    ? `Cursor Tracker: Claude Code tracking is off (${r.file}). Restart open Claude Code sessions.`
    : 'Cursor Tracker: Claude Code on this computer wasn\'t reporting to the dashboard.');
}

// 1.3.x kept the dashboard address and a self-made token in settings.json.
// Those tokens no longer work; remove them so nothing looks configured there.
async function clearLegacyDashboardSettings() {
  const settings = vscode.workspace.getConfiguration('cursorTracker');
  for (const key of ['dashboardUrl', 'trackerToken']) {
    const inspected = settings.inspect(key);
    if (inspected && inspected.globalValue !== undefined) {
      try { await settings.update(key, undefined, vscode.ConfigurationTarget.Global); } catch {}
    }
  }
}

function activate(context) {
  output = vscode.window.createOutputChannel('Cursor Tracker');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  context.subscriptions.push(output, statusItem);

  context.subscriptions.push(
    vscode.commands.registerCommand('cursorTracker.syncNow', () => sync(context, { manual: true })),
    vscode.commands.registerCommand('cursorTracker.configure', configure),
    vscode.commands.registerCommand('cursorTracker.connectDashboard', () => connectDashboard(context)),
    vscode.commands.registerCommand('cursorTracker.connectClaude', () => connectClaude(context)),
    vscode.commands.registerCommand('cursorTracker.disconnectClaude', () => disconnectClaude(context)),
    vscode.commands.registerCommand('cursorTracker.showLog', () => output.show()),
    vscode.commands.registerCommand('cursorTracker.openDashboard', async () => {
      const dash = await dashboardConnection(context);
      const c = cfg();
      const claude = claudeSummary().enabled ? ' Claude Code reports as the same person.' : '';
      if (dash) vscode.window.showInformationMessage(`This computer sends Cursor prompts as ${dash.userName} to the RMW dashboard (RMW Data → Cursor).${claude}`);
      else if (c.serverUrl) vscode.env.openExternal(vscode.Uri.parse(c.serverUrl));
      else connectDashboard(context);
    }),
    vscode.commands.registerCommand('cursorTracker.resyncAll', async () => {
      await context.globalState.update('lastSyncMs', undefined);
      sync(context, { manual: true });
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('cursorTracker')) schedule(context);
      // Claude Code's prompt text follows the same privacy setting.
      if (e.affectsConfiguration('cursorTracker.sendPromptText')) {
        try {
          const r = claudeSetup.setPromptText(cfg().sendPromptText);
          if (r.changed) log(`Claude Code prompt text ${cfg().sendPromptText ? 'on' : 'off'} in ${r.file}.`);
        } catch (e) { log(`Claude Code: ${e.message}`); }
      }
    }),
  );

  // A computer connected by an older version gets this version's Claude Code
  // settings (e.g. 1.5.1's app.entrypoint, which labels the VS Code chat panel).
  try {
    const r = claudeSetup.upgrade();
    if (r.changed) {
      log(`Claude Code settings updated in ${r.file}: ${r.keys.join(', ')}.`);
      vscode.window.showInformationMessage('Cursor Tracker: Claude Code tracking settings were updated. Restart open Claude Code sessions (VS Code: reload the window) to apply them.', 'Reload window')
        .then(pick => { if (pick === 'Reload window') vscode.commands.executeCommand('workbench.action.reloadWindow'); });
    }
  } catch (e) { log(`Claude Code: ${e.message}`); }

  setStatus('$(graph) Tracker', 'Cursor Tracker');
  setTimeout(() => sync(context), 5000);
  schedule(context);
}

function deactivate() { if (timer) clearInterval(timer); }

module.exports = { activate, deactivate };
