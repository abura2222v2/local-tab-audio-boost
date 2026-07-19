// Pure, DOM-free controller for the popup slider's live-vs-persisted timing
// on an ALREADY-ACTIVE session. Extracted out of popup.js specifically so
// this timing logic can be unit-tested deterministically under plain Node,
// without a DOM. (The separate inactive-page start / first-slider-value
// orchestration lives in shared/popup-controller.js.)
//
// Rules (see README/plan for the full rationale):
//  - `input` (continuous, fired while dragging) drives live audio only,
//    throttled - it must NEVER schedule or send a persistent storage write,
//    not even after a delay. Pausing mid-drag must not write storage. The
//    throttle is leading + trailing: the first value in a window is sent
//    immediately, and the LATEST value seen during the window is sent again
//    at the window's trailing edge, so the audio always ends up at the most
//    recent value the user dragged to - never stuck at the first one.
//  - `change` (fired once, on pointer release or a discrete keyboard commit)
//    ALWAYS flushes the final value to live audio first (regardless of saved
//    status), then persists. `change` is a discrete once-per-commit event,
//    so its persist needs no debounce.
//  - pagehide/visibilitychange may flush one best-effort final live value
//    (so a still-pending trailing value is never lost) and one best-effort
//    persist, each only if not already sent.
//
// `sendLiveGain`/`persistNow` are called as (value, operationId) - the
// operationId of the session this controller currently believes is current,
// captured internally at the moment of the call rather than read from an
// outer-scope variable the caller might update out of sync. A change of
// operationId (onServerState with a new id) cancels any pending trailing
// callback belonging to the old operation, so a value dragged against a
// superseded session generation is never applied to whichever session is
// current now. Persistence is gated on the page being saved by the CALLER's
// own `persistNow` (an unsaved page's persistNow is a no-op) - this module
// never itself decides saved-vs-unsaved.

export function createGainInputController({ sendLiveGain, persistNow, liveThrottleMs = 80 }) {
  let liveThrottleTimer = null;
  let lastKnownValue = null; // the latest value the user has set (input or change)
  let lastSentLiveValue = null; // the latest value actually pushed to live audio
  let lastPersistedValue = null; // the latest value actually persisted
  let pendingTrailingValue = null; // a value awaiting the throttle window's trailing edge
  let currentOperationId = null;

  function clearThrottleTimer() {
    if (liveThrottleTimer) {
      clearTimeout(liveThrottleTimer);
      liveThrottleTimer = null;
    }
  }

  function sendLive(value) {
    sendLiveGain(value, currentOperationId);
    lastSentLiveValue = value;
  }

  function onThrottleWindowEnd() {
    liveThrottleTimer = null;
    // Trailing edge: if the latest value seen during the window was never
    // sent, send it now so the audio ends up at the most recent value.
    if (pendingTrailingValue !== null && pendingTrailingValue !== lastSentLiveValue) {
      const value = pendingTrailingValue;
      pendingTrailingValue = null;
      sendLive(value);
    } else {
      pendingTrailingValue = null;
    }
  }

  function onInput(value) {
    lastKnownValue = value;
    if (!liveThrottleTimer) {
      // Leading edge: send immediately and open the throttle window.
      sendLive(value);
      liveThrottleTimer = setTimeout(onThrottleWindowEnd, liveThrottleMs);
    } else {
      // Within the window: remember as the trailing value (latest wins).
      pendingTrailingValue = value;
    }
    // Deliberately never persists - pausing mid-drag never writes storage.
  }

  function onChange(value) {
    lastKnownValue = value;
    // ALWAYS flush the final value to live audio first, regardless of saved
    // status, so a released slider's audio is never left at a stale
    // throttled value. Then supersede any pending trailing edge.
    clearThrottleTimer();
    pendingTrailingValue = null;
    if (value !== lastSentLiveValue) {
      sendLive(value);
    }
    // Persist last. persistNow is caller-gated on the page being saved - for
    // an unsaved page it is a no-op, so an unsaved page never writes storage.
    lastPersistedValue = value;
    persistNow(value, currentOperationId);
  }

  /**
   * Called whenever the popup renders a freshly-fetched or broadcast
   * server-confirmed state (initial load, or a TAB_STATE_CHANGED message).
   * Establishes a clean baseline so a later fallback never re-sends a value
   * the server already has. A CHANGE of operationId additionally cancels any
   * pending trailing callback belonging to the old operation - so a value
   * dragged against a since-superseded session generation is never applied
   * to whichever session is current now.
   */
  function onServerState(value, operationId = null) {
    if (operationId !== currentOperationId) {
      clearThrottleTimer();
      pendingTrailingValue = null;
    }
    currentOperationId = operationId;
    lastKnownValue = value;
    lastSentLiveValue = value;
    lastPersistedValue = value;
  }

  /**
   * One best-effort flush on pagehide/visibilitychange: send any still-
   * pending final live value (so it is never lost), then persist if the
   * last value has not already been persisted. Both are caller-gated where
   * relevant (persistNow no-ops for an unsaved page).
   */
  function flushFallback() {
    if (lastKnownValue !== null && lastKnownValue !== lastSentLiveValue) {
      clearThrottleTimer();
      pendingTrailingValue = null;
      sendLive(lastKnownValue);
    }
    if (lastKnownValue !== null && lastKnownValue !== lastPersistedValue) {
      lastPersistedValue = lastKnownValue;
      persistNow(lastKnownValue, currentOperationId);
    }
  }

  return { onInput, onChange, onServerState, flushFallback };
}
