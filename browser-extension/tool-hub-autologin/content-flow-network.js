(function installRmwFlowNetworkTelemetry() {
  if (window.__rmwFlowNetworkTelemetryInstalled) return;
  window.__rmwFlowNetworkTelemetryInstalled = true;

  // MAIN-world network interceptor for Flow (labs.google/fx/tools/flow) -
  // mirrors content-freepik-network.js's philosophy (observe real traffic,
  // classify by body shape, never assume a URL contract is permanent) with
  // one structural difference: Flow's generation API lives on a DIFFERENT
  // host (aisandbox-pa.googleapis.com) than the page itself (labs.google).
  // That's fine - window.fetch/XMLHttpRequest are patched once, globally, on
  // this page's own JS context, and see every outgoing request regardless of
  // destination host, cross-origin or not (the page's own JS is what issues
  // these calls, with a Bearer token it already holds - no extra
  // host_permissions needed purely to observe the response).
  //
  // Confirmed via a real captured PATCH response (not guessed): one
  // generation = one flowWorkflows/{uuid} resource,
  //   { name, projectId, metadata: { displayName, createTime, updateTime,
  //     primaryMediaId, batchId } }
  // metadata.batchId is the "one Generate click" grouping key - two images
  // from one prompt shared the same batchId, different name/primaryMediaId.
  // See providers/flow/CAPTURE_CONTRACT.md for the full field mapping.
  //
  // A SECOND, independent detection path (below, "Media URL resolution")
  // closes the gap the comment above used to describe: the flowWorkflows
  // response only ever carries primaryMediaId, never an actual image URL.
  // Resolving one requires watching for a completely separate request
  // (media.getMediaUrlRedirect?name={mediaId}, confirmed live: a 307
  // redirect to a signed CDN URL) and reading where the browser ended up,
  // not the response body - see that section for why it can't reuse any of
  // the JSON-shape machinery above.
  const SOURCE = 'rmw-flow-network-telemetry';
  const MAX_TEXT_LENGTH = 500000;
  const HOST_RE = /(^|\.)aisandbox-pa\.googleapis\.com$/i;
  const PATH_HINT_RE = /flowworkflow/i;
  const EXCLUDED_PATH_RE = /\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm|css|woff2?|ttf|ico)(?:[?#]|$)/i;
  // Declared here rather than beside the other generate-gate patterns far
  // below because shouldInspectUrl() (the CAPTURE path, not the gate) now
  // needs it too - see its own 2026-09-07 comment.
  const BATCHEXECUTE_RE = /\/batchexecute(?:\?|$)/i;

  function isFlowGenerationHost(url) {
    try {
      return HOST_RE.test(new URL(url, location.href).hostname);
    } catch {
      return false;
    }
  }

  // 2026-09-07: reported by Sarbjeet - a real generation on flow.google.com
  // armed the gate and picked a task/client correctly (console:
  // "[RMW Flow Capture] armed {taskId: 1161, clientId: 2}") yet produced
  // ZERO capture events, leaving the badge stuck on "Waiting for
  // generation..." forever. Root cause: the gate was migrated to
  // flow.google.com's /_/AiSandboxAngularFrontend/data/batchexecute surface
  // that same day, but this - the CAPTURE path - was left on the original
  // contract, which hard-required the aisandbox-pa.googleapis.com REST host
  // (see CAPTURE_CONTRACT.md). Post-migration that host produces no
  // generation traffic at all (confirmed live: the ONLY requests a real
  // generation makes are batchexecute ones), so every response carrying a
  // workflow row was rejected here before its body was ever read - the
  // picker armed, and nothing ever arrived to be evaluated against it.
  //
  // batchexecute is matched host-independently and BEFORE the host check,
  // deliberately - same "shape over URL-certainty" philosophy as
  // isMediaRedirectUrl below. Every batchexecute response is inspected, not
  // just the generate call's own: the workflow row for an image is NOT in
  // the generate response (that only acknowledges the submission - the
  // render is still seconds away), it arrives in a later poll/update call
  // whose rpcids this file has no way to know in advance, and which
  // rotates per Google build anyway (see the generate gate's own comment on
  // why chasing rpcids was abandoned).
  function shouldInspectUrl(url) {
    if (BATCHEXECUTE_RE.test(url)) return true;
    if (!isFlowGenerationHost(url)) return false;
    if (EXCLUDED_PATH_RE.test(url)) return false;
    // Broad net on purpose - the body-shape check below
    // (looksLikeFlowWorkflowObject) is the real, precise gate. PATH_HINT_RE
    // just avoids wasting a JSON.parse on every single call to this host
    // (session/credits/other aisandbox endpoints may share it).
    return PATH_HINT_RE.test(url) || true;
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // Confirmed shape (see this file's own top comment) - name + a metadata
  // object carrying at least one of the fields this system actually reads.
  // Deliberately NOT gated on `metadata.batchId` alone (every field here is
  // optional individually) - an object with a bare `name` and SOME
  // recognizable metadata is enough to accept, since a still-processing
  // workflow may not have primaryMediaId yet but is still worth capturing
  // once it does show up in a later snapshot (see _is_stale_snapshot in
  // normalization.py, which resolves ordering across multiple captures of
  // the same workflow).
  function looksLikeFlowWorkflowObject(candidate) {
    if (!candidate || typeof candidate !== 'object') return false;
    if (typeof candidate.name !== 'string' || !candidate.name) return false;
    const metadata = candidate.metadata;
    if (!metadata || typeof metadata !== 'object') return false;
    return metadata.batchId !== undefined
      || metadata.primaryMediaId !== undefined
      || metadata.displayName !== undefined;
  }

  function extractWorkflowRows(json) {
    if (!json || typeof json !== 'object') return [];
    if (looksLikeFlowWorkflowObject(json)) return [json];
    // Defensive nesting checks for a future "list workflows" endpoint (never
    // confirmed to exist - see CAPTURE_CONTRACT.md's known gaps) - harmless
    // if it never shows up, since looksLikeFlowWorkflowObject is the real
    // gate either way.
    if (Array.isArray(json.data)) {
      return json.data.filter(looksLikeFlowWorkflowObject);
    }
    if (Array.isArray(json.workflows)) {
      return json.workflows.filter(looksLikeFlowWorkflowObject);
    }
    if (looksLikeFlowWorkflowObject(json.workflow)) return [json.workflow];
    return [];
  }

  // Diagnostic-only, never used for actual capture decisions - same
  // "shape learner" precedent as content-freepik-network.js's identical
  // function. Particularly useful here since video generation's shape is
  // unconfirmed: this is what will surface it the first time someone
  // generates a video with the extension active.
  function logUnrecognizedShapeIfPromising(url, json, text) {
    if (!json || typeof json !== 'object') return;
    const haystack = text.length <= 4000 ? text : text.slice(0, 4000);
    if (!/workflow|batchid|displayname/i.test(haystack)) return;
    console.debug('[RMW Flow Network] unrecognized but workflow-like response - please report this shape', {
      url,
      topLevelKeys: Object.keys(json),
      snippet: haystack.length > 1500 ? `${haystack.slice(0, 1500)}…` : haystack,
    });
  }

  function postGenerationRows(rows, sourceUrl, transport) {
    if (!rows.length) return;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'FLOW_NETWORK_GENERATION',
        payload: {
          rows,
          sourceUrl: `${sourceUrl || ''}`.slice(0, 2000),
          // 'http' (a direct fetch/XHR response to a request THIS tab
          // issued) is the only transport this interceptor produces - no
          // confirmed push/websocket completion signal exists for Flow (see
          // CAPTURE_CONTRACT.md). content-flow.js's live-capture gate still
          // checks this field for symmetry with the Freepik gate it mirrors,
          // in case a push transport is added here later.
          transport: transport || 'http',
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  // Confirmed live: the flowMedia:batchGenerateImages response body carries
  // BOTH the workflow row(s) (handled above) AND a sibling `media` array in
  // the SAME payload, each entry already holding a ready-to-use signed CDN
  // URL (`image.generatedImage.fifeUrl`) - no need to wait for a later
  // media.getMediaUrlRedirect call (the "Media URL resolution" section
  // below), which only fires once the image is actually viewed/re-rendered.
  // Extracting it here means new generations get a thumbnail immediately;
  // getMediaUrlRedirect remains a useful fallback for older/reconciled rows
  // whose original generation response was never captured.
  function extractMediaUrlRows(json) {
    if (!json || typeof json !== 'object' || !Array.isArray(json.media)) return [];
    return json.media
      .map((entry) => ({
        mediaId: entry?.name ? String(entry.name) : '',
        url: entry?.image?.generatedImage?.fifeUrl ? String(entry.image.generatedImage.fifeUrl) : '',
      }))
      .filter((row) => row.mediaId && row.url);
  }

  // ---- batchexecute envelope decoding (2026-09-07) ----
  // Google's generic RPC transport (the same one Gmail/Docs use) does not
  // return plain JSON, so parseJson() above returns null on every one of
  // these bodies - which is also why logUnrecognizedShapeIfPromising never
  // fired to warn us it was blind here: that function bails on a null json.
  // The wire format is:
  //
  //   )]}'
  //
  //   1234
  //   [["wrb.fr","<rpcid>","<payload as a JSON *string*>",null,null,null,"generic"]]
  //   56
  //   [["di",53],["af.httprm",53,"...",5]]
  //
  // i.e. an XSSI prefix, then repeating (byte-length line, JSON array)
  // chunks. The real response payload is double-encoded - a JSON string
  // sitting inside the outer array, which must be parsed a second time.
  //
  // The length lines are deliberately IGNORED rather than used to slice:
  // they count UTF-8 BYTES while JS string indices are UTF-16 code units,
  // so a single non-ASCII character in a prompt (an emoji, an accented
  // word) would desynchronize the walk and corrupt every later chunk.
  // Scanning for balanced top-level arrays instead is immune to that, and
  // to any future change in how Google frames the chunks.
  function extractTopLevelJsonArrays(text) {
    const out = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '[') {
        if (depth === 0) start = i;
        depth += 1;
        continue;
      }
      if (ch === ']') {
        if (depth === 0) continue; // stray bracket in a length preamble - ignore
        depth -= 1;
        if (depth === 0 && start >= 0) {
          const slice = text.slice(start, i + 1);
          start = -1;
          const parsed = parseJson(slice);
          if (parsed !== null) out.push(parsed);
        }
      }
    }
    return out;
  }

  // Returns [{ rpcid, payload }] for every wrb.fr frame in the envelope.
  // 'di' / 'af.httprm' frames are transport bookkeeping, never data.
  function decodeBatchExecuteFrames(text) {
    const frames = [];
    for (const arr of extractTopLevelJsonArrays(text)) {
      if (!Array.isArray(arr)) continue;
      for (const entry of arr) {
        if (!Array.isArray(entry) || entry[0] !== 'wrb.fr') continue;
        const rpcid = typeof entry[1] === 'string' ? entry[1] : '';
        const raw = typeof entry[2] === 'string' ? entry[2] : '';
        if (!raw) continue;
        const payload = parseJson(raw);
        if (payload !== null) frames.push({ rpcid, payload });
      }
    }
    return frames;
  }

  // The REST surface returned a workflow row as the entire response body, so
  // extractWorkflowRows() only ever had to look at the top level. Inside a
  // batchexecute payload the same object (where it survives in object form
  // at all) sits at an unknown depth among positional arrays, so the search
  // has to be structural. looksLikeFlowWorkflowObject() remains the single
  // source of truth for what counts as a row - this only changes WHERE it
  // is looked for.
  const DEEP_SCAN_MAX_NODES = 20000;

  function deepFindWorkflowObjects(root) {
    const found = [];
    const seen = new Set();
    const stack = [root];
    let visited = 0;
    while (stack.length && visited < DEEP_SCAN_MAX_NODES) {
      const node = stack.pop();
      visited += 1;
      if (!node || typeof node !== 'object') continue;
      if (seen.has(node)) continue; // JSON can't cycle, but this also dedupes shared refs
      seen.add(node);
      if (!Array.isArray(node) && looksLikeFlowWorkflowObject(node)) {
        found.push(node);
        continue; // a row's own children are its metadata, never another row
      }
      const values = Array.isArray(node) ? node : Object.values(node);
      for (const value of values) {
        if (value && typeof value === 'object') stack.push(value);
      }
    }
    return found;
  }

  // ---- Mapping diagnostics ----
  // Flow's batchexecute payloads are POSITIONAL arrays, not the named-field
  // objects the REST surface returned, so if the structural scan above finds
  // nothing there is no safe way to guess which array slot holds the
  // creation id vs the media id vs the batch id. Rather than invent a
  // mapping, this reports the raw evidence needed to write a correct one -
  // the same "shape learner" precedent as logUnrecognizedShapeIfPromising,
  // but targeted: only frames that genuinely look like they carry
  // generation data, and only once per rpcid, so a normal session is not
  // flooded by the ~20 unrelated batchexecute calls Flow fires constantly.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  const FLOW_MEDIA_URL_RE = /flow-content\.google\/|\.googleusercontent\.com\/|fifeUrl/i;
  const loggedDiagnosticRpcIds = new Set();

  function collectMappingEvidence(payload) {
    const uuids = [];
    const dates = [];
    const urls = [];
    const texts = [];
    const stack = [{ node: payload, path: '$' }];
    let visited = 0;
    while (stack.length && visited < DEEP_SCAN_MAX_NODES) {
      const current = stack.pop();
      const node = current.node;
      const path = current.path;
      visited += 1;
      if (typeof node === 'string') {
        if (UUID_RE.test(node)) uuids.push({ path, value: node });
        else if (ISO_DATE_RE.test(node)) dates.push({ path, value: node });
        else if (/^https?:\/\//i.test(node) && FLOW_MEDIA_URL_RE.test(node)) urls.push({ path, value: node.slice(0, 300) });
        else if (node.length >= 8 && node.length <= 2000 && /\s/.test(node)) texts.push({ path, value: node.slice(0, 200) });
        continue;
      }
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) stack.push({ node: node[i], path: path + '[' + i + ']' });
      } else {
        for (const key of Object.keys(node)) stack.push({ node: node[key], path: path + '.' + key });
      }
    }
    return { uuids, dates, urls, texts };
  }

  // Cheap, stable content fingerprint - only ever used to suppress an
  // IDENTICAL repeat of a frame already logged, never for correctness.
  function fingerprintPayload(payload) {
    let serialized = '';
    try { serialized = JSON.stringify(payload) || ''; } catch { return 'unserializable'; }
    let hash = 0;
    for (let i = 0; i < serialized.length; i += 1) {
      hash = ((hash << 5) - hash + serialized.charCodeAt(i)) | 0;
    }
    return serialized.length + ':' + hash;
  }

  function safeStringify(value, maxLength) {
    let out = '';
    try {
      out = JSON.stringify(value, null, 1) || String(value);
    } catch {
      return '<unserializable>';
    }
    if (out.length > maxLength) {
      out = out.slice(0, maxLength) + '\n… [truncated, ' + out.length + ' chars total]';
    }
    return out;
  }

  // Logged as a STRING, not an object (2026-09-07): Chrome renders a logged
  // object as a collapsed "Object" in the console, so copying the console
  // out - which is how these reports actually reach us - captured the word
  // "Object" and none of the contents. The first attempt at this diagnostic
  // fired correctly three times and still told us nothing for exactly that
  // reason. A pre-serialized string survives copy/paste intact.
  //
  // The RAW decoded payload is included alongside the extracted evidence
  // because the evidence alone (uuids/dates/urls by path) cannot show which
  // array slot means what - and Flow's payloads are positional, so the
  // surrounding structure is the whole point.
  function reportBatchExecuteMappingCandidate(rpcid, payload) {
    const inWindow = isWithinGenerateDiagnosticWindow();
    // Outside a generation, dedupe hard by rpcid so routine app chatter is
    // logged at most once. DURING one, dedupe only by exact content: the
    // frame carrying the finished row very often shares an rpcid with an
    // earlier, emptier poll of the same endpoint, and an rpcid-level guard
    // would suppress precisely the frame worth seeing.
    const key = inWindow ? rpcid + '#' + fingerprintPayload(payload) : rpcid;
    if (loggedDiagnosticRpcIds.has(key)) return;

    const evidence = collectMappingEvidence(payload);
    const hasAnything = evidence.uuids.length || evidence.dates.length
      || evidence.urls.length || evidence.texts.length;
    // Outside a generation: "looks like generation data" = a uuid AND either
    // a media URL or a timestamp, so ordinary chatter stays quiet. During
    // one: anything at all, since the completion frame's shape is exactly
    // what is unknown and a stricter filter could discard it unseen.
    const qualifies = inWindow
      ? hasAnything
      : (evidence.uuids.length && (evidence.urls.length || evidence.dates.length));
    if (!qualifies) return;
    loggedDiagnosticRpcIds.add(key);

    console.debug(
      '[RMW Flow Network] ===== FLOW MAPPING SAMPLE (copy everything below) =====\n'
      + 'rpcid: ' + rpcid + '\n'
      + 'duringGeneration: ' + inWindow + '\n'
      + '--- RAW DECODED PAYLOAD ---\n'
      + safeStringify(payload, 12000) + '\n'
      + '--- EXTRACTED EVIDENCE ---\n'
      + safeStringify({
        uuids: evidence.uuids.slice(0, 25),
        timestamps: evidence.dates.slice(0, 25),
        mediaUrls: evidence.urls.slice(0, 10),
        textCandidates: evidence.texts.slice(0, 20),
      }, 6000) + '\n'
      + '===== END FLOW MAPPING SAMPLE =====',
    );
  }

  function inspectBatchExecuteResponse(url, text, transport) {
    const frames = decodeBatchExecuteFrames(text);
    if (!frames.length) return;
    for (const frame of frames) {
      const rows = deepFindWorkflowObjects(frame.payload);
      if (rows.length) {
        console.debug('[RMW Flow Network] found workflow row(s) in batchexecute frame', {
          url, rpcid: frame.rpcid, count: rows.length, transport,
        });
        postGenerationRows(rows, url, transport);
      } else {
        reportBatchExecuteMappingCandidate(frame.rpcid, frame.payload);
      }
      extractMediaUrlRows(frame.payload).forEach((row) => postMediaUrl(row.mediaId, row.url));
    }
  }

  function inspectResponseText(url, text, transport) {
    if (!text || text.length > MAX_TEXT_LENGTH) return;
    if (BATCHEXECUTE_RE.test(url)) {
      inspectBatchExecuteResponse(url, text, transport);
      return;
    }
    const json = parseJson(text);
    const rows = extractWorkflowRows(json);
    if (rows.length) {
      console.debug('[RMW Flow Network] found workflow row(s) in response', { url, count: rows.length, transport });
      postGenerationRows(rows, url, transport);
    } else {
      logUnrecognizedShapeIfPromising(url, json, text);
    }
    extractMediaUrlRows(json).forEach((row) => postMediaUrl(row.mediaId, row.url));
  }

  // ---- Media URL resolution ----
  // Matched on the URL substring alone, regardless of host - the full
  // authority was never visible in DevTools' compact Name column when this
  // was captured live, so (same "shape over URL-certainty" philosophy as
  // the rest of this file) this doesn't guess one. Deliberately host-
  // independent, unlike shouldInspectUrl above.
  const MEDIA_REDIRECT_RE = /getMediaUrlRedirect/i;

  function isMediaRedirectUrl(url) {
    return MEDIA_REDIRECT_RE.test(url);
  }

  // Reads the `name` query param off the REQUEST url (before the browser
  // follows the redirect) - this is the mediaId, matching
  // FlowGeneration.primary_media_id exactly. The resolved signed CDN URL
  // itself never contains this id in a matchable form, only the original
  // request does.
  function extractMediaIdFromUrl(url) {
    try {
      return new URL(url, location.href).searchParams.get('name') || '';
    } catch {
      return '';
    }
  }

  // Never touches the response BODY (it's an image, not JSON) - only the
  // final resolved URL matters, read via the standard Response.url /
  // XHR.responseURL property, which reflects where the browser ended up
  // after automatically following the 307, not the originally requested URL.
  function postMediaUrl(mediaId, resolvedUrl) {
    if (!mediaId || !resolvedUrl) return;
    try {
      window.postMessage({
        source: SOURCE,
        type: 'FLOW_NETWORK_MEDIA_URL',
        payload: { mediaId, url: resolvedUrl, capturedAt: Date.now() },
      }, location.origin);
    } catch {}
  }

  // ---- Generate-request gate ----
  // Holds the ACTUAL network call to Flow's generate endpoint - never
  // calling the real fetch/XHR send - until content-flow.js (ISOLATED
  // world) posts back a decision from its task/client picker. Deliberately
  // does NOT touch the click/keydown that triggered this call (that
  // happened before fetch() was even invoked): its recaptcha token was
  // already legitimately minted by Flow's own code from that genuinely
  // trusted gesture, and holding the outgoing HTTP call for the few seconds
  // it takes to pick a task/client doesn't invalidate it (enterprise
  // recaptcha tokens are valid for ~2 minutes, not tied to dispatch
  // timing). See content-flow.js's own "Generate gate" comment for the two
  // earlier designs this replaced and why both broke real generation.
  // Reported 2026-09-07 (Sarbjeet): generating anything produced no client/
  // task picker at all - the real request just fired immediately, for BOTH
  // images and video. Root cause found via a real captured Network-tab
  // listing (not guessed): post-migration, flow.google.com's own generate
  // action does not go through a REST-shaped flowMedia:batchGenerateImages
  // call at all - it's dispatched through Google's generic /batchexecute
  // RPC framework (the same mechanism Gmail/Docs use), where the actual
  // method is an opaque `rpcids` code in the query string, not a readable
  // name. In that capture, rpcids=as29s fired exactly twice (matching the
  // UI's own "x2" output count), ~1.1s each - far longer than every other
  // batchexecute call in the same capture - and both calls completed BEFORE
  // the resulting images began downloading from the CDN; every other rpcid
  // seen (nzlxg, WuwhI, DTaVef) fired only afterward, alongside analytics/
  // logging pings. Not verified against the request body (no confirmed
  // prompt-text match), so still logged if wrong - see below. The old
  // flowMedia: pattern is kept as a harmless OR in case any surface still
  // uses it.
  const GENERATE_ENDPOINT_RE = /flowMedia:batchGenerate\w*/i;
  const BATCHEXECUTE_GENERATE_RPCIDS = ['as29s'];
  const RPCIDS_RE = /[?&]rpcids=([^&]*)/i;
  const FLOW_MEDIA_METHOD_RE = /flowMedia:\w+/i;
  const loggedUnmatchedMethods = new Set();

  function isKnownGenerateRpcId(rpcidsParam) {
    const ids = decodeURIComponent(rpcidsParam || '').split(',').map((id) => id.trim());
    return ids.some((id) => BATCHEXECUTE_GENERATE_RPCIDS.includes(id));
  }

  // ---- DOM-armed detection (2026-09-07, requested by Sarbjeet: "take a
  // reference from Freepik for that") ----
  //
  // rpcids codes turned out too fragile to chase one by one - a real capture
  // taken minutes apart from the first showed a COMPLETELY different set of
  // ~20 opaque codes for the SAME kind of action, with no overlap at all
  // (labs-ai-sandbox-frontend's own build tag, bl=..., was visible in both
  // URLs - these are plausibly build-scoped and rotate on Google's own
  // release cadence, not just per action type). Content-freepik.js's own
  // gate (findFreepikGenerateButtonAncestor et al.) solves this far more
  // robustly by never depending on a backend request shape at all - it
  // recognizes the Generate action from the DOM: a real button whose own
  // accessible name says "generate". That principle is borrowed here
  // (confirmed live from Sarbjeet's own DevTools inspection: Flow's real
  // button carries aria-label="Start generation" and class
  // "generate-icon-button" on a <flow-generate-icon-button> custom element)
  // - but NOT Freepik's actual mechanism, which blocks the click itself
  // (preventDefault, show the picker, re-dispatch a synthetic click once
  // resolved). content-flow.js's own "Generate gate" comment already
  // documents exactly why that specific mechanism was tried and reverted
  // for Flow: Flow's generate call carries a Google reCAPTCHA Enterprise
  // token that can only be minted from a genuinely browser-trusted gesture,
  // and a synthetic re-dispatched click can never produce a valid one - so
  // touching the click at all makes generation hang forever. This keeps
  // that hard constraint (the real gesture is NEVER prevented, stopped, or
  // redispatched - only observed) while borrowing Freepik's DOM-based
  // recognition to decide what to hold at the NETWORK layer instead: seeing
  // a real, enabled generate-labeled control receive a genuine pointerdown
  // (or an Enter submit inside the prompt box) arms a short window; any
  // /batchexecute call dispatched while that window is open is held for the
  // picker, whatever its rpcids happens to be this build. The known-rpcid
  // check above stays as a fast, no-DOM-dependency path for anything it
  // already recognizes; this is the fallback that doesn't care what Google
  // renames things to next.
  const GENERATE_CONTROL_LABEL_RE = /generat/i;
  const GENERATE_ARM_WINDOW_MS = 4000;
  const GENERATE_GATE_EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'OPTION']);
  let generateControlArmedAt = 0;
  const GENERATE_DIAGNOSTIC_WINDOW_MS = 120000;
  let generateDiagnosticUntil = 0;

  function isVisibleFlowElement(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    } catch {}
    return true;
  }

  // Real, actionable elements only (mirrors Freepik's own ACTION_SELECTORS
  // philosophy) - deliberately NOT matched on tag name. Flow's real button
  // sits inside a <flow-generate-icon-button> custom-element wrapper whose
  // own tag name contains "generate" too, but that wrapper is never itself
  // disabled - only the inner <button> is (confirmed live: Sarbjeet's own
  // DevTools inspection showed disabled="true" on the <button>, not its
  // wrapper). Matching the wrapper's tag name let the walk find a
  // "generate"-shaped match and stop there even while the real button one
  // level in was disabled - caught by this file's own dry-run test before
  // shipping. Requiring an actual clickable role/type here means the walk
  // only ever stops on the ONE element that can genuinely be disabled.
  const GENERATE_ACTION_TAGS = new Set(['BUTTON', 'A']);

  function isActionLikeFlowElement(el) {
    if (GENERATE_ACTION_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute?.('role');
    if (role === 'button') return true;
    const type = el.getAttribute?.('type');
    return type === 'submit' || type === 'button';
  }

  function looksLikeGenerateControl(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    if (!isActionLikeFlowElement(el)) return false;
    const ariaLabel = el.getAttribute('aria-label') || '';
    const className = typeof el.className === 'string' ? el.className : '';
    return GENERATE_CONTROL_LABEL_RE.test(ariaLabel) || GENERATE_CONTROL_LABEL_RE.test(className);
  }

  // Mirrors findFreepikGenerateButtonAncestor's own walk (never a form
  // field, never a fallback to the raw event target - only a real,
  // visible, enabled ancestor actually carrying the generate vocabulary).
  function findGenerateControlAncestor(el) {
    let current = el && el.nodeType === 1 ? el : el?.parentElement;
    let depth = 0;
    while (current && current !== document.body && depth < 8) {
      if (
        !GENERATE_GATE_EXCLUDED_TAGS.has(current.tagName)
        && looksLikeGenerateControl(current)
        && isVisibleFlowElement(current)
        && current.disabled !== true
        && current.getAttribute?.('aria-disabled') !== 'true'
      ) {
        return current;
      }
      current = current.parentElement;
      depth += 1;
    }
    return null;
  }

  // Shared across one arm cycle so every call this window catches - the
  // real generate submission AND any unrelated background call that
  // happens to also fire in the same few seconds (Flow issues plenty: the
  // Network capture that motivated this whole fix showed ~20 distinct
  // batchexecute calls firing constantly) - waits on and resolves from the
  // SAME single picker decision, instead of each one independently
  // reopening the modal. openFlowTaskSelectionModal() (ISOLATED world)
  // already dedupes a truly concurrent double-open; this is the MAIN-world
  // equivalent for calls spread across the window's several-second span,
  // where that concurrent-open guard would otherwise have already reset.
  let currentGenerateGateDecisionPromise = null;

  function armGenerateWindow(reason) {
    generateControlArmedAt = Date.now();
    generateDiagnosticUntil = Date.now() + GENERATE_DIAGNOSTIC_WINDOW_MS;
    currentGenerateGateDecisionPromise = null; // fresh arm cycle - previous cycle's decision (if any) no longer applies
    console.debug('[RMW Flow Network] generate control interaction detected - arming gate window', reason);
  }

  // Deliberately MUCH longer than GENERATE_ARM_WINDOW_MS (4s). That window
  // exists to decide which request to HOLD for the picker, and must be short
  // so unrelated background chatter isn't gated. This one exists only to
  // decide what to LOG, and has to outlive the whole render: the frame that
  // finally carries a finished image arrives tens of seconds after the
  // generate call is dispatched, long after the gate window has closed.
  function isWithinGenerateDiagnosticWindow() {
    return generateDiagnosticUntil > 0 && Date.now() < generateDiagnosticUntil;
  }

  function isWithinArmedGenerateWindow() {
    return generateControlArmedAt > 0 && (Date.now() - generateControlArmedAt) < GENERATE_ARM_WINDOW_MS;
  }

  function getArmedWindowGateDecision(url) {
    if (!currentGenerateGateDecisionPromise) {
      currentGenerateGateDecisionPromise = requestFlowGenerateGateDecision(url);
    }
    return currentGenerateGateDecisionPromise;
  }

  // Capturing-phase, deliberately never calls preventDefault/stopPropagation
  // - see this section's own comment above for why touching the gesture
  // itself is what broke generation before. pointerdown (not click) so the
  // window opens before Flow's own handler even starts running, maximizing
  // margin before the real fetch/XHR dispatch this is meant to catch.
  document.addEventListener('pointerdown', (event) => {
    const control = findGenerateControlAncestor(event.target);
    if (control) armGenerateWindow({ via: 'pointerdown', label: control.getAttribute?.('aria-label') || control.className });
  }, true);

  // Enter-to-submit inside the prompt box never touches a button element at
  // all - covers that path independently of the click-based one above.
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey) return;
    const target = event.target;
    const tag = target?.tagName;
    if (tag !== 'TEXTAREA' && target?.isContentEditable !== true) return;
    armGenerateWindow({ via: 'enter-submit' });
  }, true);

  // Returns the Promise the caller must await before dispatching the real
  // request, or null if this URL isn't a generate call at all (dispatch
  // immediately). A known/precise match (the confirmed flowMedia: pattern,
  // or an already-recognized rpcids value) always gets its OWN fresh
  // decision request - unchanged from before, and safe: those matches are
  // specific enough that two of them in close succession (e.g. the x2-
  // output as29s pair) are genuinely two related submissions, each
  // deserving its own gate call sharing the same underlying picker via
  // openFlowTaskSelectionModal()'s own concurrent-open dedupe. Only the
  // DOM-armed-window fallback match (see this section's own top comment)
  // uses the shared per-arm-cycle decision instead, since that path can't
  // tell a real generate call apart from unrelated background chatter
  // firing in the same window on request shape alone.
  function getFlowGenerateGateDecision(url) {
    if (GENERATE_ENDPOINT_RE.test(url)) return requestFlowGenerateGateDecision(url);

    if (BATCHEXECUTE_RE.test(url)) {
      const rpcidsMatch = RPCIDS_RE.exec(url);
      const rpcidsParam = rpcidsMatch ? rpcidsMatch[1] : '';
      if (rpcidsParam && isKnownGenerateRpcId(rpcidsParam)) return requestFlowGenerateGateDecision(url);

      if (isWithinArmedGenerateWindow()) {
        console.debug('[RMW Flow Network] batchexecute call held - within armed generate window', rpcidsParam, url);
        return getArmedWindowGateDecision(url);
      }

      // Diagnostic-only, same "shape learner" precedent as
      // logUnrecognizedShapeIfPromising above - every DISTINCT rpcids value
      // seen that isn't already a known generate call (and didn't fall in
      // an armed window either) gets logged once, so a genuinely new
      // generation surface still surfaces itself here for a future report.
      if (rpcidsParam && !loggedUnmatchedMethods.has(rpcidsParam)) {
        loggedUnmatchedMethods.add(rpcidsParam);
        console.debug(
          '[RMW Flow Network] batchexecute rpcids not recognized as a generate call - '
          + 'if this request IS a generate submission, report this rpcids value '
          + 'so the gate can be widened to cover it:',
          rpcidsParam,
          url,
        );
      }
      return null;
    }

    const methodMatch = FLOW_MEDIA_METHOD_RE.exec(url);
    if (methodMatch && !loggedUnmatchedMethods.has(methodMatch[0])) {
      loggedUnmatchedMethods.add(methodMatch[0]);
      console.debug(
        '[RMW Flow Network] flowMedia: RPC not recognized as a generate call - '
        + 'if this IS a generate request, report this method name '
        + 'so the gate can be widened to cover it:',
        methodMatch[0],
        url,
      );
    }
    return null;
  }

  let flowGenerateGateSeq = 0;
  const pendingFlowGenerateGates = new Map(); // gateId -> {resolve, reject}

  function requestFlowGenerateGateDecision(url) {
    const gateId = `flowgate_${Date.now()}_${++flowGenerateGateSeq}`;
    return new Promise((resolve, reject) => {
      pendingFlowGenerateGates.set(gateId, { resolve, reject });
      try {
        window.postMessage({
          source: SOURCE,
          type: 'FLOW_GENERATE_GATE_REQUEST',
          payload: { gateId, url: `${url || ''}`.slice(0, 2000) },
        }, location.origin);
      } catch (err) {
        pendingFlowGenerateGates.delete(gateId);
        reject(err);
      }
    });
  }

  // Separate source tag from SOURCE above so this listener (and
  // content-flow.js's own message listener, which only reacts to SOURCE)
  // never mistake each other's messages for something else on the shared
  // window - MAIN and ISOLATED worlds both dispatch/observe 'message'
  // events on the same actual window object.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== 'rmw-flow-network-telemetry-gate' || data.type !== 'FLOW_GENERATE_GATE_DECISION') return;
    const gateId = data.payload?.gateId;
    const pending = gateId ? pendingFlowGenerateGates.get(gateId) : null;
    if (!pending) return;
    pendingFlowGenerateGates.delete(gateId);
    if (data.payload?.allow) {
      pending.resolve();
    } else {
      pending.reject(new DOMException('Flow generation cancelled - no task/client selected', 'AbortError'));
    }
  });

  // ---- fetch ----
  const rawFetch = window.fetch;
  if (typeof rawFetch === 'function') {
    window.fetch = function rmwFlowFetch(input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const callArgs = arguments;
      const callThis = this;
      const dispatchReal = () => {
        const promise = rawFetch.apply(callThis, callArgs);
        const mediaId = isMediaRedirectUrl(url) ? extractMediaIdFromUrl(url) : '';
        const inspectJson = shouldInspectUrl(url);
        if (!mediaId && !inspectJson) return promise;
        return promise.then((response) => {
          try {
            if (mediaId && response?.url) postMediaUrl(mediaId, response.url);
          } catch {}
          if (inspectJson) {
            try {
              const contentType = `${response.headers?.get?.('content-type') || ''}`;
              // batchexecute is exempt from the content-type check: Google
              // serves that envelope with a variety of types (and sometimes
              // text/plain), and it is never plain JSON anyway - the decoder
              // that handles it does its own format validation, so a
              // content-type mismatch must not silently drop the one body
              // that actually carries generation rows.
              if (/json/i.test(contentType) || BATCHEXECUTE_RE.test(url)) {
                response.clone().text().then((text) => inspectResponseText(url, text, 'http')).catch(() => {});
              }
            } catch {}
          }
          return response;
        });
      };
      const gateDecision = getFlowGenerateGateDecision(url);
      if (gateDecision) {
        return gateDecision.then(dispatchReal);
        // A rejected gate decision (Cancel) propagates as a rejected fetch()
        // promise, exactly like a network failure - Flow's own .catch()
        // handles it, and critically, rawFetch is never called at all.
      }
      return dispatchReal();
    };
  }

  // ---- XMLHttpRequest ----
  const OriginalXHR = window.XMLHttpRequest;
  if (typeof OriginalXHR === 'function') {
    const rawOpen = OriginalXHR.prototype.open;
    const rawSend = OriginalXHR.prototype.send;

    OriginalXHR.prototype.open = function rmwFlowXhrOpen(method, url, ...rest) {
      this.__rmwFlowUrl = url;
      return rawOpen.call(this, method, url, ...rest);
    };

    OriginalXHR.prototype.send = function rmwFlowXhrSend(...args) {
      const url = this.__rmwFlowUrl || '';
      const xhr = this;
      const mediaId = isMediaRedirectUrl(url) ? extractMediaIdFromUrl(url) : '';
      const inspectJson = shouldInspectUrl(url);
      const attachObservers = () => {
        if (!mediaId && !inspectJson) return;
        xhr.addEventListener('loadend', function () {
          try {
            if (this.status < 200 || this.status >= 300) return;
            if (mediaId && this.responseURL) postMediaUrl(mediaId, this.responseURL);
          } catch {}
          if (inspectJson) {
            try {
              if (this.status < 200 || this.status >= 300) return;
              // See content-freepik-network.js's identical comment: responseText
              // throws if responseType isn't '' or 'text', so branch on it
              // rather than accessing it unconditionally.
              const responseType = this.responseType;
              if (responseType === '' || responseType === 'text') {
                if (typeof this.responseText === 'string') inspectResponseText(url, this.responseText, 'http');
              } else if (responseType === 'json') {
                if (this.response != null) inspectResponseText(url, JSON.stringify(this.response), 'http');
              }
            } catch {}
          }
        });
      };
      const gateDecision = getFlowGenerateGateDecision(url);
      if (gateDecision) {
        // real send() is deferred until the decision resolves - on Cancel
        // it is never called at all, same guarantee as the fetch path.
        gateDecision.then(
          () => { attachObservers(); rawSend.apply(xhr, args); },
          () => { try { xhr.dispatchEvent(new Event('error')); } catch {} },
        );
        return undefined;
      }
      attachObservers();
      return rawSend.apply(this, args);
    };
  }
})();
