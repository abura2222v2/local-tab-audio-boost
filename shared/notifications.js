// Pure, DOM-free controller for the Saved pages status line.
//
// Success and neutral messages are transient: they disappear on their own
// after a short delay so the view does not accumulate stale confirmations.
// Errors are sticky - they stay until another action replaces them or the user
// clears them, because a message like "Could not stop active boosting" must
// never quietly vanish before it is read.
//
// The scheduler is injected (setTimeout/clearTimeout by default) so tests can
// drive the timing deterministically instead of sleeping.
//
// Timer safety: every scheduled hide captures the id of the message it belongs
// to, and only clears the line if that message is still the one displayed. A
// timer armed for an older message therefore cannot erase a newer one.

export const DEFAULT_NOTIFICATION_TIMEOUT_MS = 4000;

export const NOTIFICATION_KINDS = Object.freeze({
  SUCCESS: 'success',
  INFO: 'info',
  ERROR: 'error',
});

export function createNotificationController({
  render,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  timeoutMs = DEFAULT_NOTIFICATION_TIMEOUT_MS,
} = {}) {
  let timer = null;
  let currentId = 0;
  let current = { message: '', kind: null };

  function cancelTimer() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
  }

  function apply(message, kind) {
    current = { message, kind };
    render(message, kind);
  }

  function show(message, kind) {
    cancelTimer();
    currentId += 1;
    const id = currentId;
    apply(message, kind);

    // Errors are sticky; transient kinds schedule their own removal.
    if (kind === NOTIFICATION_KINDS.ERROR) return;

    timer = setTimeoutFn(() => {
      timer = null;
      // Only this exact message may be cleared by its own timer.
      if (id !== currentId) return;
      apply('', null);
    }, timeoutMs);
  }

  return {
    success: (message) => show(message, NOTIFICATION_KINDS.SUCCESS),
    info: (message) => show(message, NOTIFICATION_KINDS.INFO),
    error: (message) => show(message, NOTIFICATION_KINDS.ERROR),
    /** Clears immediately, cancelling any pending auto-hide. */
    clear() {
      cancelTimer();
      currentId += 1;
      apply('', null);
    },
    current: () => ({ ...current }),
  };
}
