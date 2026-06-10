try {
  importScripts('background-main.js');
} catch (error) {
  try {
    console.error('RMW Tool Hub background failed to load:', error);
  } catch (_) {}

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener(function (_message, _sender, sendResponse) {
      sendResponse({
        ok: false,
        error: 'Extension background failed to load: ' + (error && error.message ? error.message : String(error || 'Unknown error')),
      });
      return false;
    });
  }
}
