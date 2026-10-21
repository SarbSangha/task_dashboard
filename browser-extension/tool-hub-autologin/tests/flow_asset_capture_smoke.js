// End-to-end harness for content-flow.js's asset-observation capture.
// Loads the REAL content script with a stubbed page/extension environment,
// drives a realistic generation, and asserts the capture events it emits.
const fs = require('fs');
const vm = require('vm');

const path = require('path');
const SRC = path.join(__dirname, '..', 'content-flow.js');

const sentMessages = [];
const logs = [];
const listeners = {};
const timers = [];

// ---- DOM stubs -----------------------------------------------------------
function makeEl(tag, props) {
  return Object.assign({
    tagName: tag,
    nodeType: 1,
    style: {},
    isContentEditable: false,
    getAttribute: () => null,
    setAttribute: () => {},
    appendChild: () => {},
    remove: () => {},
    addEventListener: () => {},
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
  }, props || {});
}

const composer = makeEl('TEXTAREA', { value: '' });
let domImages = [];
// document.querySelector results, by exact selector.
const domBySelector = {};

// A Flow button: its text includes Material icon ligatures, like the real one.
function makeFlowButton(text, icons, parentElement) {
  const iconEls = icons.map((name) => makeEl('MAT-ICON', { textContent: name }));
  return makeEl('BUTTON', {
    textContent: text,
    parentElement: parentElement || null,
    querySelectorAll: (sel) => (sel === 'mat-icon' ? iconEls : []),
  });
}

const documentStub = {
  readyState: 'complete',
  body: makeEl('BODY', { innerText: 'Flow app shell with enough text to look authenticated for the gate checks.' }),
  documentElement: makeEl('HTML'),
  activeElement: composer,
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  removeEventListener: () => {},
  getElementById: () => null,
  createElement: (tag) => makeEl(String(tag).toUpperCase()),
  querySelector: (sel) => domBySelector[sel] || null,
  querySelectorAll: (sel) => {
    if (String(sel).indexOf('textarea') >= 0) return [composer];
    if (String(sel).indexOf('img') >= 0) return domImages;
    return [];
  },
};

// ---- Resource Timing stub ------------------------------------------------
let resourceEntries = [];
let perfObserverCb = null;
const performanceStub = {
  getEntriesByType: () => resourceEntries.slice(),
  now: () => Date.now(),
  timeOrigin: Date.now(),
};

class PerformanceObserverStub {
  constructor(cb) { perfObserverCb = cb; }
  observe() {}
  disconnect() {}
}

function loadAsset(url) {
  const entry = { name: url, entryType: 'resource', startTime: Date.now() };
  resourceEntries.push(entry);
  if (perfObserverCb) perfObserverCb({ getEntries: () => [entry] });
}

// ---- window / chrome stubs ----------------------------------------------
const windowStub = {
  location: {
    hostname: 'flow.google.com',
    pathname: '/project/4c430551-63ab-4cdb-bf81-d8053f18064d',
    href: 'https://flow.google.com/project/4c430551-63ab-4cdb-bf81-d8053f18064d',
    search: '',
    origin: 'https://flow.google.com',
    replace: () => {},
  },
  addEventListener: (t, fn) => { (listeners[t] = listeners[t] || []).push(fn); },
  setTimeout: (fn, ms) => { const id = setTimeout(fn, ms); timers.push(id); return id; },
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => { const id = setInterval(fn, ms); timers.push(id); return id; },
  clearInterval: (id) => clearInterval(id),
  postMessage: () => {},
  getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  performance: performanceStub,
  PerformanceObserver: PerformanceObserverStub,
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  MutationObserver: class { observe() {} disconnect() {} },
};
windowStub.window = windowStub;

const storage = {};
const chromeStub = {
  runtime: {
    lastError: null,
    sendMessage: (msg, cb) => { sentMessages.push(msg); if (cb) setTimeout(() => cb({ ok: true, queued: true }), 0); },
  },
  storage: {
    local: {
      get: (keys, cb) => cb(storage),
      set: (obj, cb) => { Object.assign(storage, obj); if (cb) cb(); },
    },
  },
};

const sandbox = {
  window: windowStub,
  document: documentStub,
  location: windowStub.location,
  navigator: { userAgent: 'harness' },
  chrome: chromeStub,
  performance: performanceStub,
  PerformanceObserver: PerformanceObserverStub,
  console: {
    debug: (...a) => logs.push(a), warn: (...a) => logs.push(a),
    error: (...a) => logs.push(a), log: (...a) => logs.push(a),
  },
  setTimeout, clearTimeout, setInterval, clearInterval,
  MutationObserver: class { observe() {} disconnect() {} },
  URL, URLSearchParams, Set, Map, Promise, JSON, Math, Date, Object, Array,
  Number, String, Boolean, Error, RegExp, isNaN, parseInt, parseFloat,
  fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
  // Provided by content-flow-task-modal.js in production.
  openFlowTaskSelectionModal: () => Promise.resolve({
    taskId: 1161, taskName: 'asa', clientId: 2, clientName: 'Sika',
  }),
};
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Drives the real gate handler the MAIN world would trigger.
function fireGateRequest(gateId) {
  for (const fn of listeners.message || []) {
    fn({
      source: windowStub,
      data: {
        source: 'rmw-flow-network-telemetry',
        type: 'FLOW_GENERATE_GATE_REQUEST',
        payload: { gateId },
      },
    });
  }
}

function typePrompt(text) {
  composer.value = text;
  for (const fn of listeners.input || []) fn({ target: composer });
}

function captureEvents() {
  return sentMessages.filter((m) => m && m.type === 'FLOW_CAPTURE_EVENT').map((m) => m.event);
}

const IMG = (id) => `https://flow-content.google/image/${id}?Expires=1788900000&KeyName=labs-flow-prod-cdn-key&Signature=abc`;
const NEW_A = 'ae1bdfc6-4faf-4962-bb6b-93b9882f2c70';
const NEW_B = 'e69784f2-ea1a-4999-856e-a2baa4bfa60e';
const OLD_1 = '11111111-1111-1111-1111-111111111111';

async function run() {
  let failures = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS  ' : 'FAIL  ') + name);
    if (!cond) { failures += 1; if (extra !== undefined) console.log('        ' + String(JSON.stringify(extra)).slice(0, 700)); }
  };

  // Pre-existing gallery images load before any generation.
  loadAsset(IMG(OLD_1));
  await wait(20);
  check('pre-existing gallery asset is NOT captured', captureEvents().length === 0, captureEvents());

  // Flow's composer (as seen live 2026-10-21). The model is only in the DOM
  // while the settings panel is open: open it, let the click listener read
  // it, then close it again before generating.
  domBySelector['[aria-label="Settings trigger"]'] = makeFlowButton(' Video · 360p · 10s crop_16_9 x1 ', ['crop_16_9']);
  const panel = makeEl('DIV', { textContent: 'Video Frames Ingredients Omni 1.1 Flash 360p 720p x1 Generating will use 7 credits' });
  domBySelector['[aria-label="Select model family"]'] = makeFlowButton('Omni 1.1 Flash arrow_drop_down', ['arrow_drop_down'], panel);
  for (const fn of listeners.click || []) fn({});
  await wait(350);
  delete domBySelector['[aria-label="Select model family"]'];
  check('model seen in the settings panel is remembered across reloads',
    JSON.stringify(storage.rmw_flow_last_models) === JSON.stringify({ video: 'Omni 1.1 Flash' }), storage.rmw_flow_last_models);

  // The user types a prompt, then clicks Generate (gate -> picker -> arm).
  // Flow swaps the composer to its "generating" state right after the click,
  // so the settings trigger is gone by the time the picker resolves and the
  // session arms (seen live 2026-10-21) - the click-time snapshot must win.
  typePrompt('boy with pagesys');
  const generateButton = makeEl('BUTTON', { getAttribute: (name) => (name === 'aria-label' ? 'Start generation' : null) });
  generateButton.closest = () => generateButton;
  for (const fn of listeners.pointerdown || []) fn({ target: generateButton });
  const triggerAtClick = domBySelector['[aria-label="Settings trigger"]'];
  delete domBySelector['[aria-label="Settings trigger"]'];
  fireGateRequest('gate-1');
  await wait(50);

  // The generated images arrive.
  loadAsset(IMG(NEW_A));
  await wait(100);
  loadAsset(IMG(NEW_B));
  check('no row emitted before the settle delay', captureEvents().length === 0, captureEvents());

  await wait(5400); // FLOW_MEDIA_SETTLE_MS + margin
  domBySelector['[aria-label="Settings trigger"]'] = triggerAtClick;

  const events = captureEvents();
  const rows = events.filter((e) => e.event_type === 'generation_workflow_row');
  const media = events.filter((e) => e.event_type === 'media_url_resolved');

  check('one row per generated image', rows.length === 2, rows.map((r) => r.creation_id));
  check('old gallery image never became a row',
    !rows.some((r) => r.creation_id === OLD_1), rows.map((r) => r.creation_id));

  const rowA = rows.find((r) => r.creation_id === NEW_A);
  check('creation_id is the media uuid from the asset URL', Boolean(rowA), rows);
  if (rowA) {
    const md = rowA.payload.metadata;
    check('prompt captured from the composer', md.displayName === 'boy with pagesys', md);
    check('primaryMediaId matches (the backend media-url join key)', md.primaryMediaId === NEW_A, md);
    check('projectId read from the URL',
      rowA.payload.projectId === '4c430551-63ab-4cdb-bf81-d8053f18064d', rowA.payload);
    check('createTime is a parseable ISO timestamp', !Number.isNaN(Date.parse(md.createTime)), md);
    check('provenance marker present', md.rmwCaptureSource === 'asset-observation', md);
    check('task attribution carried through', rowA.linked_task_id === 1161, rowA);
    check('client attribution carried through', rowA.linked_client_id === 2, rowA);
    const st = md.rmwSettings || {};
    check('generation settings carried for costing',
      st.type === 'video' && st.model === 'Omni 1.1 Flash' && st.resolution === '360p' && st.durationSeconds === 10
        && st.aspectRatio === '16:9' && st.outputs === 1, st);
    check("Flow's own credit quote kept when seen for the same settings", st.quotedCredits === 7, st);
  }

  const bothSameBatch = rows.length === 2 && rows[0].payload.metadata.batchId === rows[1].payload.metadata.batchId;
  check('both images share one batchId (one Generate click)', bothSameBatch,
    rows.map((r) => r.payload.metadata.batchId));

  check('a media_url_resolved event accompanies each row', media.length === 2, media.length);
  const mediaA = media.find((m) => m.payload.mediaId === NEW_A);
  check('media event carries the full signed URL',
    Boolean(mediaA) && mediaA.payload.url.indexOf('Signature=abc') >= 0, mediaA);

  // Re-loading the same asset later (scroll/re-render) must not duplicate.
  sentMessages.length = 0;
  typePrompt('second prompt');
  fireGateRequest('gate-2');
  await wait(50);
  loadAsset(IMG(NEW_A));
  await wait(5400);
  check('re-loaded asset is not captured twice', captureEvents().length === 0, captureEvents());

  // Regression: a SECOND generation inside the same arm window must still be
  // captured. An earlier version keyed precedence off capturedCreationIds,
  // which this file writes its own rows into, so the first flush of a cycle
  // suppressed every later one.
  sentMessages.length = 0;
  typePrompt('third prompt same window');
  fireGateRequest('gate-2b');
  await wait(50);
  const SECOND = '22222222-3333-4444-5555-666666666666';
  loadAsset(IMG(SECOND));
  await wait(5400);
  const secondRows = captureEvents().filter((e) => e.event_type === 'generation_workflow_row');
  check('second generation in the same arm window is still captured',
    secondRows.some((r) => r.creation_id === SECOND), secondRows.map((r) => r.creation_id));
  check('second generation uses the newer prompt',
    secondRows.length > 0 && secondRows[0].payload.metadata.displayName === 'third prompt same window',
    secondRows.map((r) => r.payload.metadata.displayName));

  // Regression: a video's poster and clip share the media id AND the Expires
  // value. The clip's media event used to get the poster's exact
  // client_event_id, so it was deduped away and the row kept the still.
  sentMessages.length = 0;
  typePrompt('boy running from dogs');
  fireGateRequest('gate-video');
  await wait(50);
  const VID = 'e2812a58-7bd8-45da-81db-b76eda2f3979';
  const signed = '?Expires=1792581558&KeyName=labs-flow-prod-cdn-key&Signature=';
  loadAsset(`https://flow-content.google/image/${VID}${signed}poster`);
  await wait(50);
  loadAsset(`https://flow-content.google/video/${VID}${signed}clip`);
  await wait(5400);
  const videoMedia = captureEvents().filter((e) => e.event_type === 'media_url_resolved' && e.payload.mediaId === VID);
  check('video clip URL is reported alongside its poster',
    videoMedia.some((m) => m.payload.url.indexOf('/video/') >= 0), videoMedia.map((m) => m.payload.url));
  check('poster and clip get distinct client_event_ids',
    new Set(videoMedia.map((m) => m.client_event_id)).size === videoMedia.length && videoMedia.length === 2,
    videoMedia.map((m) => m.client_event_id));

  // A real network-decoded row must win over the synthetic path.
  sentMessages.length = 0;
  fireGateRequest('gate-3');
  await wait(50);
  const realId = 'd0d589e3-b915-49be-9a85-ac5711209430';
  for (const fn of listeners.message || []) {
    fn({
      source: windowStub,
      data: {
        source: 'rmw-flow-network-telemetry',
        type: 'FLOW_NETWORK_GENERATION',
        payload: {
          transport: 'http',
          rows: [{
            name: realId,
            projectId: 'p',
            metadata: {
              displayName: 'real row', createTime: new Date().toISOString(),
              updateTime: new Date().toISOString(), primaryMediaId: 'zzz', batchId: 'realbatch',
            },
          }],
        },
      },
    });
  }
  await wait(30);
  loadAsset(IMG('99999999-9999-9999-9999-999999999999'));
  await wait(5400);
  const afterReal = captureEvents().filter((e) => e.event_type === 'generation_workflow_row');
  check('real network row is reported', afterReal.some((r) => r.creation_id === realId), afterReal.map((r) => r.creation_id));
  check('synthetic path stands down when the network path captured',
    afterReal.length === 1, afterReal.map((r) => r.creation_id));

  console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  for (const id of timers) { clearTimeout(id); clearInterval(id); }
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error('harness error', e); process.exit(1); });
