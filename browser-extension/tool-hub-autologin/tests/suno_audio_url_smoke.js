// Verifies the URL selector rejects the live-streaming endpoint.
const fs = require('fs'), vm = require('vm');
const src = fs.readFileSync(require('path').join(__dirname, '..', 'content-suno-capture.js'), 'utf8');
const start = src.indexOf('const SUNO_STREAMING_HOST_RE');
const end = src.indexOf('// ----------------------------------------------------------------------------\n// Live-capture arm/disarm');
const ctx = { location: { href: 'https://suno.com/' }, URL, console, String, Array, Uint8Array };
vm.createContext(ctx);
vm.runInContext(src.slice(start, end), ctx);

const AUDIOPIPE = 'https://audiopipe.suno.ai/?item_id=3807855e-4e72-4a63-bb4b-5b827863b496';
const CDN = 'https://cdn1.suno.ai/197b0278-5b1a-4554-97e4-80204901aa98.mp3';
let fails = 0;
const check = (name, got, want) => {
  const ok = got === want; if (!ok) fails++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}\n        got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
};

check('bare audiopipe audio_url is rejected',
  ctx.getSunoDownloadableAudioUrl({ audio_url: AUDIOPIPE }), '');
check('audiopipe in media_urls is rejected even when labelled mp3',
  ctx.getSunoDownloadableAudioUrl({ media_urls: [{ url: AUDIOPIPE, content_type: 'audio/mpeg' }] }), '');
check('cdn mp3 is accepted', ctx.getSunoDownloadableAudioUrl({ audio_url: CDN }), CDN);
check('cdn mp3 preferred over audiopipe in the same row',
  ctx.getSunoDownloadableAudioUrl({ media_urls: [{ url: AUDIOPIPE, content_type: 'audio/mpeg' }, { url: CDN, content_type: 'audio/mpeg' }] }), CDN);
check('empty row yields empty', ctx.getSunoDownloadableAudioUrl({ audio_url: '' }), '');
check('still-encoding row (audio_url empty) yields empty',
  ctx.getSunoDownloadableAudioUrl({ audio_url: '', media_urls: [] }), '');

// Byte guard mirrors the backend.
const corrupt = Buffer.from('99856e08d8cdefce'.repeat(256), 'hex');
const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
check('real corrupt bytes rejected client-side', ctx.sunoLooksLikeAudioBytes(toAB(corrupt.subarray(0, 4096))), false);
check('ID3 mp3 accepted client-side',
  ctx.sunoLooksLikeAudioBytes(toAB(Buffer.concat([Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00'), Buffer.alloc(32)]))), true);
check('ftyp m4a accepted client-side',
  ctx.sunoLooksLikeAudioBytes(toAB(Buffer.concat([Buffer.from('\x00\x00\x00 ftypM4A '), Buffer.alloc(32)]))), true);

console.log(fails === 0 ? '\nALL PASSED' : `\n${fails} FAILED`);
process.exit(fails ? 1 : 0);
