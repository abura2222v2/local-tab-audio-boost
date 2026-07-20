// Pure, DOM-free scheduler for closing the offscreen document once the
// compatibility backend has nothing left to do.
//
// The offscreen document exists only to host the AudioContext that the
// tabCapture backend needs. When no compatibility session, pending start, or
// in-flight operation remains, keeping it alive costs a whole extra renderer
// process for nothing.
//
// Closing it is delicate, so the safety rules are encoded here rather than
// scattered through the service worker:
//
//  - it is DEBOUNCED, so a quick disable/enable never churns the document;
//  - every scheduled close carries a GENERATION token, so a timer armed for an
//    earlier idle period can never close a document that has become busy since;
//  - authoritative state is re-checked immediately BEFORE the close actually
//    runs, not only when it was scheduled;
//  - any new start cancels a pending close outright.
//
// The scheduler is injected (setTimeout/clearTimeout) so tests drive it with a
// controlled clock instead of real sleeps.

export function createOffscreenIdleCloser({
  isIdle,
  closeDocument,
  delayMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) {
  let timer = null;
  let generation = 0;
  let closing = false;

  function cancel() {
    if (timer !== null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    // Bumping the generation invalidates any callback already in flight.
    generation += 1;
  }

  /**
   * Arms a debounced close, but only while the backend is genuinely idle.
   * Calling this while busy is a no-op, and calling it repeatedly restarts the
   * debounce rather than stacking timers.
   */
  function schedule() {
    if (!isIdle()) return false;
    cancel();
    const scheduledGeneration = generation;
    timer = setTimeoutFn(async () => {
      timer = null;
      // Something started (and cancelled us) while the timer was pending.
      if (scheduledGeneration !== generation) return;
      // Re-check authoritative state at the last possible moment: a session
      // may have started between scheduling and firing.
      if (!isIdle()) return;
      if (closing) return;
      closing = true;
      try {
        // `closeDocument` has to await Chrome before it can act, and that gap
        // is long enough for a new compatibility start to create a document
        // and begin using it. So validity is passed in as a predicate and
        // re-checked immediately before the irreversible close, not merely
        // here - the same "re-check after every asynchronous boundary"
        // discipline the storage mutations use.
        await closeDocument(() => scheduledGeneration === generation && isIdle());
      } catch {
        // An already-closed document is a perfectly normal outcome here.
      } finally {
        closing = false;
      }
    }, delayMs);
    return true;
  }

  return {
    schedule,
    /** Called whenever work starts - always cancels a pending close. */
    cancel,
    isScheduled: () => timer !== null,
  };
}
