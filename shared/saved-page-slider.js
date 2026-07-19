// Pure, DOM-free controller for ONE saved-pages row slider's live-vs-persist
// timing. Extracted out of options.js specifically so this timing logic can be
// unit-tested deterministically under plain Node, without a DOM. It mirrors
// shared/popup-gain-controller.js's leading + trailing throttle, but scoped by
// exact pageKey (a saved row) instead of by an active session's operationId.
//
// Rules:
//  - `input` (continuous, while dragging) drives LIVE gain only, throttled -
//    it must NEVER schedule or send a persistent storage write, not even
//    after a delay. The throttle is leading + trailing: the first value in a
//    window is sent immediately, and the LATEST value seen during the window
//    is sent again at the window's trailing edge, so the live audio always
//    ends up at the most recent value dragged to - never stuck at the first
//    one, and no final value is ever dropped.
//  - `change` (once, on pointer release / keyboard commit) FLUSHES the latest
//    live value first (so the audio is never left at a stale throttled value),
//    then persists exactly once through the caller's `persist`. `change` is a
//    discrete once-per-commit event, so its persist needs no debounce.
//  - `dispose()` cancels any pending trailing timer - called when the row is
//    re-rendered or the options page is closing, so a stale timer can never
//    fire a live update against a later, unrelated session.
//
// `sendLiveGain(value)` and `persist(value)` are supplied by the caller; this
// module never itself decides which exact pageKey a value belongs to (the
// caller binds that per row) and never writes storage itself.

export function createSavedPageSliderController({ sendLiveGain, persist, liveThrottleMs = 80 }) {
  let liveThrottleTimer = null;
  let lastSentLiveValue = null; // the latest value actually pushed to live audio
  let pendingTrailingValue = null; // a value awaiting the throttle window's trailing edge

  function clearThrottleTimer() {
    if (liveThrottleTimer) {
      clearTimeout(liveThrottleTimer);
      liveThrottleTimer = null;
    }
  }

  function sendLive(value) {
    sendLiveGain(value);
    lastSentLiveValue = value;
  }

  function onThrottleWindowEnd() {
    liveThrottleTimer = null;
    // Trailing edge: if the latest value seen during the window was never
    // sent, send it now so the live audio ends up at the most recent value.
    if (pendingTrailingValue !== null && pendingTrailingValue !== lastSentLiveValue) {
      const value = pendingTrailingValue;
      pendingTrailingValue = null;
      sendLive(value);
    } else {
      pendingTrailingValue = null;
    }
  }

  function onInput(value) {
    if (!liveThrottleTimer) {
      // Leading edge: send immediately and open the throttle window.
      sendLive(value);
      liveThrottleTimer = setTimeout(onThrottleWindowEnd, liveThrottleMs);
    } else {
      // Within the window: remember as the trailing value (latest wins).
      pendingTrailingValue = value;
    }
    // Deliberately never persists - dragging never writes storage.
  }

  function onChange(value) {
    // ALWAYS flush the final value to live audio first, then supersede any
    // pending trailing edge, then persist exactly once.
    clearThrottleTimer();
    pendingTrailingValue = null;
    if (value !== lastSentLiveValue) {
      sendLive(value);
    }
    return persist(value);
  }

  function dispose() {
    clearThrottleTimer();
    pendingTrailingValue = null;
  }

  return { onInput, onChange, dispose };
}
