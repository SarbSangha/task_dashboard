const VIDEO_EXTENSIONS = ['mp4', 'mov', 'webm', 'mkv', 'avi'];
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];

export function getGenerationMediaKind(generation) {
  const url = `${generation?.canonicalAssetUrl || ''}`.toLowerCase().split('?')[0];
  const extension = url.includes('.') ? url.split('.').pop() : '';
  if (VIDEO_EXTENSIONS.includes(extension)) return 'video';
  if (IMAGE_EXTENSIONS.includes(extension)) return 'image';
  if (generation?.durationLabel) return 'video';
  if (generation?.canonicalAssetUrl) return 'image';
  return 'unknown';
}

export function truncateText(text, maxLength = 140) {
  const value = `${text || ''}`.trim();
  if (!value) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 1).trim()}…`;
}

export function formatGenerationDate(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}
