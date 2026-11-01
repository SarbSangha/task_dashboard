// node --test test/claudeSetup.test.js   (from cursor-extension/)
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const claudeSetup = require('../lib/claudeSetup');

const DASH = 'https://dashboard.ritzmediaworld.in';
const ENDPOINT = DASH + '/api/providers/claude-code/otlp';

function tmpFile(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-settings-'));
  const file = path.join(dir, 'settings.json');
  if (content !== undefined) fs.writeFileSync(file, content, 'utf8');
  return file;
}
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

const EXISTING = {
  model: 'opus',
  permissions: { allow: ['Bash(npm run build)'], deny: [], additionalDirectories: ['D:/Projects/naïve café'] },
  env: { MY_VAR: 'keep-me' },
  statusLine: { type: 'command', command: 'echo <branch> & done — ₹ नमस्ते' },
  hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'prettier --write' }] }] },
};

test('enable keeps everything else - non-ASCII text, empty and one-item arrays, hooks - and makes a .bak', () => {
  const file = tmpFile(JSON.stringify(EXISTING, null, 2));
  claudeSetup.enable({ dashboardUrl: DASH + '/', token: 'cct_abc', sendPromptText: true }, file);
  const s = read(file);
  const { env, ...rest } = s;
  const { env: oldEnv, ...oldRest } = EXISTING;
  assert.deepEqual(rest, oldRest);
  assert.equal(env.MY_VAR, 'keep-me');
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, ENDPOINT);
  assert.equal(env.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer cct_abc');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '1');
  assert.equal(env.OTEL_LOG_USER_PROMPTS, '1');
  assert.deepEqual(read(file + '.bak'), EXISTING);
  assert.deepEqual(claudeSetup.status(file), { file, endpoint: ENDPOINT, ours: true, foreign: false, enabled: true, sendsPromptText: true });
});

test('enable switches on app.entrypoint; upgrade adds it to a 1.5.0 connection without touching its token', () => {
  const file = tmpFile(JSON.stringify(EXISTING));
  claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_abc', sendPromptText: true }, file);
  assert.equal(read(file).env.OTEL_METRICS_INCLUDE_ENTRYPOINT, 'true');
  assert.equal(claudeSetup.upgrade(file).changed, false, 'nothing to do when current');

  // What 1.5.0 wrote: no OTEL_METRICS_INCLUDE_ENTRYPOINT.
  const old = read(file);
  delete old.env.OTEL_METRICS_INCLUDE_ENTRYPOINT;
  fs.writeFileSync(file, JSON.stringify(old));
  const r = claudeSetup.upgrade(file);
  assert.deepEqual(r.keys, ['OTEL_METRICS_INCLUDE_ENTRYPOINT']);
  const s = read(file);
  assert.equal(s.env.OTEL_METRICS_INCLUDE_ENTRYPOINT, 'true');
  assert.equal(s.env.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer cct_abc');
  assert.equal(s.env.MY_VAR, 'keep-me');

  const foreign = tmpFile(JSON.stringify({ env: { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318' } }));
  assert.equal(claudeSetup.upgrade(foreign).changed, false, "someone's own collector is left alone");
  claudeSetup.disable(file);
  assert.deepEqual(read(file), EXISTING, 'disable removes the new key too');
});

test('a settings.json Windows refuses to rename over (Claude Code has it open) is written in place, no .tmp left', () => {
  const file = tmpFile(JSON.stringify(EXISTING));
  const realRename = fs.renameSync;
  let calls = 0;
  fs.renameSync = (...args) => { calls++; const e = new Error('EPERM: operation not permitted, rename'); e.code = 'EPERM'; throw e; };
  try {
    claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_abc', sendPromptText: true }, file);
  } finally { fs.renameSync = realRename; }
  assert.equal(calls, 5, 'retried before giving up on the rename');
  assert.equal(read(file).env.OTEL_EXPORTER_OTLP_HEADERS, 'Authorization=Bearer cct_abc');
  assert.equal(read(file).model, 'opus');
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['settings.json', 'settings.json.bak']);

  // A rename that works on a retry (Claude Code let go of the file).
  let n = 0;
  fs.renameSync = (...args) => { if (n++ < 2) { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; } return realRename(...args); };
  try { claudeSetup.setPromptText(false, file); } finally { fs.renameSync = realRename; }
  assert.equal(read(file).env.OTEL_LOG_USER_PROMPTS, undefined);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['settings.json', 'settings.json.bak']);
});

test('a missing or empty file becomes a settings file with just the env block', () => {
  for (const file of [tmpFile(), tmpFile(''), tmpFile('\uFEFF{}')]) {
    claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_x', sendPromptText: false }, file);
    const s = read(file);
    assert.deepEqual(Object.keys(s), ['env']);
    assert.equal(s.env.OTEL_LOG_USER_PROMPTS, undefined);
  }
});

test('a file that is not valid JSON is never touched', () => {
  const bad = '{ "model": "opus", // a comment\n }';
  const file = tmpFile(bad);
  assert.throws(() => claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_x', sendPromptText: true }, file), /isn't valid JSON/);
  assert.throws(() => claudeSetup.status(file), /isn't valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), bad);
  assert.equal(fs.existsSync(file + '.bak'), false);
  const arr = tmpFile('[1,2]');
  assert.throws(() => claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_x', sendPromptText: true }, arr), /settings object/);
});

test("someone's own telemetry endpoint is reported as foreign and left alone by disable/setPromptText", () => {
  const own = { env: { CLAUDE_CODE_ENABLE_TELEMETRY: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', OTEL_LOG_USER_PROMPTS: '1' } };
  const file = tmpFile(JSON.stringify(own));
  const st = claudeSetup.status(file);
  assert.equal(st.foreign, true);
  assert.equal(st.enabled, false);
  assert.equal(claudeSetup.disable(file).changed, false);
  assert.equal(claudeSetup.setPromptText(false, file).changed, false);
  assert.deepEqual(read(file), own);
});

test('setPromptText follows the setting; disable removes only our keys', () => {
  const file = tmpFile(JSON.stringify(EXISTING));
  claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_abc', sendPromptText: true }, file);
  assert.equal(claudeSetup.setPromptText(true, file).changed, false);
  assert.equal(claudeSetup.setPromptText(false, file).changed, true);
  assert.equal(read(file).env.OTEL_LOG_USER_PROMPTS, undefined);
  assert.equal(claudeSetup.setPromptText(true, file).changed, true);
  assert.equal(read(file).env.OTEL_LOG_USER_PROMPTS, '1');

  assert.equal(claudeSetup.disable(file).changed, true);
  assert.deepEqual(read(file), EXISTING);
  const only = tmpFile();
  claudeSetup.enable({ dashboardUrl: DASH, token: 'cct_abc', sendPromptText: true }, only);
  claudeSetup.disable(only);
  assert.deepEqual(read(only), {}, 'an env block that only held our keys is removed');
});

test('settingsPath honours CLAUDE_CONFIG_DIR', () => {
  const before = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), 'cfg-dir');
  assert.equal(claudeSetup.settingsPath(), path.join(os.tmpdir(), 'cfg-dir', 'settings.json'));
  if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = before;
  assert.equal(claudeSetup.isOurs(ENDPOINT + '/'), true);
  assert.equal(claudeSetup.isOurs('https://evil.example/otlp'), false);
});
