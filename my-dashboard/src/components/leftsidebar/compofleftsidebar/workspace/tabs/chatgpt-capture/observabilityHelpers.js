// Pure derivations for the Developer Console. No React, no API - everything
// is computed from the events / media the UI already loaded.

const ms = (v) => (v ? new Date(v).getTime() : NaN);
const firstOf = (events, type) => events.find((e) => e.eventType === type) || null;

// Capture pipeline stages, derived from event presence + media state.
export function derivePipeline(events = [], media = []) {
  const sorted = [...events].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const prompt = firstOf(sorted, 'prompt_captured');
  const started = firstOf(sorted, 'response_started');
  const completed = firstOf(sorted, 'response_completed');
  const mediaSorted = [...media].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const detected = mediaSorted[0] || null;
  const stored = mediaSorted.find((m) => m.status === 'stored') || null;

  const raw = [
    { key: 'prompt', label: 'Prompt sent', at: prompt?.createdAt },
    { key: 'started', label: 'Response started', at: started?.createdAt },
    { key: 'completed', label: 'Response completed', at: completed?.createdAt },
    { key: 'detected', label: 'Media detected', at: detected?.createdAt, optional: true },
    { key: 'stored', label: 'Media stored', at: stored?.createdAt, optional: true },
  ];

  let prevAt = null;
  return raw
    .filter((s) => s.at || !s.optional)
    .map((s) => {
      const done = Boolean(s.at);
      const durationMs = done && prevAt ? ms(s.at) - prevAt : null;
      if (done) prevAt = ms(s.at);
      return { ...s, done, durationMs };
    });
}

export function deriveMetrics(events = [], media = []) {
  const sorted = [...events].sort((a, b) => ms(a.createdAt) - ms(b.createdAt));
  const prompt = firstOf(sorted, 'prompt_captured');
  const started = firstOf(sorted, 'response_started');
  const completed = firstOf(sorted, 'response_completed');
  const startLatency = prompt && started ? ms(started.createdAt) - ms(prompt.createdAt) : null;
  const completionTime = started && completed ? ms(completed.createdAt) - ms(started.createdAt) : null;
  const totalDuration = sorted.length >= 2 ? ms(sorted[sorted.length - 1].createdAt) - ms(sorted[0].createdAt) : null;
  return {
    startLatency,
    completionTime,
    totalDuration,
    eventCount: events.length,
    mediaCount: media.length,
    storedCount: media.filter((m) => m.status === 'stored').length,
  };
}

// Event category for the explorer filter. Kept intentionally coarse.
export function categorizeEvent(event) {
  const type = event.eventType || '';
  const payload = event.payload || {};
  if (payload.error || payload.stopReason === 'error') return 'errors';
  if (type.startsWith('conversation_')) return 'network';
  if (['prompt_captured', 'response_started', 'response_completed', 'message_edited'].includes(type)) return 'sse';
  if (['generation_captured', 'file_upload_detected', 'file_download_detected'].includes(type)) return 'media';
  return 'other';
}

export function deriveErrors(events = [], media = []) {
  const out = [];
  media.filter((m) => m.status === 'failed').forEach((m) => {
    out.push({ tone: 'error', label: 'Media capture failed', timestamp: m.createdAt, detail: `${m.mediaType || 'media'} #${m.id} (source: ${m.source || 'unknown'})` });
  });
  events.filter((e) => (e.payload || {}).error || (e.payload || {}).stopReason === 'error').forEach((e) => {
    out.push({ tone: 'error', label: `Error in ${e.eventType}`, timestamp: e.createdAt, detail: `${(e.payload || {}).error || 'stopReason: error'}` });
  });
  const prompts = events.filter((e) => e.eventType === 'prompt_captured').length;
  const responses = events.filter((e) => e.eventType === 'response_completed').length;
  if (prompts > responses) {
    out.push({ tone: 'warning', label: 'Unanswered prompts', timestamp: null, detail: `${prompts - responses} prompt(s) with no captured response` });
  }
  return out;
}

// Aggregate media pipeline diagnostics + per-asset detail.
export function deriveMediaDiagnostics(media = []) {
  const confidences = media
    .map((m) => Number(m.metadata?.confidence))
    .filter((n) => Number.isFinite(n));
  const avgConfidence = confidences.length
    ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100)
    : null;
  return {
    total: media.length,
    domDetected: media.some((m) => m.source === 'dom_capture' || m.metadata?.detection === 'dom'),
    networkDetected: media.some((m) => m.source === 'network_capture' || m.metadata?.detection === 'network'),
    stored: media.some((m) => m.status === 'stored'),
    avgConfidence,
    assets: media.map((m) => ({
      id: m.id,
      mediaType: m.mediaType,
      source: m.source || m.metadata?.detection || 'unknown',
      status: m.status,
      enrichmentStatus: m.enrichmentStatus,
      confidence: Number.isFinite(Number(m.metadata?.confidence)) ? Math.round(Number(m.metadata.confidence) * 100) : null,
    })),
  };
}
