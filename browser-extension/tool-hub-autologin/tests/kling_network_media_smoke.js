// Harness for content-kling-network.js's media attribution.
// Loads the REAL MAIN-world script with a stubbed page, sends Kling-shaped
// responses through its fetch hook, and checks which output videos the
// KLING_NETWORK_USAGE payload attributes to the response's task.
//
// Regression (2026-10-21): a response naming several tasks (a status poll or
// feed of the shared account) had every video in it attributed to the one
// task id picked from it - 108 of the last 400 Kling records held 3-5 output
// videos, and their cards showed another user's video under the wrong prompt.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'content-kling-network.js');
const posted = [];

let nextResponse = null;
const fetchStub = async () => {
  const body = JSON.stringify(nextResponse);
  const make = () => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => body, json: async () => JSON.parse(body) });
  return { ...make(), clone: make };
};

const windowStub = {
  location: { href: 'https://app.klingai.com/global/app/creations/grid', origin: 'https://app.klingai.com', hostname: 'app.klingai.com' },
  postMessage: (msg) => posted.push(msg),
  addEventListener: () => {},
  fetch: fetchStub,
  setTimeout, clearTimeout,
};
windowStub.window = windowStub;

class XMLHttpRequestStub {
  open() {}
  send() {}
  setRequestHeader() {}
  addEventListener() {}
}

const sandbox = {
  window: windowStub,
  location: windowStub.location,
  document: { addEventListener: () => {}, readyState: 'complete', documentElement: {}, querySelectorAll: () => [] },
  navigator: { userAgent: 'harness' },
  XMLHttpRequest: XMLHttpRequestStub,
  WebSocket: class {},
  EventSource: class {},
  MediaSource: undefined,
  URL, URLSearchParams, FormData: class {}, Blob: class {}, ArrayBuffer, WeakMap, Map, Set, Promise, JSON, Math,
  Date, Object, Array, Number, String, Boolean, Error, RegExp, TextDecoder, isNaN, parseInt, parseFloat,
  setTimeout, clearTimeout, setInterval, clearInterval, console,
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO = (id) => `https://v15-kling.klingai.com/bs2/upload-ylab-stunt/${id}-output.mp4?x-kcdn-pid=1`;

async function respond(url, json) {
  posted.length = 0;
  nextResponse = json;
  await windowStub.fetch(url, { method: 'GET' });
  await wait(30);
  const usage = posted.filter((m) => m && m.type === 'KLING_NETWORK_USAGE').map((m) => m.payload);
  return usage[usage.length - 1] || null;
}

const outputVideos = (payload) => (payload?.mediaAssets || [])
  .filter((a) => a.assetRole !== 'input' && /\.mp4/.test(a.url)).map((a) => a.url.split('/').pop().split('-')[0]);

async function run() {
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
    if (!cond) { failures += 1; if (extra !== undefined) console.log('        ' + JSON.stringify(extra).slice(0, 600)); }
  };

  // One task's own status: its video belongs to it.
  const single = await respond('https://api-app-global.klingai.com/api/task/status?taskId=324541091311101', {
    status: 200,
    data: { task: { id: '324541091311101', taskId: '324541091311101', status: 99 },
      works: [{ workId: '324541091304135', taskId: '324541091311101', resource: { resource: VIDEO('carclip') } }] },
  });
  check('single-task status: its own video is attributed to it',
    JSON.stringify(outputVideos(single)) === JSON.stringify(['carclip']), single && single.mediaAssets);

  // A response describing several tasks on the shared account.
  const multi = await respond('https://api-app-global.klingai.com/api/task/status?taskIds=324541091311101,324540940522806', {
    status: 200,
    data: [
      { task: { taskId: '324541091311101' }, works: [{ taskId: '324541091311101', resource: { resource: VIDEO('carclip') } }] },
      { task: { taskId: '324540940522806' }, works: [{ taskId: '324540940522806', resource: { resource: VIDEO('familyclip') } }] },
    ],
  });
  check('multi-task response: no video is pinned to the one task id picked from it',
    multi === null || outputVideos(multi).length === 0, multi && multi.mediaAssets);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
