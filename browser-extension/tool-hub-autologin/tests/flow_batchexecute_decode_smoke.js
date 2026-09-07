// Dry-run harness for content-flow-network.js's capture path.
// Stubs just enough of the page environment to load the MAIN-world script,
// then drives real fetch() calls through it and asserts what it postMessages.
const fs = require('fs');
const vm = require('vm');

const path = require('path');
const SRC = path.join(__dirname, '..', 'content-flow-network.js');

const posted = [];
const logs = [];

function makeResponse(url, body, contentType) {
  return {
    url,
    headers: { get: (n) => (n.toLowerCase() === 'content-type' ? contentType : null) },
    clone() { return { text: () => Promise.resolve(body) }; },
  };
}

const listeners = {};
const windowStub = {
  __rmwFlowNetworkTelemetryInstalled: false,
  // Auto-approves the generate gate, standing in for the ISOLATED-world
  // task/client picker. Without this the held request never dispatches -
  // which is the correct production behaviour, but it would hang the test.
  postMessage: (msg) => {
    posted.push(msg);
    if (msg && msg.type === 'FLOW_GENERATE_GATE_REQUEST') {
      const gateId = msg.payload && msg.payload.gateId;
      setTimeout(() => {
        for (const fn of listeners.message || []) {
          fn({
            source: windowStub,
            data: {
              source: 'rmw-flow-network-telemetry-gate',
              type: 'FLOW_GENERATE_GATE_DECISION',
              payload: { gateId, allow: true },
            },
          });
        }
      }, 0);
    }
  },
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  fetch: null,
  XMLHttpRequest: function XHR() {},
};
windowStub.window = windowStub;

const sandbox = {
  window: windowStub,
  document: { addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); }, body: {} },
  location: { href: 'https://flow.google.com/project/abc', origin: 'https://flow.google.com' },
  console: { debug: (...a) => logs.push(a), warn: (...a) => logs.push(a), error: (...a) => logs.push(a) },
  URL,
  URLSearchParams,
  Set, Map, Promise, JSON, Math, Date, Object, Array, Number, String, Boolean,
  DOMException: class DOMException extends Error {},
  Event: class Event {},
  setTimeout, clearTimeout,
};
sandbox.globalThis = sandbox;

let lastRealFetchUrl = null;
windowStub.fetch = function realFetch(input) {
  const url = typeof input === 'string' ? input : input.url;
  lastRealFetchUrl = url;
  return Promise.resolve(sandbox.__nextResponse);
};

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

// Real wire format: XSSI prefix, then (byte-length line, JSON array) chunks,
// with the actual payload double-encoded as a JSON string inside the frame.
function envelope(frames) {
  let out = ")]}'\n\n";
  for (const [rpcid, payload] of frames) {
    const chunk = JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic']]);
    out += Buffer.byteLength(chunk, 'utf8') + '\n' + chunk + '\n';
  }
  const tail = JSON.stringify([['di', 53], ['af.httprm', 53, '-123', 5]]);
  out += Buffer.byteLength(tail, 'utf8') + '\n' + tail + '\n';
  return out;
}

const BATCH_URL = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute?rpcids=ogiZ0b&bl=boq_labs-ai-sandbox-frontend_20260907.00_p0&_reqid=2481342&rt=c';

function fireGenerateClick() {
  const pointerdown = (listeners.pointerdown || [])[0];
  pointerdown({
    target: {
      nodeType: 1,
      tagName: 'BUTTON',
      disabled: false,
      getAttribute: (n) => (n === 'aria-label' ? 'Start generation' : null),
      className: 'generate-icon-button',
      getBoundingClientRect: () => ({ width: 40, height: 40 }),
      parentElement: null,
    },
  });
}

async function run() {
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
    if (!cond) { failures += 1; if (extra !== undefined) console.log('        ' + String(JSON.stringify(extra)).slice(0, 600)); }
  };

  // 1. A workflow row nested deep inside positional arrays, in the REST
  //    object shape the backend contract already understands.
  posted.length = 0; logs.length = 0;
  const workflowRow = {
    name: 'd0d589e3-b915-49be-9a85-ac5711209430',
    projectId: 'proj-1',
    metadata: {
      displayName: 'boy with pagesys',
      createTime: '2026-09-07T17:07:00Z',
      updateTime: '2026-09-07T17:07:30Z',
      primaryMediaId: 'aa5bb74a-d1bc-4fdc-897d-4f5bc36e2431',
      batchId: 'batch-77',
    },
  };
  sandbox.__nextResponse = makeResponse(BATCH_URL, envelope([['ogiZ0b', [[null, [[workflowRow]]]]]]), 'application/json; charset=UTF-8');
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));

  const gen = posted.filter((m) => m && m.type === 'FLOW_NETWORK_GENERATION');
  check('workflow row nested in batchexecute is captured', gen.length === 1, posted);
  check('captured row keeps its creation id',
    gen[0] && gen[0].payload.rows[0].name === 'd0d589e3-b915-49be-9a85-ac5711209430', gen[0]);
  check('real fetch still dispatched', lastRealFetchUrl === BATCH_URL);

  // 2. Non-ASCII prompt must not desynchronize the chunk walk (the reason
  //    the byte-length lines are ignored rather than used to slice).
  posted.length = 0;
  const emojiRow = JSON.parse(JSON.stringify(workflowRow));
  emojiRow.name = '11111111-2222-3333-4444-555555555555';
  emojiRow.metadata.displayName = 'nino con caballo \u{1F434}\u{1F3A8} emoji test';
  sandbox.__nextResponse = makeResponse(BATCH_URL, envelope([['ogiZ0b', [[emojiRow]]]]), 'application/json; charset=UTF-8');
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  const gen2 = posted.filter((m) => m && m.type === 'FLOW_NETWORK_GENERATION');
  check('non-ASCII prompt does not break chunk parsing',
    gen2.length === 1 && gen2[0].payload.rows[0].metadata.displayName.indexOf('\u{1F434}') >= 0, posted);

  // 3. Media URLs riding along in the same frame.
  posted.length = 0;
  sandbox.__nextResponse = makeResponse(BATCH_URL, envelope([['ogiZ0b', {
    media: [{ name: 'media-1', image: { generatedImage: { fifeUrl: 'https://flow-content.google/image/xyz?Expires=1' } } }],
  }]]), 'application/json; charset=UTF-8');
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  check('media URLs extracted from a batchexecute frame',
    posted.some((m) => m && m.type === 'FLOW_NETWORK_MEDIA_URL' && m.payload.mediaId === 'media-1'), posted);

  // 4. Purely positional payload -> no row, but the mapping diagnostic must
  //    fire, as a copy-pasteable string, with the raw structure included.
  posted.length = 0; logs.length = 0;
  sandbox.__nextResponse = makeResponse(BATCH_URL, envelope([['NEWRPC', [
    ['77777777-8888-9999-aaaa-bbbbbbbbbbbb', 'a boy playing with a horse', '2026-09-07T17:10:00Z',
      'https://flow-content.google/image/ccccdddd-1111-2222-3333-444444444444?Expires=9'],
  ]]]), 'application/json; charset=UTF-8');
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  check('positional payload posts no bogus row',
    !posted.some((m) => m && m.type === 'FLOW_NETWORK_GENERATION'), posted);

  const diag = logs.find((l) => String(l[0]).indexOf('FLOW MAPPING SAMPLE') >= 0);
  check('mapping diagnostic fires', Boolean(diag));
  if (diag) {
    const blob = String(diag[0]);
    check('diagnostic is a single string arg (survives console copy/paste)',
      diag.length === 1 && typeof diag[0] === 'string');
    check('diagnostic includes the raw decoded payload', blob.indexOf('RAW DECODED PAYLOAD') >= 0);
    check('diagnostic carries uuid + prompt + media url',
      blob.indexOf('77777777-8888-9999-aaaa-bbbbbbbbbbbb') >= 0
      && blob.indexOf('a boy playing with a horse') >= 0
      && blob.indexOf('flow-content.google/image/ccccdddd') >= 0, blob.slice(0, 400));
    console.log('\n  --- what the console will now show ---');
    console.log(blob.split('\n').slice(0, 26).map((l) => '    ' + l).join('\n'));
    console.log('    ...');
  }

  // 5. Identical repeat outside a generation is suppressed (no flooding).
  logs.length = 0;
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  check('diagnostic does not repeat for the same rpcid outside a generation',
    !logs.some((l) => String(l[0]).indexOf('FLOW MAPPING SAMPLE') >= 0));

  // 5b. DURING a generation the same rpcid must still report NEW content -
  //     the completion frame usually reuses an rpcid already seen while idle.
  fireGenerateClick();
  logs.length = 0;
  sandbox.__nextResponse = makeResponse(BATCH_URL, envelope([['NEWRPC', [
    ['99999999-8888-9999-aaaa-bbbbbbbbbbbb', 'the finished render', '2026-09-07T17:20:00Z',
      'https://flow-content.google/image/eeeeffff-1111-2222-3333-444444444444?Expires=9'],
  ]]]), 'application/json; charset=UTF-8');
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  const during = logs.find((l) => String(l[0]).indexOf('FLOW MAPPING SAMPLE') >= 0);
  check('same rpcid with NEW content is reported during a generation', Boolean(during), logs.length);
  check('during-generation sample is flagged as such',
    Boolean(during) && String(during[0]).indexOf('duringGeneration: true') >= 0);

  // 5c. ...but an exact repeat during a generation is still suppressed.
  logs.length = 0;
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  check('exact repeat during a generation is still suppressed',
    !logs.some((l) => String(l[0]).indexOf('FLOW MAPPING SAMPLE') >= 0));

  // 6. A garbage / malformed body must not throw or post.
  posted.length = 0;
  sandbox.__nextResponse = makeResponse(BATCH_URL, ')]}\'\n\nnot json at all [[[', 'application/json');
  await sandbox.window.fetch(BATCH_URL);
  await new Promise((r) => setTimeout(r, 30));
  check('malformed envelope is survived without posting anything',
    !posted.some((m) => m && m.type === 'FLOW_NETWORK_GENERATION'));

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error('harness error', e); process.exit(1); });
