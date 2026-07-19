// Shared, dependency-free helpers for the generation workspace (timeline /
// gallery / prompt views). Pure functions only - no React, no API. Every
// field read here is an existing media/message field; nothing is renamed.

export function isVideo(asset) {
  return `${asset?.mediaType || ''}`.includes('video') || `${asset?.mimeType || ''}`.startsWith('video/');
}

export function displayName(asset) {
  const prompt = `${asset?.prompt || ''}`.trim();
  if (prompt) return prompt.length > 60 ? `${prompt.slice(0, 60)}…` : prompt;
  return `${asset?.mediaType || 'media'}_${asset?.id}`;
}

export function typeLabel(asset) {
  return `${asset?.mediaType || 'media'}`.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatLabel(asset) {
  const mime = `${asset?.mimeType || ''}`;
  if (mime.includes('/')) return mime.split('/')[1].toUpperCase();
  return isVideo(asset) ? 'VIDEO' : 'IMAGE';
}

// Adapts a media asset to the {url, mimetype, originalName} shape the shared
// fileLinks builders / FilePreviewModal expect. The raw (private) R2 `url` is
// routed through /api/files/* (signed redirect) - same mechanism the rest of
// the app uses.
export function toFile(asset) {
  return {
    url: asset?.url,
    mimetype: asset?.mimeType || (isVideo(asset) ? 'video/mp4' : 'image/jpeg'),
    originalName: displayName(asset),
    filename: displayName(asset),
  };
}

export function generationType(media) {
  const hasVideo = media.some(isVideo);
  const hasImage = media.some((m) => !isVideo(m));
  if (hasVideo && hasImage) return { icon: '🎬', label: 'Media Generation' };
  if (hasVideo) return { icon: '🎬', label: 'Video Generation' };
  return { icon: '🎨', label: 'Image Generation' };
}

// Generation lifecycle rolled up from the per-asset `status` field.
export function generationStatus(media) {
  const failed = media.filter((m) => m.status === 'failed').length;
  const pending = media.filter((m) => m.status === 'pending').length;
  const stored = media.filter((m) => m.status === 'stored').length;
  if (failed && stored) return { tone: 'warning', icon: '🟠', label: 'Partial' };
  if (failed) return { tone: 'error', icon: '🔴', label: 'Failed' };
  if (pending) return { tone: 'warning', icon: '🟡', label: 'Processing' };
  return { tone: 'success', icon: '🟢', label: 'Completed' };
}

// Lightweight, dependency-free keyword extraction - a stopword-filtered
// frequency pick, NOT an AI score (that's the future AI intelligence layer).
const KEYWORD_STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'in', 'on', 'and', 'or', 'to', 'for', 'with', 'me', 'my', 'is', 'are',
  'be', 'at', 'as', 'it', 'this', 'that', 'please', 'can', 'you', 'i', 'want', 'need', 'show',
  'generate', 'create', 'make', 'give', 'draw', 'fetch', 'image', 'images', 'picture', 'pictures',
  'pic', 'pics', 'photo', 'photos', 'video', 'videos', 'realistic', 'some', 'few',
]);
export function extractKeywords(text, max = 5) {
  if (!text) return [];
  const words = `${text}`.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !KEYWORD_STOPWORDS.has(w));
  const freq = new Map();
  const order = [];
  for (const w of words) {
    if (!freq.has(w)) order.push(w);
    freq.set(w, (freq.get(w) || 0) + 1);
  }
  return order.sort((a, b) => freq.get(b) - freq.get(a)).slice(0, max);
}

// Client-side filters. Predicates read only existing fields.
export const MEDIA_FILTERS = [
  { key: 'all', label: 'All', predicate: () => true },
  { key: 'images', label: 'Images', predicate: (m) => !isVideo(m) },
  { key: 'videos', label: 'Videos', predicate: (m) => isVideo(m) },
  { key: 'generated', label: 'Generated', predicate: (m) => Boolean(m.generated) || `${m.mediaType || ''}`.startsWith('generated') },
  { key: 'fetched', label: 'Fetched', predicate: (m) => !m.generated && `${m.mediaType || ''}`.startsWith('response') },
  { key: 'stored', label: 'Successful', predicate: (m) => m.status === 'stored' },
  { key: 'failed', label: 'Failed', predicate: (m) => m.status === 'failed' },
];

// Pairs media to the assistant response with the NEAREST timestamp (the only
// frontend-available signal - the message API exposes no provider_message_id/
// correlation_id, and media ids are ChatGPT-provider ids that can't match the
// synthetic message ids). Best-effort: unpairable media goes into an explicit
// "Ungrouped" generation rather than being hidden. Generations are numbered
// chronologically (oldest = #1) and returned newest-first for display.
export function buildGenerations(messages, mediaAssets) {
  const chat = (messages || [])
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice()
    .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));

  const turns = [];
  let current = null;
  for (const m of chat) {
    if (m.role === 'user') {
      if (current) turns.push(current);
      current = { promptText: m.text || '', promptTime: m.timestamp, responseText: '', responseTime: null, model: m.model };
    } else {
      if (!current) current = { promptText: '', promptTime: m.timestamp, responseText: '', responseTime: null, model: m.model };
      if (!current.responseTime) {
        current.responseText = m.text || '';
        current.responseTime = m.timestamp;
        current.model = m.model || current.model;
      } else {
        current.responseTime = m.timestamp;
      }
    }
  }
  if (current) turns.push(current);
  turns.forEach((t, i) => {
    t.index = i;
    t.anchorMs = new Date(t.responseTime || t.promptTime || 0).getTime();
  });

  const nearestTurn = (ms) => {
    let best = null;
    let bestDiff = Infinity;
    for (const t of turns) {
      const diff = Math.abs(t.anchorMs - ms);
      if (diff < bestDiff) { bestDiff = diff; best = t; }
    }
    return best;
  };

  const byTurn = new Map();
  const ungrouped = [];
  for (const asset of mediaAssets) {
    const turn = turns.length ? nearestTurn(new Date(asset.createdAt || 0).getTime()) : null;
    if (turn) {
      if (!byTurn.has(turn.index)) byTurn.set(turn.index, []);
      byTurn.get(turn.index).push(asset);
    } else {
      ungrouped.push(asset);
    }
  }

  const sortMedia = (arr) => arr.slice().sort(
    (a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
  );

  // Chronological generation numbers (oldest = #1), then display newest-first.
  const chronological = turns.filter((t) => byTurn.has(t.index));
  const generations = chronological.map((t, i) => ({
    ...t,
    number: i + 1,
    media: sortMedia(byTurn.get(t.index)),
  }));
  generations.sort((a, b) => b.anchorMs - a.anchorMs);
  if (ungrouped.length) {
    generations.push({ index: -1, number: null, ungrouped: true, promptText: '', responseText: '', responseTime: null, anchorMs: 0, media: sortMedia(ungrouped) });
  }
  return generations;
}
