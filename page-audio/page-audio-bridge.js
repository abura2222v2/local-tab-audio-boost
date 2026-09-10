// Isolated-world bridge between the service worker and the MAIN-world page
// audio controller.
//
// Injected as a packaged classic script by chrome.scripting.executeScript,
// only after an explicit user action. It runs in the extension's isolated
// world, so it can use chrome.runtime - but it deliberately holds no state and
// makes no decisions. It only relays a fixed, validated command vocabulary to
// the MAIN world and returns the controller's structured reply.
//
// Trust direction matters here: the service worker is the sole authority. This
// bridge never accepts a pageKey, tabId, URL, or permission decision from the
// page, never touches chrome.storage, and never exposes any privileged Chrome
// API to page code. The DOM event channel and MAIN world are visible to page
// scripts, so replies remain untrusted and are shape-validated by the service
// worker before they affect its derived session state.

(() => {
  'use strict';

  const BRIDGE_GLOBAL = '__localTabAudioBoostBridgeInstalled';
  const COMMAND_EVENT = 'ltab-page-audio-command';
  const RESULT_EVENT = 'ltab-page-audio-result';
  const RESPONSE_TIMEOUT_MS = 1500;

  const ALLOWED_COMMANDS = new Set(['INSTALL', 'SET_GAIN', 'QUERY_STATE', 'RESET_TO_NEUTRAL', 'DISPOSE_OBSERVERS']);

  // Re-injection must not stack a second onMessage listener on this document.
  if (window[BRIDGE_GLOBAL]) return;
  window[BRIDGE_GLOBAL] = true;

  let nextRequestId = 0;

  /**
   * Sends one command into the MAIN world and resolves with its reply. Always
   * settles: a page that never answers (or has no controller installed yet)
   * resolves as a structured failure instead of hanging the service worker.
   */
  function sendToMainWorld(command) {
    return new Promise((resolve) => {
      const requestId = `ltab-${Date.now()}-${(nextRequestId += 1)}`;
      let settled = false;

      const onResult = (event) => {
        const detail = event && event.detail;
        if (!detail || detail.requestId !== requestId) return;
        finish(detail.payload);
      };

      const timer = setTimeout(() => finish({ ok: false, reason: 'NO_CONTROLLER_RESPONSE' }), RESPONSE_TIMEOUT_MS);

      function finish(payload) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        document.removeEventListener(RESULT_EVENT, onResult);
        resolve(payload);
      }

      document.addEventListener(RESULT_EVENT, onResult);
      try {
        document.dispatchEvent(new CustomEvent(COMMAND_EVENT, { detail: { requestId, command } }));
      } catch (err) {
        finish({ ok: false, reason: 'DISPATCH_FAILED' });
      }
    });
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // Only the extension's own page-audio commands are handled here; anything
    // else is left for other listeners.
    if (!message || message.target !== 'page-audio' || !message.command) return undefined;

    // A message must come from this extension itself.
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ ok: false, reason: 'UNTRUSTED_SENDER' });
      return true;
    }

    const command = message.command;
    if (!ALLOWED_COMMANDS.has(command.type) || typeof command.operationToken !== 'string' || !command.operationToken) {
      sendResponse({ ok: false, reason: 'INVALID_COMMAND' });
      return true;
    }

    sendToMainWorld(command).then((payload) => {
      sendResponse(payload && payload.rejected ? { ok: false, ...payload } : { ok: true, data: payload });
    });
    return true;
  });
})();
