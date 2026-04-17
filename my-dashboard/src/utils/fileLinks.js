const FILES_API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8000';

function appendFileParams(params, file) {
  if (!file) return;

  if (typeof file === 'string') {
    params.set('url', file);
    return;
  }

  if (file.url) params.set('url', file.url);
  if (file.path) params.set('path', file.path);
}

export function buildFileActionUrl(file, action = 'open', fallbackName) {
  const params = new URLSearchParams();
  appendFileParams(params, file);

  if (!params.toString()) return '';

  if (action === 'download') {
    params.set('filename', fallbackName || file?.originalName || file?.filename || 'download');
  }

  return `${FILES_API_BASE}/api/files/${action}?${params.toString()}`;
}

export function buildFileOpenUrl(file) {
  return buildFileActionUrl(file, 'open');
}

export function buildFileDownloadUrl(file, fallbackName) {
  return buildFileActionUrl(file, 'download', fallbackName);
}

export function getFileDisplayName(file, fallbackName = 'Attachment') {
  if (typeof file === 'string') {
    const cleanValue = file.split('?')[0];
    const parts = cleanValue.split('/').filter(Boolean);
    return parts[parts.length - 1] || fallbackName;
  }

  if (file?.relativePath) {
    const parts = String(file.relativePath).split(/[\\/]/).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }

  return file?.originalName || file?.filename || fallbackName;
}

function getFileExtension(file) {
  const displayName = getFileDisplayName(file, '').toLowerCase();
  const lastDot = displayName.lastIndexOf('.');
  return lastDot >= 0 ? displayName.slice(lastDot + 1) : '';
}

export function getFilePreviewKind(file) {
  const mimeType = `${file?.mimetype || ''}`.toLowerCase();
  const extension = getFileExtension(file);

  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.includes('pdf') || extension === 'pdf') return 'pdf';
  if (
    mimeType.startsWith('text/') ||
    ['txt', 'md', 'json', 'csv', 'html', 'htm', 'svg'].includes(extension)
  ) {
    return 'frame';
  }

  return 'unsupported';
}

export function openUrlInNewTab(url) {
  if (!url || typeof document === 'undefined') return;

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}
