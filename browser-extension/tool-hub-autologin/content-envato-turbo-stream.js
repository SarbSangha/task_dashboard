// content-envato-turbo-stream.js — decoder for React Router 7's compact
// array-reference wire format ("turbo-stream"), which every Envato
// `.data` route-loader response (app.envato.com is a React Router 7 app)
// is encoded in — confirmed NOT to be plain JSON by inspecting a real
// captured HAR of /generation-history.data (2026-08-07).
//
// Loaded into BOTH the MAIN world (content-envato-network.js, decoding
// responses to requests the page itself makes) and the isolated world
// (content-envato-capture.js's reconciliation walker, decoding responses to
// its OWN `fetch()` calls against the same endpoint) — see manifest.json's
// two app.envato.com content_script blocks. Chrome gives each `world` its
// own separate JS realm, so this file is loaded twice and each realm gets
// its own independent copy of decodeEnvatoTurboStream — no cross-realm
// sharing needed or attempted.
//
// The wire format: the whole response body is one flat JSON array. Reading
// index N of that array (decode(N)) works like this:
//   - if arr[N] is an array, every ELEMENT is itself an index — decode each.
//   - if arr[N] is a plain object, its keys look like "_7" (the digits are
//     an index into this same array holding the real property NAME as a
//     string) and each value is itself an index holding the property VALUE
//     — decode both, recursively.
//   - otherwise arr[N] is already a literal (string/number/boolean/null) —
//     return it as-is, no further indirection.
//   - a NEGATIVE index is a special sentinel for a value JSON can't encode
//     directly (undefined, in every real sample seen so far) — decoded as
//     `undefined`.
// This was reverse-engineered against real captured response bodies (see
// scratchpad/decode_test.js from the research session that built this
// provider) and is verified below against a small fixture built from real,
// observed field values before this file is ever used against live traffic.

function decodeEnvatoTurboStream(rawArray) {
  if (!Array.isArray(rawArray) || !rawArray.length) return undefined;
  const memo = new Map();

  function decode(i) {
    if (typeof i !== 'number' || i < 0) return undefined;
    if (memo.has(i)) return memo.get(i);

    const v = rawArray[i];

    if (Array.isArray(v)) {
      const out = [];
      memo.set(i, out); // set before recursing so a self-referential array can't infinite-loop
      for (const idx of v) out.push(decode(idx));
      return out;
    }

    if (v !== null && typeof v === 'object') {
      const out = {};
      memo.set(i, out);
      for (const key of Object.keys(v)) {
        const refIdx = parseInt(key.slice(1), 10);
        const propName = decode(refIdx);
        const propValue = decode(v[key]);
        out[propName] = propValue;
      }
      return out;
    }

    memo.set(i, v);
    return v;
  }

  return decode(0);
}

// Parses a raw `.data` response body (JSON-array-literal text) straight
// into its decoded object graph. Returns null (never throws) on anything
// that isn't well-formed JSON — a malformed/truncated response should
// degrade to "nothing captured this time", never crash the caller.
function parseEnvatoTurboStreamResponse(bodyText) {
  try {
    const rawArray = JSON.parse(bodyText);
    return decodeEnvatoTurboStream(rawArray);
  } catch {
    return null;
  }
}

// ---- Self-test: runs once at load, against a small fixture built from
// real observed field values (a real itemUuid/prompt/createdAt captured in
// the HAR this provider was built from), encoded by hand in the same
// reference scheme documented above. Cheap insurance against a subtle bug
// in a wire format we reverse-engineered rather than got from an official
// spec — logs a console.error (does not throw) if the algorithm ever stops
// matching what it was verified against. ----
(function selfTestEnvatoTurboStreamDecoder() {
  try {
    const fixture = [
      { _1: 2 }, // 0: { assets: <2> }
      'assets', // 1
      [3], // 2: [<3>]
      { // 3: one decoded item
        _4: 5, _6: 7, _8: 9, _10: 11, _12: 13, _14: 15, _16: 17,
      },
      'itemUuid', // 4
      'f654c923-d0a2-490a-b829-cb605000a351', // 5 (real itemUuid observed in the captured HAR)
      'itemType', // 6
      'genai-image', // 7
      'prompt', // 8
      'Add a ultra peak real human Indian business man near the car', // 9 (real prompt prefix observed)
      'createdAt', // 10
      '2026-07-14T05:55:39.742Z', // 11 (real timestamp observed)
      'aspectRatio', // 12
      1.781, // 13
      'isInWorkspace', // 14
      false, // 15
      'isDownloaded', // 16
      true, // 17
    ];
    const decoded = decodeEnvatoTurboStream(fixture);
    const item = decoded?.assets?.[0];
    const ok = item
      && item.itemUuid === 'f654c923-d0a2-490a-b829-cb605000a351'
      && item.itemType === 'genai-image'
      && item.createdAt === '2026-07-14T05:55:39.742Z'
      && item.aspectRatio === 1.781
      && item.isInWorkspace === false
      && item.isDownloaded === true;
    if (!ok) {
      console.error('[RMW Envato Capture] turbo-stream decoder self-test FAILED - decoded output did not match the known-good fixture', decoded);
    }
  } catch (error) {
    console.error('[RMW Envato Capture] turbo-stream decoder self-test threw', error);
  }
})();
