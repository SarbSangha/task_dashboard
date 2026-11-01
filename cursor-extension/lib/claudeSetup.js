// Switches Claude Code's built-in usage reporting (OpenTelemetry) on or off on
// this computer, by editing the "env" block of Claude Code's user settings
// (~/.claude/settings.json). That one file is read by Claude Code in the
// terminal and in the VS Code extension alike.
//
// The file belongs to the person, so: everything else in it is kept, a .bak
// copy is made before each change, a file that isn't valid JSON is never
// touched, and only keys this extension wrote are ever removed.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// Must match OTLP_PATH in backend/providers/claude_code/constants.py.
const OTLP_PATH = '/api/providers/claude-code/otlp';

const MANAGED_KEYS = [
  'CLAUDE_CODE_ENABLE_TELEMETRY',
  'OTEL_LOGS_EXPORTER',
  'OTEL_EXPORTER_OTLP_PROTOCOL',
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_LOGS_EXPORT_INTERVAL',
  'OTEL_LOG_USER_PROMPTS',
  'OTEL_METRICS_INCLUDE_ENTRYPOINT',
];

// Same on every computer; the endpoint, token and prompt-text keys are not.
// OTEL_METRICS_INCLUDE_ENTRYPOINT adds app.entrypoint ("claude-vscode") to
// every event - without it the VS Code chat panel only says "non-interactive".
const FIXED_ENV = {
  CLAUDE_CODE_ENABLE_TELEMETRY: '1',
  OTEL_LOGS_EXPORTER: 'otlp',
  OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
  OTEL_LOGS_EXPORT_INTERVAL: '5000',
  OTEL_METRICS_INCLUDE_ENTRYPOINT: 'true',
};

function settingsPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(dir, 'settings.json');
}

function readSettings(file) {
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  if (!raw.trim()) return {};
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) {
    throw new Error(`${file} isn't valid JSON (${e.message}). Fix or remove it first - nothing was changed.`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} doesn't contain a settings object - nothing was changed.`);
  }
  return parsed;
}

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  const text = JSON.stringify(settings, null, 2) + '\n';
  // Write-then-rename, so Claude Code never reads a half-written file. On
  // Windows the rename is refused (EPERM/EBUSY) while Claude Code - often
  // running in this same window - has settings.json open, so retry briefly,
  // then overwrite in place, which Windows allows while it's open for reading.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmp, file);
        return;
      } catch (e) {
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
        if (attempt >= 4) break;
        sleepMs(100 * (attempt + 1));
      }
    }
    fs.writeFileSync(file, text, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed away, or already gone */ }
  }
}

const endpointFor = dashboardUrl => dashboardUrl.replace(/\/+$/, '') + OTLP_PATH;
const isOurs = endpoint => typeof endpoint === 'string' && endpoint.replace(/\/+$/, '').endsWith(OTLP_PATH);

/** What's in the settings file now. Throws if it can't be read. */
function status(file = settingsPath()) {
  const env = readSettings(file).env || {};
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT || null;
  return {
    file,
    endpoint,
    ours: isOurs(endpoint),
    // Telemetry pointed at something else (the person's own collector).
    foreign: !!endpoint && !isOurs(endpoint),
    enabled: env.CLAUDE_CODE_ENABLE_TELEMETRY === '1' && isOurs(endpoint),
    sendsPromptText: env.OTEL_LOG_USER_PROMPTS === '1',
  };
}

function enable({ dashboardUrl, token, sendPromptText }, file = settingsPath()) {
  const settings = readSettings(file);
  const env = { ...(settings.env && typeof settings.env === 'object' ? settings.env : {}) };
  Object.assign(env, FIXED_ENV, {
    OTEL_EXPORTER_OTLP_ENDPOINT: endpointFor(dashboardUrl),
    OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${token}`,
  });
  if (sendPromptText) env.OTEL_LOG_USER_PROMPTS = '1';
  else delete env.OTEL_LOG_USER_PROMPTS;
  settings.env = env;
  writeSettings(file, settings);
  return { file };
}

/** Follows the sendPromptText setting. Only touches a file that reports to us. */
function setPromptText(sendPromptText, file = settingsPath()) {
  const settings = readSettings(file);
  const env = settings.env || {};
  if (!isOurs(env.OTEL_EXPORTER_OTLP_ENDPOINT)) return { file, changed: false };
  if ((env.OTEL_LOG_USER_PROMPTS === '1') === !!sendPromptText) return { file, changed: false };
  if (sendPromptText) env.OTEL_LOG_USER_PROMPTS = '1';
  else delete env.OTEL_LOG_USER_PROMPTS;
  settings.env = env;
  writeSettings(file, settings);
  return { file, changed: true };
}

/** Brings a computer connected by an older version up to this version's
 *  fixed keys, keeping its endpoint and token. Only touches a file that
 *  reports to us, and only when something is missing or different. */
function upgrade(file = settingsPath()) {
  const settings = readSettings(file);
  const env = settings.env || {};
  if (!isOurs(env.OTEL_EXPORTER_OTLP_ENDPOINT)) return { file, changed: false };
  const missing = Object.keys(FIXED_ENV).filter(k => env[k] !== FIXED_ENV[k]);
  if (!missing.length) return { file, changed: false };
  Object.assign(env, FIXED_ENV);
  settings.env = env;
  writeSettings(file, settings);
  return { file, changed: true, keys: missing };
}

/** Removes this extension's keys - only if the file still reports to us. */
function disable(file = settingsPath()) {
  const settings = readSettings(file);
  const env = settings.env;
  if (!env || !isOurs(env.OTEL_EXPORTER_OTLP_ENDPOINT)) return { file, changed: false };
  for (const key of MANAGED_KEYS) delete env[key];
  if (!Object.keys(env).length) delete settings.env;
  writeSettings(file, settings);
  return { file, changed: true };
}

// Claude Code has been used on this computer (its config folder exists).
const claudeCodePresent = () => fs.existsSync(path.dirname(settingsPath()));

module.exports = { OTLP_PATH, settingsPath, status, enable, setPromptText, upgrade, disable, endpointFor, isOurs, claudeCodePresent };
