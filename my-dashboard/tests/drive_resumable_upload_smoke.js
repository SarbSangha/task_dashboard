// Resumable Drive upload: chunking, progress, resume after drops, cancel.
// Run from my-dashboard/:  node tests/drive_resumable_upload_smoke.js
//
// XMLHttpRequest is replaced by a fake Drive upload session that keeps the
// bytes it was sent, so the reassembled file can be compared byte for byte.

import assert from 'node:assert/strict';
import { startDriveUpload, UploadCancelledError, UploadSessionExpiredError } from '../src/utils/driveResumableUpload.js';

const KIB = 1024;
const CHUNK = 256 * KIB;

function makeFile(size) {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) bytes[i] = (i * 31 + 7) % 251;
  return { blob: new Blob([bytes]), bytes };
}

// One fake session. `plan(n, kind)` lets a test misbehave on request n.
function installFakeDrive({ total, plan = () => null }) {
  const state = { received: new Uint8Array(total), have: 0, requests: [], finished: false };

  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; this.headers = {}; this.responseHeaders = {}; }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader(name) { return this.responseHeaders[name] ?? null; }
    abort() { this.aborted = true; }
    async send(body) {
      const n = state.requests.length;
      const range = this.headers['Content-Range'];
      const kind = range.startsWith('bytes */') ? 'query' : 'chunk';
      state.requests.push({ kind, range });
      const action = plan(n, kind);
      await new Promise((r) => setTimeout(r, 1));
      if (this.aborted) return;

      const respond = (status, headers = {}, text = '') => {
        this.status = status;
        this.responseHeaders = headers;
        this.responseText = text;
        this.onload?.();
        this.onloadend?.();
      };
      const rangeHeader = () => (state.have ? { Range: `bytes=0-${state.have - 1}` } : {});

      if (action === 'drop') { this.status = 0; this.onerror?.(); this.onloadend?.(); return; }
      if (action === 'expire') { respond(404); return; }
      if (action === 'busy') { respond(503); return; }

      if (kind === 'query') {
        if (state.finished) respond(200, {}, JSON.stringify({ id: 'file-1', size: String(total) }));
        else respond(308, rangeHeader());
        return;
      }

      const [, first, last] = /bytes (\d+)-(\d+)\/\d+/.exec(range).map(Number);
      assert.equal(first, state.have, `chunk starts where Drive left off (${first} vs ${state.have})`);
      const data = new Uint8Array(await body.arrayBuffer());
      // 'partial': Drive keeps only half of this chunk, then the line drops.
      const keep = action === 'partial' ? Math.floor(data.length / 2 / CHUNK) * CHUNK || CHUNK / 2 : data.length;
      this.upload.onprogress?.({ loaded: keep });
      state.received.set(data.subarray(0, keep), first);
      state.have = first + keep;
      if (action === 'partial') { this.status = 0; this.onerror?.(); this.onloadend?.(); return; }
      assert.equal(last, first + data.length - 1);
      if (state.have === total) {
        state.finished = true;
        respond(200, {}, JSON.stringify({ id: 'file-1', size: String(total) }));
      } else {
        respond(308, rangeHeader());
      }
    }
  };
  return state;
}

const ok = (msg) => console.log('ok -', msg);
const fastTimers = () => {
  // Backoff sleeps would make this take seconds; run them immediately.
  const real = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...a) => real(fn, Math.min(ms, 1), ...a);
};
fastTimers();

// 1. Plain multi-chunk upload.
{
  const size = CHUNK * 3 + 1234;
  const { blob, bytes } = makeFile(size);
  const state = installFakeDrive({ total: size });
  const progress = [];
  const result = await startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK, onProgress: (l) => progress.push(l) }).promise;
  assert.equal(result.id, 'file-1');
  assert.deepEqual(state.received, bytes);
  assert.equal(state.requests.filter((r) => r.kind === 'chunk').length, 4);
  assert.equal(progress.at(-1), size);
  assert.ok(progress.every((v, i) => i === 0 || v >= progress[i - 1] || v === 0), 'progress never goes backwards mid-chunk');
  ok('4 chunks, bytes identical, progress reaches 100%');
}

// 2. Connection drops mid-chunk after Drive kept part of it -> resume from Drive's count.
{
  const size = CHUNK * 8;
  const { blob, bytes } = makeFile(size);
  const state = installFakeDrive({ total: size, plan: (n) => (n === 1 ? 'partial' : null) });
  const result = await startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK * 4, onProgress: () => {} }).promise;
  assert.equal(result.id, 'file-1');
  assert.deepEqual(state.received, bytes);
  assert.ok(state.requests.some((r) => r.kind === 'query'), 'asked Drive how much it had');
  ok('dropped mid-chunk -> asked Drive for its byte count and resumed; file intact');
}

// 3. Transient 503s and drops are retried.
{
  const size = CHUNK * 2;
  const { blob, bytes } = makeFile(size);
  const state = installFakeDrive({ total: size, plan: (n) => ({ 0: 'busy', 2: 'drop' })[n] || null });
  await startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK }).promise;
  assert.deepEqual(state.received, bytes);
  ok('503 and a network drop are retried with backoff');
}

// 4. Last chunk landed but its response was lost -> the status query returns the file.
{
  const size = CHUNK;
  const { blob } = makeFile(size);
  let dropped = false;
  installFakeDrive({ total: size });
  const RealXhr = globalThis.XMLHttpRequest;
  globalThis.XMLHttpRequest = class extends RealXhr {
    async send(body) {
      if (!dropped && this.headers['Content-Range'].startsWith('bytes 0-')) {
        dropped = true;
        const onload = this.onload;
        this.onload = () => { this.status = 0; this.onerror?.(); };   // swallow the 200
        await super.send(body);
        this.onload = onload;
        return;
      }
      return super.send(body);
    }
  };
  const result = await startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK }).promise;
  assert.equal(result.id, 'file-1');
  ok('lost final response -> recovered the finished file without re-uploading');
}

// 5. Expired session is reported as such.
{
  const { blob } = makeFile(CHUNK);
  installFakeDrive({ total: CHUNK, plan: () => 'expire' });
  await assert.rejects(startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK }).promise, UploadSessionExpiredError);
  ok('404 from Drive -> UploadSessionExpiredError');
}

// 6. Cancel.
{
  const { blob } = makeFile(CHUNK * 4);
  installFakeDrive({ total: CHUNK * 4 });
  const upload = startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK });
  upload.cancel();
  await assert.rejects(upload.promise, UploadCancelledError);
  ok('cancel() rejects with UploadCancelledError');
}

// 7. Gives up after too many failures instead of looping forever.
{
  const { blob } = makeFile(CHUNK);
  installFakeDrive({ total: CHUNK, plan: (n, kind) => (kind === 'chunk' ? 'drop' : null) });
  await assert.rejects(startDriveUpload({ file: blob, uploadUrl: 'u', chunkSize: CHUNK }).promise, /Connection to Google Drive was lost/);
  ok('persistent drops -> clear error after the retry budget');
}

// 8. Empty file.
{
  installFakeDrive({ total: 0 });
  globalThis.XMLHttpRequest = class extends globalThis.XMLHttpRequest {};
  const state = { finished: true };
  globalThis.XMLHttpRequest.prototype.send = function send() {
    this.status = 200; this.responseText = JSON.stringify({ id: 'empty', size: '0' }); this.onload(); this.onloadend?.();
    return state;
  };
  const result = await startDriveUpload({ file: new Blob([]), uploadUrl: 'u', chunkSize: CHUNK }).promise;
  assert.equal(result.id, 'empty');
  ok('zero-byte file');
}

console.log('\nALL DRIVE RESUMABLE UPLOAD CHECKS PASSED');
