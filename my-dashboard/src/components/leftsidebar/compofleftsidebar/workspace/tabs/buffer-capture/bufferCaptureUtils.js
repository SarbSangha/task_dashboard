// Small self-contained util set for the Buffer tab - mirrors the shape of
// envatoCaptureUtils.js/sunoCaptureUtils.js (each capture tab keeps its own
// rather than reaching into another tab's module), but Buffer's item shape
// is far simpler (see backend/utils/buffer_feed.py's BufferFeedItem), so
// this file only needs what that shape actually has.

export const MEDIA_TYPE_META = {
  image: { key: 'image', label: 'Image', icon: '🖼️' },
  video: { key: 'video', label: 'Video', icon: '🎬' },
  audio: { key: 'audio', label: 'Audio', icon: '🎵' },
  other: { key: 'other', label: 'Other', icon: '📄' },
};

export function getMediaTypeMeta(mediaType) {
  return MEDIA_TYPE_META[mediaType] || MEDIA_TYPE_META.other;
}

const KIND_META = {
  generation: { label: 'Generated', icon: '✨' },
  download: { label: 'Downloaded', icon: '⬇️' },
  upload: { label: 'Self Upload', icon: '📤' },
};

export function getKindMeta(kind) {
  return KIND_META[kind] || { label: kind || 'Item', icon: '•' };
}

export function truncate(value, maxLength = 90) {
  const text = `${value || ''}`.trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatRelativeTime(isoString) {
  if (!isoString) return 'Unknown time';
  const then = new Date(isoString).getTime();
  if (Number.isNaN(then)) return 'Unknown time';

  const diffMs = Date.now() - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'Just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(isoString).toLocaleDateString();
}

export function providerLabel(provider) {
  const key = `${provider || ''}`.trim().toLowerCase();
  const overrides = {
    'epidemic-sound': 'Epidemic Sound',
    elevenlabs: 'ElevenLabs',
    heygen: 'HeyGen',
    'kling-ai': 'Kling',
    'self-upload': 'Self Upload',
  };
  if (overrides[key]) return overrides[key];
  if (!key) return 'Unknown tool';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

export function normalizeApiError(error, fallback = 'Something went wrong.') {
  return error?.response?.data?.detail || error?.message || fallback;
}
