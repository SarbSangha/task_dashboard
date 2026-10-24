// src/utils/driveResumableUpload.js
// Sends one file straight from the browser to a Google Drive resumable
// upload session (the URL comes from POST /api/ai-library/uploads - see
// backend/routers/ai_library_router.py). The bytes never touch our server.
//
// Protocol (https://developers.google.com/drive/api/guides/manage-uploads#resumable):
// - PUT each chunk with `Content-Range: bytes <first>-<last>/<total>`.
//   Every chunk but the last must be a multiple of 256 KiB.
// - 308 = "keep going"; its Range header says how much Drive has.
// - 200/201 on the last chunk carries the created file's JSON.
// - After a dropped connection, PUT an empty body with
//   `Content-Range: bytes */<total>` to ask Drive how much it has, and
//   continue from there instead of from zero.
//
// XMLHttpRequest rather than fetch: fetch has no upload progress events.

const MAX_RETRIES = 6;
const BASE_BACKOFF_MS = 1000;

export class UploadCancelledError extends Error {
  constructor() {
    super('Upload cancelled');
    this.name = 'UploadCancelledError';
  }
}

export class UploadSessionExpiredError extends Error {
  constructor() {
    super('The upload link expired. Retry to start the file again.');
    this.name = 'UploadSessionExpiredError';
  }
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const onAbort = () => { clearTimeout(timer); reject(new UploadCancelledError()); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  signal.addEventListener('abort', onAbort, { once: true });
});

// "bytes=0-8388607" -> 8388608 (the next byte Drive expects).
const nextOffsetFromRange = (header) => {
  const match = /bytes=\d+-(\d+)/.exec(header || '');
  return match ? Number(match[1]) + 1 : null;
};

function put(url, body, contentRange, signal, onUploadProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Range', contentRange);
    if (onUploadProgress) xhr.upload.onprogress = (e) => onUploadProgress(e.loaded);
    xhr.onload = () => resolve({
      status: xhr.status,
      range: xhr.getResponseHeader('Range'),
      text: xhr.responseText,
    });
    // status 0: network drop, offline, or the request was blocked.
    xhr.onerror = () => resolve({ status: 0 });
    xhr.ontimeout = () => resolve({ status: 0 });
    const abort = () => { xhr.abort(); reject(new UploadCancelledError()); };
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    xhr.onloadend = () => signal.removeEventListener('abort', abort);
    xhr.send(body);
  });
}

const parseFile = (text) => {
  try { return JSON.parse(text || '{}'); } catch { return {}; }
};

/**
 * Upload `file` to `uploadUrl`.
 *
 * @returns {{ promise: Promise<object>, cancel: () => void }}
 *   `promise` resolves with Drive's file JSON ({ id, name, size, ... }).
 */
export function startDriveUpload({ file, uploadUrl, chunkSize, onProgress }) {
  const controller = new AbortController();
  const { signal } = controller;
  const total = file.size;

  const report = (bytes) => onProgress?.(Math.min(bytes, total), total);

  // How much Drive already has. Returns the finished file instead when the
  // last chunk actually landed before the connection dropped.
  const queryOffset = async () => {
    const res = await put(uploadUrl, null, `bytes */${total}`, signal);
    if (res.status === 200 || res.status === 201) return { done: parseFile(res.text) };
    if (res.status === 308) return { offset: nextOffsetFromRange(res.range) ?? 0 };
    if (res.status === 404 || res.status === 410) throw new UploadSessionExpiredError();
    return { offset: null, status: res.status };
  };

  const run = async () => {
    if (total === 0) {
      const res = await put(uploadUrl, null, 'bytes */0', signal);
      if (res.status === 200 || res.status === 201) return parseFile(res.text);
      throw new Error(`Google Drive refused the upload (HTTP ${res.status}).`);
    }

    let offset = 0;
    let retries = 0;
    report(0);

    while (offset < total) {
      const end = Math.min(offset + chunkSize, total);
      const res = await put(
        uploadUrl,
        file.slice(offset, end),
        `bytes ${offset}-${end - 1}/${total}`,
        signal,
        (loaded) => report(offset + loaded),
      );

      if (res.status === 200 || res.status === 201) {
        report(total);
        return parseFile(res.text);
      }
      if (res.status === 308) {
        offset = nextOffsetFromRange(res.range) ?? end;
        retries = 0;
        report(offset);
        continue;
      }
      if (res.status === 404 || res.status === 410) throw new UploadSessionExpiredError();

      const retryable = res.status === 0 || res.status === 429 || res.status >= 500;
      if (!retryable || retries >= MAX_RETRIES) {
        throw new Error(res.status === 0
          ? 'Connection to Google Drive was lost.'
          : `Google Drive refused the upload (HTTP ${res.status}).`);
      }
      retries += 1;
      await sleep(BASE_BACKOFF_MS * 2 ** (retries - 1), signal);

      const resumed = await queryOffset();
      if (resumed.done) { report(total); return resumed.done; }
      if (resumed.offset !== null) offset = resumed.offset;
      report(offset);
    }
    // Every byte was acknowledged with 308 but no file came back: ask once.
    const final = await queryOffset();
    if (final.done) return final.done;
    throw new Error('Google Drive did not confirm the upload.');
  };

  return { promise: run(), cancel: () => controller.abort() };
}
