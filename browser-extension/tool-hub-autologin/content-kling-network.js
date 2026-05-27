(function installRmwKlingNetworkTelemetry() {
  if (window.__rmwKlingNetworkTelemetryInstalled) return;
  window.__rmwKlingNetworkTelemetryInstalled = true;

  const SOURCE = 'rmw-kling-network-telemetry';
  const MAX_TEXT_LENGTH = 120000;
  const MAX_BODY_LENGTH = 12000;
  const GENERATION_URL_RE = /(generate|generation|submit|create|infer|aigc|image|video|task)/i;
  const EXCLUDED_URL_RE = /(balance|wallet|account|user|profile|history|list|records?|assets?|works?|notifications?|message|comment|feed|search|recommend|config|price|pricing|package|membership|subscription)/i;
  const URL_RE = /(kling\.ai|klingai\.com)/i;
  const MAX_REASONABLE_CREDIT_BURN = 200;

  function toText(value) {
    try {
      if (value == null) return '';
      if (typeof value === 'string') return value;
      if (value instanceof URLSearchParams) return value.toString();
      if (value instanceof FormData) {
        const parts = [];
        value.forEach((entryValue, key) => {
          parts.push(`${key}=${typeof entryValue === 'string' ? entryValue : '[file]'}`);
        });
        return parts.join('&');
      }
      if (value instanceof Blob || value instanceof ArrayBuffer) return '';
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }

  function limitText(value, maxLength = MAX_TEXT_LENGTH) {
    const text = toText(value);
    return text.length > maxLength ? text.slice(0, maxLength) : text;
  }

  function parseJson(text) {
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function normalizeUrl(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input && typeof input.url === 'string') return new URL(input.url, location.href).href;
    } catch {}
    return `${input || ''}`;
  }

  function requestBodyFromFetchArgs(input, init) {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      return limitText(init.body, MAX_BODY_LENGTH);
    }
    try {
      if (input && typeof input.clone === 'function') {
        return '';
      }
    } catch {}
    return '';
  }

  function shouldInspect(url, requestText) {
    if (!URL_RE.test(url)) return false;
    if (EXCLUDED_URL_RE.test(url)) return false;
    const haystack = `${url}\n${requestText || ''}`;
    return GENERATION_URL_RE.test(haystack);
  }

  function isObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value);
  }

  function walk(value, visitor, depth = 0, seen = new Set()) {
    if (depth > 8 || value == null || typeof value !== 'object') return undefined;
    if (seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 80)) {
        const found = walk(item, visitor, depth + 1, seen);
        if (found !== undefined) return found;
      }
      return undefined;
    }

    for (const [key, item] of Object.entries(value)) {
      const found = visitor(key, item, value);
      if (found !== undefined) return found;
      const nested = walk(item, visitor, depth + 1, seen);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }

  function pickString(value, matcher) {
    const direct = walk(value, (key, item) => {
      if (!matcher.test(key)) return undefined;
      if (typeof item === 'string' || typeof item === 'number') {
        const text = `${item}`.trim();
        return text || undefined;
      }
      return undefined;
    });
    return direct || '';
  }

  function pickNumber(value, matcher, options = {}) {
    const excludeMatcher = options.excludeMatcher || /^(balance|current|remaining|remain|total|available|obtained|purchase|quota|limit|package|price|pricing|wallet)$/i;
    const direct = walk(value, (key, item, parent) => {
      if (!matcher.test(key)) return undefined;
      const parentKeys = isObject(parent) ? Object.keys(parent).join('_') : '';
      if (excludeMatcher.test(key) || excludeMatcher.test(parentKeys)) return undefined;
      if (typeof item === 'number' && Number.isFinite(item)) return item;
      if (typeof item === 'string' && /^-?\d+(?:\.\d+)?$/.test(item.trim())) return Number(item);
      return undefined;
    });
    return Number.isFinite(direct) ? direct : null;
  }

  function makeHash(value) {
    let hash = 2166136261;
    const text = `${value || ''}`;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function extractTelemetry(payload) {
    const responseJson = payload.responseJson;
    const requestJson = payload.requestJson;
    const merged = isObject(responseJson) ? responseJson : {};
    const requestObject = isObject(requestJson) ? requestJson : {};
    const responseText = payload.responseText || '';
    const requestText = payload.requestText || '';

    const generationId = pickString(merged, /^(generation_?id|generate_?id|task_?id|job_?id|work_?id)$/i)
      || pickString(requestObject, /^(generation_?id|generate_?id|task_?id|job_?id|work_?id)$/i);
    const requestId = pickString(merged, /^(request_?id|trace_?id|log_?id)$/i)
      || pickString(requestObject, /^(request_?id|trace_?id)$/i);
    const creditsUsed = pickNumber(
      merged,
      /^(credits?_?used|credit_?used|consume_?credits?|consumed_?credits?|cost_?credits?|credit_?cost|actual_?credits?)$/i
    );
    const expectedCredits = pickNumber(
      requestObject,
      /^(expected_?credits?|credits?_?cost|credit_?cost|consume_?credits?)$/i
    );
    const modelLabel = pickString(merged, /^(model|model_?name|model_?label|scene)$/i)
      || pickString(requestObject, /^(model|model_?name|model_?label|scene)$/i);
    const durationLabel = pickString(merged, /^(duration|duration_?label|video_?duration)$/i)
      || pickString(requestObject, /^(duration|duration_?label|video_?duration)$/i);
    const resolutionLabel = pickString(merged, /^(resolution|resolution_?label|quality)$/i)
      || pickString(requestObject, /^(resolution|resolution_?label|quality)$/i);
    const promptText = pickString(requestObject, /^(prompt|text|query|positive_?prompt)$/i)
      || pickString(merged, /^(prompt|text|query|positive_?prompt)$/i);
    const status = pickString(merged, /^(status|state|task_?status)$/i);
    const isCompleted = /(complete|success|finish|done|settle)/i.test(status);
    const isCreditBurnReasonable = creditsUsed != null
      && creditsUsed > 0
      && creditsUsed <= MAX_REASONABLE_CREDIT_BURN;

    const fingerprint = makeHash([
      payload.method,
      payload.url,
      generationId,
      requestId,
      requestText.slice(0, 4000),
      responseText.slice(0, 4000),
    ].join('\n'));

    return {
      externalEventId: generationId || requestId || `net_${fingerprint}`,
      generationId,
      requestId,
      fingerprint,
      creditsUsed,
      expectedCredits,
      modelLabel,
      durationLabel,
      resolutionLabel,
      promptText,
      status,
      isCompleted,
      isCreditBurnReasonable,
    };
  }

  function postTelemetry(payload) {
    try {
      if (!shouldInspect(payload.url, payload.requestText)) return;
      const extracted = extractTelemetry(payload);
      if (!extracted.generationId && !extracted.requestId) return;
      if (!extracted.isCompleted && !extracted.isCreditBurnReasonable) return;

      window.postMessage({
        source: SOURCE,
        type: 'KLING_NETWORK_USAGE',
        payload: {
          ...extracted,
          method: payload.method,
          url: payload.url,
          ok: payload.ok,
          httpStatus: payload.httpStatus,
          source: payload.source,
          schemaVersion: 1,
          capturedAt: Date.now(),
          requestPreview: limitText(payload.requestText, 1500),
          responsePreview: limitText(payload.responseText, 3000),
        },
      }, location.origin);
    } catch {}
  }

  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function rmwKlingFetch(input, init) {
      const method = `${init?.method || input?.method || 'GET'}`.toUpperCase();
      const url = normalizeUrl(input);
      const requestText = requestBodyFromFetchArgs(input, init);
      const response = await originalFetch.apply(this, arguments);

      try {
        const cloned = response.clone();
        cloned.text().then((text) => {
          const responseText = limitText(text);
          postTelemetry({
            source: 'fetch_response',
            method,
            url,
            requestText,
            requestJson: parseJson(requestText),
            responseText,
            responseJson: parseJson(responseText),
            ok: response.ok,
            httpStatus: response.status,
          });
        }).catch(() => {});
      } catch {}

      return response;
    };
  }

  const OriginalXhr = window.XMLHttpRequest;
  if (typeof OriginalXhr === 'function') {
    const originalOpen = OriginalXhr.prototype.open;
    const originalSend = OriginalXhr.prototype.send;

    OriginalXhr.prototype.open = function rmwKlingXhrOpen(method, url) {
      this.__rmwKlingMethod = `${method || 'GET'}`.toUpperCase();
      this.__rmwKlingUrl = normalizeUrl(url);
      return originalOpen.apply(this, arguments);
    };

    OriginalXhr.prototype.send = function rmwKlingXhrSend(body) {
      const requestText = limitText(body, MAX_BODY_LENGTH);
      this.addEventListener('loadend', () => {
        try {
          const responseText = limitText(this.responseType && this.responseType !== 'text' ? '' : this.responseText);
          postTelemetry({
            source: 'xhr_response',
            method: this.__rmwKlingMethod || 'GET',
            url: this.__rmwKlingUrl || '',
            requestText,
            requestJson: parseJson(requestText),
            responseText,
            responseJson: parseJson(responseText),
            ok: this.status >= 200 && this.status < 400,
            httpStatus: this.status,
          });
        } catch {}
      });
      return originalSend.apply(this, arguments);
    };
  }
})();
