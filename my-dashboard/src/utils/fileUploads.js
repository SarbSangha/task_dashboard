export const getFileRelativePath = (item) => {
  const rawPath = item?.webkitRelativePath || item?.relativePath || '';
  const normalizedPath = `${rawPath}`.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  return normalizedPath || '';
};

export const getAttachmentDisplayName = (item) =>
  getFileRelativePath(item)
  || item?.originalName
  || item?.filename
  || item?.name
  || 'Attachment';

const buildAttachmentKey = (item) => {
  if (!item) return '';

  const typeTag = typeof File !== 'undefined' && item instanceof File ? 'file' : 'meta';
  return [
    typeTag,
    getFileRelativePath(item) || item?.path || item?.url || item?.originalName || item?.filename || item?.name || '',
    item?.size || '',
    item?.lastModified || '',
    item?.type || item?.mimetype || '',
  ].join('::');
};

export const mergeUniqueAttachments = (existing = [], incoming = []) => {
  const merged = [];
  const seen = new Set();

  [...existing, ...incoming].forEach((item) => {
    if (!item) return;
    const key = buildAttachmentKey(item);
    if (seen.has(key)) return;
    seen.add(key);
    merged.push(item);
  });

  return merged;
};

export const buildUploadFormData = (files = []) => {
  const formData = new FormData();

  files.forEach((file) => {
    if (!(typeof File !== 'undefined' && file instanceof File)) return;

    formData.append('files', file, file.name);
    formData.append('relative_paths', getFileRelativePath(file));
  });

  return formData;
};

export const openSystemFilePicker = ({ mode = 'files', multiple = true, onSelect } = {}) => {
  if (typeof document === 'undefined') return;

  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = multiple;
  input.style.position = 'fixed';
  input.style.left = '-9999px';
  input.style.top = '-9999px';

  const isFolderMode = mode === 'folder';
  const toggleAttribute = (name) => {
    if (isFolderMode) {
      input.setAttribute(name, '');
    } else {
      input.removeAttribute(name);
    }
  };

  toggleAttribute('webkitdirectory');
  toggleAttribute('directory');
  toggleAttribute('mozdirectory');

  if ('webkitdirectory' in input) {
    input.webkitdirectory = isFolderMode;
  }

  const cleanup = () => {
    window.removeEventListener('focus', handleWindowFocus);
    if (input.parentNode) {
      input.parentNode.removeChild(input);
    }
  };

  const handleWindowFocus = () => {
    window.setTimeout(cleanup, 250);
  };

  input.addEventListener(
    'change',
    (event) => {
      const selected = Array.from(event.target.files || []);
      if (selected.length > 0 && typeof onSelect === 'function') {
        onSelect(selected);
      }
      cleanup();
    },
    { once: true }
  );

  window.addEventListener('focus', handleWindowFocus, { once: true });
  document.body.appendChild(input);
  input.click();
};
