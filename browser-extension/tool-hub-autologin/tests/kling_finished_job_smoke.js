// Harness for content-kling.js's handling of network messages that match no
// tracked generation, and of which responses may give a click its task id.
// Loads the REAL content script with permissive page/extension stubs and
// calls its message handler the way content-kling-network.js's postMessage
// reaches it.
//
// Regressions (2026-10-21, shared Kling account):
//  * A video job finished after this tab stopped tracking it, so its status
//    response matched nothing and the video was dropped (72 of 254 click
//    cards had none). A response about ONE job carrying its output is now
//    reported as a history row for that task, for the backend to join to
//    the click by task id.
//  * A response listing several jobs must never do that, and must never
//    hand the first task id it names to a just-clicked generation.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'content-kling.js');
const sent = [];

// Anything the script pokes at on the page answers harmlessly.
function anything() {
  const fn = function () { return anything(); };
  return new Proxy(fn, {
    get(_t, key) {
      if (key === Symbol.toPrimitive) return () => '';
      if (key === Symbol.iterator) return function* () {};
      if (key === 'length') return 0;
      if (key === 'then') return undefined;
      if (['textContent', 'innerText', 'value', 'id', 'className', 'tagName', 'href'].includes(key)) return '';
      if (['querySelectorAll', 'getElementsByTagName', 'getElementsByClassName'].includes(key)) return () => [];
      if (['querySelector', 'getElementById', 'closest'].includes(key)) return () => null;
      return anything();
    },
    apply() { return anything(); },
    construct() { return anything(); },
  });
}

const location = {
  href: 'https://app.klingai.com/global/app/video/new', origin: 'https://app.klingai.com',
  hostname: 'app.klingai.com', pathname: '/global/app/video/new', search: '', hash: '',
};
const storage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const windowStub = {
  location, localStorage: storage, sessionStorage: storage,
  addEventListener: () => {}, removeEventListener: () => {}, postMessage: () => {},
  setTimeout, clearTimeout, setInterval, clearInterval,
  getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
};
windowStub.window = windowStub;
windowStub.top = windowStub;
windowStub.self = windowStub;

const sandbox = {
  window: windowStub, location, localStorage: storage, sessionStorage: storage,
  document: new Proxy({ readyState: 'complete', addEventListener() {}, removeEventListener() {} }, {
    get(target, key) { return key in target ? target[key] : anything()[key]; },
  }),
  navigator: { userAgent: 'harness' },
  chrome: {
    runtime: {
      id: 'harness', lastError: null,
      sendMessage: (msg, cb) => { sent.push(msg); if (cb) setTimeout(() => cb({ ok: true, event: { id: 1 } }), 0); },
      onMessage: { addListener() {} },
    },
    storage: { local: { get: (k, cb) => cb && cb({}), set: (o, cb) => cb && cb() }, onChanged: { addListener() {} } },
  },
  MutationObserver: class { observe() {} disconnect() {} },
  BroadcastChannel: undefined,
  URL, URLSearchParams, Map, Set, WeakMap, Promise, JSON, Math, Date, Object, Array, Number, String, Boolean,
  Error, RegExp, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent, crypto: require('crypto').webcrypto,
  setTimeout, clearTimeout, setInterval, clearInterval,
  console: { log() {}, debug() {}, info() {}, warn() {}, error() {} },
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('') }),
  atob: (s) => Buffer.from(s, 'base64').toString('binary'),
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const VIDEO = (id) => `https://v15-kling.klingai.com/bs2/upload-ylab-stunt/${id}-output.mp4?x-kcdn-pid=1`;

async function deliver(payload) {
  sent.length = 0;
  sandbox.handleKlingNetworkUsageMessage({
    source: windowStub, origin: location.origin,
    data: { source: 'rmw-kling-network-telemetry', type: 'KLING_NETWORK_USAGE', payload: { capturedAt: Date.now(), ...payload } },
  });
  await wait(50);
  return sent.filter((m) => m && m.type === 'TOOL_HUB_REPORT_USAGE_EVENT');
}

const reportOf = (msg) => msg.payload || msg.event || msg.snapshot || msg;

async function run() {
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
    if (!cond) { failures += 1; if (extra !== undefined) console.log('        ' + JSON.stringify(extra).slice(0, 700)); }
  };

  // A finished job's own status response, after this tab stopped tracking it.
  const finished = await deliver({
    url: 'https://api-app-global.klingai.com/api/task/status?taskId=324543671505406', method: 'GET',
    klingTaskId: '324543671505406', generationId: '324543671505406', status: 'settled', isCompleted: true,
    responseTaskIdCount: 1, isAssetHistoryEndpoint: false, isTradeHistoryEndpoint: false,
    mediaAssets: [{ url: VIDEO('familyclip'), assetType: 'video', assetRole: 'output', source: 'json' }],
  });
  const body = finished.length ? JSON.stringify(reportOf(finished[0])) : '';
  check('finished job output (one task, untracked) is reported', finished.length === 1, sent.map((m) => m.type));
  check('...as a history row for that task id, carrying the video',
    body.includes('asset_history_discovered') && body.includes('324543671505406') && body.includes('familyclip-output.mp4'),
    body.slice(0, 600));

  // A response listing several jobs: nothing to report, nothing to adopt.
  const listed = await deliver({
    url: 'https://api-app-global.klingai.com/api/task/status?taskIds=1,2', method: 'GET',
    klingTaskId: '324543671505406', status: 'settled', isCompleted: true,
    responseTaskIdCount: 2, isAssetHistoryEndpoint: false, isTradeHistoryEndpoint: false,
    mediaAssets: [{ url: VIDEO('carclip'), assetType: 'video', assetRole: 'output', source: 'json' }],
  });
  check('a response about several jobs reports nothing', listed.length === 0, listed.map((m) => JSON.stringify(reportOf(m)).slice(0, 200)));

  // Input images (the reference frame) are never an output.
  const inputOnly = await deliver({
    url: 'https://api-app-global.klingai.com/api/task/status?taskId=324500000000777', method: 'GET',
    klingTaskId: '324500000000777', status: 'settled', isCompleted: true, responseTaskIdCount: 1,
    mediaAssets: [{ url: 'https://s21-kling.klingai.com/kimg/EMXN1y8q:64x64.webp', assetType: 'image', assetRole: 'input', source: 'request_payload' }],
  });
  check('a response with only input images reports nothing', inputOnly.length === 0);

  // Which responses may give a just-clicked generation its first task id.
  const ok = sandbox.isTaskIdSourceForNewGeneration;
  check('submit (request carried the prompt) may hand over a task id', ok({ requestHasPrompt: true, responseTaskIdCount: 1 }) === true);
  check('a single-job status response may', ok({ responseTaskIdCount: 1 }) === true);
  check('a response naming several jobs may not', ok({ responseTaskIdCount: 3 }) === false);
  check('a history/credit list may not, even with one job in it',
    ok({ isAssetHistoryEndpoint: true, responseTaskIdCount: 1 }) === false && ok({ isListEndpoint: true, responseTaskIdCount: 1 }) === false);

  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL CHECKS PASSED');
  process.exit(failures ? 1 : 0);
}

run().catch((e) => { console.error(e); process.exit(1); });
