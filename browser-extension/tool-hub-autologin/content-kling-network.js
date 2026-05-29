(function installRmwKlingNetworkTelemetry() {
  if (window.__rmwKlingNetworkTelemetryInstalled) return;
  window.__rmwKlingNetworkTelemetryInstalled = true;

  const SOURCE = 'rmw-kling-network-telemetry';
  const MAX_TEXT_LENGTH = 120000;
  const MAX_BODY_LENGTH = 12000;
  const MAX_MEDIA_ASSETS = 8;
  const GENERATION_URL_RE = /(generate|generation|submit|create|infer|aigc|image|video|task)/i;
  const WALLET_URL_RE = /(balance|wallet|credits?|credit)/i;
  const EXCLUDED_URL_RE = /(balance|wallet|account|user|profile|history|list|records?|assets?|works?|notifications?|message|comment|feed|search|recommend|config|price|pricing|package|membership|subscription)/i;
  const URL_RE = /(kling\.ai|klingai\.com)/i;
  const MEDIA_URL_RE = /\.(?:png|jpe?g|webp|gif|avif|mp4|webm|mov|m4v|m3u8)(?:[?#]|$)/i;
  const MAX_REASONABLE_CREDIT_BURN = 3000;
  const GENERATE_INTENT_WINDOW_MS = 30000;
  let recentGenerateIntentUntil = 0;

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
    if (WALLET_URL_RE.test(url) && Date.now() <= recentGenerateIntentUntil) return true;
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

  function walkAll(value, visitor, depth = 0, seen = new Set()) {
    if (depth > 8 || value == null || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value.slice(0, 120)) {
        walkAll(item, visitor, depth + 1, seen);
      }
      return;
    }

    for (const [key, item] of Object.entries(value)) {
      visitor(key, item, value);
      if (item && typeof item === 'object') {
        walkAll(item, visitor, depth + 1, seen);
      }
    }
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

  function pickContextualId(value) {
    return walk(value, (key, item, parent) => {
      if (!/^id$/i.test(key)) return undefined;
      const parentKeys = isObject(parent) ? Object.keys(parent).join('_') : '';
      if (!/(generation|generate|task|job|work)/i.test(parentKeys)) return undefined;
      if (typeof item === 'string' || typeof item === 'number') {
        const text = `${item}`.trim();
        return text || undefined;
      }
      return undefined;
    }) || '';
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

  function normalizeCreditValue(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 && parsed <= MAX_REASONABLE_CREDIT_BURN
      ? parsed
      : null;
  }

  function normalizeWalletBalanceValue(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000000
      ? parsed
      : null;
  }

  function pickWalletBalance(value) {
    return walk(value, (key, item, parent) => {
      if (!/^(balance|current_?credits?|remaining_?credits?|remain_?credits?|available_?credits?|credits?|credit_?balance|wallet_?balance)$/i.test(key)) {
        return undefined;
      }
      const parentKeys = isObject(parent) ? Object.keys(parent).join('_') : '';
      if (/(used|consume|consumed|cost|price|pricing|package|total_spent|history)/i.test(`${key}_${parentKeys}`)) {
        return undefined;
      }
      const normalized = normalizeWalletBalanceValue(item);
      return normalized != null ? normalized : undefined;
    });
  }

  function pickCreditValue(value, matcher) {
    return normalizeCreditValue(pickNumber(value, matcher));
  }

  function pickFirstTextMatch(text, matcher) {
    const match = `${text || ''}`.match(matcher);
    return match ? `${match[1] || match[0]}`.trim() : '';
  }

  function inferMediaType(value, key = '') {
    const haystack = `${key || ''}\n${value || ''}`.toLowerCase();
    if (/\.(mp4|webm|mov|m4v|m3u8)(?:[?#]|$)/i.test(haystack) || /\b(video|mp4|m3u8)\b/i.test(haystack)) return 'video';
    if (/\.(png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(haystack) || /\b(image|img|cover|thumbnail|poster)\b/i.test(haystack)) return 'image';
    return 'media';
  }

  function normalizeMediaAssetUrl(value) {
    const text = `${value || ''}`.trim();
    if (!text || text.length > 4000) return '';
    if (/^data:/i.test(text)) return '';
    if (/^(https?:|blob:)/i.test(text)) {
      try {
        return text.startsWith('blob:') ? text : new URL(text, location.href).href;
      } catch {
        return text;
      }
    }
    if (/^\/\//.test(text)) return `${location.protocol}${text}`;
    if (MEDIA_URL_RE.test(text) && /^\/[^/]/.test(text)) {
      try {
        return new URL(text, location.href).href;
      } catch {}
    }
    return '';
  }

  function collectMediaAssetsFromPayload(...roots) {
    const assets = [];
    const seen = new Set();
    const addAsset = (url, key = '', source = 'payload') => {
      const normalizedUrl = normalizeMediaAssetUrl(url);
      if (!normalizedUrl || seen.has(normalizedUrl)) return;
      const keyLooksMedia = /(url|uri|src|download|resource|asset|image|img|video|cover|thumbnail|poster|watermark|origin|result|media)/i.test(key);
      if (!keyLooksMedia && !MEDIA_URL_RE.test(normalizedUrl) && !/^blob:/i.test(normalizedUrl)) return;
      seen.add(normalizedUrl);
      assets.push({
        assetType: inferMediaType(normalizedUrl, key),
        source,
        url: normalizedUrl,
        key: `${key || ''}`.slice(0, 120),
      });
    };

    for (const root of roots) {
      if (typeof root === 'string') {
        const matches = root.match(/(?:https?:\/\/|blob:)[^\s"'<>\\]+/gi) || [];
        for (const match of matches) addAsset(match, 'text', 'text');
        continue;
      }
      if (!root || typeof root !== 'object') continue;
      walkAll(root, (key, item) => {
        if (assets.length >= MAX_MEDIA_ASSETS) return;
        if (typeof item === 'string') addAsset(item, key, 'json');
      });
    }

    return assets.slice(0, MAX_MEDIA_ASSETS);
  }

  function inferGenerationModeFromTelemetry(text) {
    const normalized = `${text || ''}`;
    if (/\bmnu[_-]?img[_-]?aiweb\b/i.test(normalized)) {
      return 'image';
    }
    if (/\bmnu[_-]?video[_-]?aiweb\b/i.test(normalized)) {
      return 'video';
    }
    if (/\bvideo\s*\d+(?:\.\d+)?\b/i.test(normalized) || /\b(image[_-]?to[_-]?video|text[_-]?to[_-]?video|video_generation)\b/i.test(normalized)) {
      return 'video';
    }
    if (/\bimage\s*\d+(?:\.\d+)?\b/i.test(normalized) || /\b(image_generation|text[_-]?to[_-]?image|image[_-]?to[_-]?image|strengthen)\b/i.test(normalized)) {
      return 'image';
    }
    if (/\bavatar\b/i.test(normalized) || /\b(lip[_-]?sync|talking[_-]?avatar|digital[_-]?human)\b/i.test(normalized)) {
      return 'avatar';
    }
    if (/\bmotion\s*control\b/i.test(normalized) || /\b(pose[_-]?tracking|trajectory|camera[_-]?motion|motion[_-]?brush)\b/i.test(normalized)) {
      return 'motion-control';
    }
    return '';
  }

  function extractModelLabelFromTelemetry(text) {
    return pickFirstTextMatch(text, /\b(video\s*\d+(?:\.\d+)?\s*(?:turbo|master|pro)?)/i)
      || pickFirstTextMatch(text, /\b(image\s*\d+(?:\.\d+)?(?:\s*[a-z][a-z0-9-]*)?)/i)
      || pickFirstTextMatch(text, /\b(motion\s*control\s*(?:turbo|master|pro)?)/i)
      || pickFirstTextMatch(text, /\b(avatar\s*(?:basic|pro|realistic)?)/i);
  }

  function normalizeDurationLabel(value, text = '') {
    const raw = `${value || ''}`.trim();
    if (/^\d+\s*s$/i.test(raw)) return raw.replace(/\s+/g, '');
    if (/^\d+$/.test(raw)) return `${raw}s`;
    return pickFirstTextMatch(text, /\b(\d+\s*s)\b/i).replace(/\s+/g, '');
  }

  function normalizeResolutionLabel(value, text = '') {
    const raw = `${value || ''}`.trim();
    if (/^(360p|540p|720p|1080p|2k|4k)$/i.test(raw)) return raw;
    return pickFirstTextMatch(text, /\b(360p|540p|720p|1080p|2k|4k)\b/i);
  }

  function extractOutputCountFromTelemetry(text) {
    const match = `${text || ''}`.match(/\b(?:360p|540p|720p|1080p|2k|4k)\b\s*[·|/,-]\s*\d+\s*s\s*[·|/,-]\s*(\d+)\b/i)
      || `${text || ''}`.match(/\bnumber\s+of\s+outputs?\s*(\d+)\b/i)
      || `${text || ''}`.match(/\boutputs?\s*[:=-]?\s*(\d+)\b/i);
    const parsed = Number(match?.[1]);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
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

  function normalizeLifecycleStatus(value, creditsUsed) {
    const normalized = `${value || ''}`.trim().toLowerCase();
    if (/(fail|error|cancel|reject)/.test(normalized)) return 'failed';
    if (/(complete|success|finish|done|settle)/.test(normalized)) return 'settled';
    if (creditsUsed != null) return 'settled';
    if (/(process|running|render|start|progress)/.test(normalized)) return 'processing';
    if (/(queue|wait|pending)/.test(normalized)) return 'queued';
    if (/(submit|create|init|received)/.test(normalized)) return 'submitted';
    return normalized || '';
  }

  function extractTelemetry(payload) {
    const responseJson = payload.responseJson;
    const requestJson = payload.requestJson;
    const merged = isObject(responseJson) ? responseJson : {};
    const requestObject = isObject(requestJson) ? requestJson : {};
    const responseText = payload.responseText || '';
    const requestText = payload.requestText || '';

    const telemetryText = `${requestText}\n${responseText}`;
    const generationId = pickString(merged, /^(generation_?id|generate_?id|task_?id|job_?id)$/i)
      || pickString(requestObject, /^(generation_?id|generate_?id|task_?id|job_?id)$/i)
      || pickContextualId(merged)
      || pickContextualId(requestObject);
    const requestId = pickString(merged, /^(request_?id|trace_?id|log_?id|req_?id|x_?request_?id)$/i)
      || pickString(requestObject, /^(request_?id|trace_?id|req_?id|x_?request_?id)$/i);
    const creditsUsed = pickCreditValue(
      merged,
      /^(credits?_?used|credit_?used|consume_?credits?|consumed_?credits?|cost_?credits?|credit_?cost|actual_?credits?|credits?_?burned|burned_?credits?)$/i
    );
    const expectedCredits = pickCreditValue(
      requestObject,
      /^(expected_?credits?|credits?_?cost|credit_?cost|consume_?credits?|cost|credit|credits?)$/i
    ) || normalizeCreditValue(pickFirstTextMatch(telemetryText, /\b(\d+)\s*credits?\b/i));
    const rawGenerationMode = pickString(merged, /^(mode|generation_?mode|task_?type|scenario|type)$/i)
      || pickString(requestObject, /^(mode|generation_?mode|task_?type|scenario|type)$/i)
      || inferGenerationModeFromTelemetry(telemetryText);
    const generationMode = inferGenerationModeFromTelemetry(rawGenerationMode) || rawGenerationMode;
    const modelLabel = pickString(merged, /^(model|model_?name|model_?label|model_?version|model_?type|scene)$/i)
      || pickString(requestObject, /^(model|model_?name|model_?label|model_?version|model_?type|scene)$/i)
      || extractModelLabelFromTelemetry(telemetryText);
    const rawDurationLabel = pickString(merged, /^(duration|duration_?label|video_?duration|seconds|second|duration_?seconds)$/i)
      || pickString(requestObject, /^(duration|duration_?label|video_?duration|seconds|second|duration_?seconds)$/i);
    const rawResolutionLabel = pickString(merged, /^(resolution|resolution_?label|quality|video_?quality)$/i)
      || pickString(requestObject, /^(resolution|resolution_?label|quality|video_?quality)$/i);
    const durationLabel = normalizeDurationLabel(rawDurationLabel, telemetryText);
    const resolutionLabel = normalizeResolutionLabel(rawResolutionLabel, telemetryText);
    const outputCount = pickNumber(requestObject, /^(output_?count|outputs?|n|num|count)$/i, { excludeMatcher: /^(balance|current|remaining|remain|total|available|obtained|purchase|quota|limit|package|price|pricing|wallet)$/i })
      || extractOutputCountFromTelemetry(telemetryText);
    const nativeAudioEnabled = /\bnative\s+audio\b/i.test(telemetryText)
      || Boolean(pickString(requestObject, /^(native_?audio|audio_?native|with_?audio)$/i));
    const multiShotEnabled = /\bmulti-?shot\b/i.test(telemetryText)
      || Boolean(pickString(requestObject, /^(multi_?shot|multi_?image)$/i));
    const promptText = pickString(requestObject, /^(prompt|text|query|positive_?prompt)$/i);
    const mediaAssets = collectMediaAssetsFromPayload(merged, responseText);
    const status = normalizeLifecycleStatus(
      pickString(merged, /^(status|state|task_?status|stage|phase|event|event_?type)$/i),
      creditsUsed
    );
    const isCompleted = status === 'settled';
    const isCreditBurnReasonable = creditsUsed != null;

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
      generationMode,
      modelLabel,
      durationLabel,
      resolutionLabel,
      outputCount,
      nativeAudioEnabled,
      multiShotEnabled,
      promptText,
      mediaAssets,
      status,
      isCompleted,
      isCreditBurnReasonable,
    };
  }

  function postTelemetry(payload) {
    try {
      if (!payload.forceInspect && !shouldInspect(payload.url, payload.requestText)) return;
      const extracted = extractTelemetry(payload);
      const hasRecentGenerateIntent = Date.now() <= recentGenerateIntentUntil;
      const hasCorrelatableSignal = Boolean(
        extracted.generationId
        || extracted.requestId
        || (hasRecentGenerateIntent && (
          extracted.isCreditBurnReasonable
          || extracted.expectedCredits
          || extracted.isCompleted
          || extracted.mediaAssets?.length
          || extracted.promptText
        ))
      );
      if (!hasCorrelatableSignal) return;
      if (!extracted.status && !extracted.isCompleted && !extracted.isCreditBurnReasonable) return;

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
          transport: payload.transport || payload.source,
          schemaVersion: 1,
          capturedAt: Date.now(),
          mediaAssets: extracted.mediaAssets,
          requestPreview: limitText(payload.requestText, 1500),
          responsePreview: limitText(payload.responseText, 3000),
        },
      }, location.origin);
    } catch {}
  }

  function postWalletTelemetry(payload) {
    try {
      if (!URL_RE.test(payload.url) || !WALLET_URL_RE.test(payload.url)) return;
      if (Date.now() > recentGenerateIntentUntil) return;
      const balance = pickWalletBalance(payload.responseJson);
      if (balance == null) return;
      window.postMessage({
        source: SOURCE,
        type: 'KLING_WALLET_BALANCE',
        payload: {
          balance,
          method: payload.method,
          url: payload.url,
          ok: payload.ok,
          httpStatus: payload.httpStatus,
          source: payload.source,
          transport: payload.transport || payload.source,
          schemaVersion: 1,
          capturedAt: Date.now(),
        },
      }, location.origin);
    } catch {}
  }

  window.addEventListener('message', (event) => {
    try {
      if (event?.source !== window) return;
      if (event?.origin !== location.origin) return;
      if (event?.data?.source !== 'rmw-kling-content-telemetry') return;
      if (event?.data?.type !== 'KLING_GENERATE_INTENT') return;
      recentGenerateIntentUntil = Math.max(recentGenerateIntentUntil, Date.now() + GENERATE_INTENT_WINDOW_MS);
    } catch {}
  }, false);

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
          postWalletTelemetry({
            source: 'wallet_fetch_response',
            method,
            url,
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
          postWalletTelemetry({
            source: 'wallet_xhr_response',
            method: this.__rmwKlingMethod || 'GET',
            url: this.__rmwKlingUrl || '',
            responseJson: parseJson(responseText),
            ok: this.status >= 200 && this.status < 400,
            httpStatus: this.status,
          });
        } catch {}
      });
      return originalSend.apply(this, arguments);
    };
  }

  function shouldInspectLiveMessage(url, messageText) {
    if (!URL_RE.test(url)) return false;
    if (!messageText || messageText.length > MAX_TEXT_LENGTH) return false;
    const haystack = `${url}\n${messageText}`;
    return /(generation|generate|task|job|work|status|state|credit|consume|cost|settle|complete|queue|process)/i.test(haystack);
  }

  function postLiveTelemetry({ source, url, messageText, ok = true }) {
    try {
      const responseText = limitText(messageText);
      if (!shouldInspectLiveMessage(url, responseText)) return;
      postTelemetry({
        source,
        transport: source,
        method: source === 'eventsource_message' ? 'SSE' : 'WS',
        url,
        requestText: '',
        requestJson: null,
        responseText,
        responseJson: parseJson(responseText),
        ok,
        httpStatus: null,
        forceInspect: true,
      });
    } catch {}
  }

  const OriginalWebSocket = window.WebSocket;
  if (typeof OriginalWebSocket === 'function') {
    window.WebSocket = function rmwKlingWebSocket(url, protocols) {
      const socket = protocols === undefined
        ? new OriginalWebSocket(url)
        : new OriginalWebSocket(url, protocols);
      const normalizedUrl = normalizeUrl(url);

      try {
        socket.addEventListener('message', (event) => {
          if (typeof event?.data !== 'string') return;
          postLiveTelemetry({
            source: 'websocket_message',
            url: normalizedUrl,
            messageText: event.data,
            ok: socket.readyState === OriginalWebSocket.OPEN,
          });
        });
      } catch {}

      return socket;
    };
    window.WebSocket.prototype = OriginalWebSocket.prototype;
    Object.defineProperty(window.WebSocket, 'OPEN', { value: OriginalWebSocket.OPEN });
    Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OriginalWebSocket.CONNECTING });
    Object.defineProperty(window.WebSocket, 'CLOSING', { value: OriginalWebSocket.CLOSING });
    Object.defineProperty(window.WebSocket, 'CLOSED', { value: OriginalWebSocket.CLOSED });
  }

  const OriginalEventSource = window.EventSource;
  if (typeof OriginalEventSource === 'function') {
    window.EventSource = function rmwKlingEventSource(url, eventSourceInitDict) {
      const eventSource = new OriginalEventSource(url, eventSourceInitDict);
      const normalizedUrl = normalizeUrl(url);
      try {
        eventSource.addEventListener('message', (event) => {
          postLiveTelemetry({
            source: 'eventsource_message',
            url: normalizedUrl,
            messageText: event?.data || '',
            ok: eventSource.readyState !== OriginalEventSource.CLOSED,
          });
        });
      } catch {}
      return eventSource;
    };
    window.EventSource.prototype = OriginalEventSource.prototype;
    Object.defineProperty(window.EventSource, 'CONNECTING', { value: OriginalEventSource.CONNECTING });
    Object.defineProperty(window.EventSource, 'OPEN', { value: OriginalEventSource.OPEN });
    Object.defineProperty(window.EventSource, 'CLOSED', { value: OriginalEventSource.CLOSED });
  }
})();
