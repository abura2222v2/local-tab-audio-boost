// Pure, chrome-free PendingStart/Session decision logic shared by the real
// offscreen document (offscreen/offscreen.js) and the Node test suite's fake
// offscreen responder, so the STOP_CAPTURE status contract and PendingStart
// cancellation semantics can never silently diverge between the two - see
// review round 4, fixes #5/#6.

/** Registers a new PendingStart, synchronously, before any await. */
export function registerPendingStart(pendingStarts, tabId, operationId) {
  const pending = { tabId, operationId, cancelled: false };
  pendingStarts.set(tabId, pending);
  return pending;
}

/** True only if `pendingObj` is still the live, uncancelled entry for `tabId`. */
export function isStillPending(pendingStarts, tabId, pendingObj) {
  return pendingStarts.get(tabId) === pendingObj && !pendingObj.cancelled;
}

/**
 * Terminal cleanup for a PendingStart's own async attempt (success or
 * failure) - removes it only if it is still the exact object registered,
 * by identity, so a newer PendingStart that has since replaced it at the
 * same tabId key is never disturbed.
 */
export function finalizePendingStart(pendingStarts, tabId, pendingObj) {
  if (pendingStarts.get(tabId) === pendingObj) {
    pendingStarts.delete(tabId);
  }
}

/**
 * Decides and applies a STOP_CAPTURE request against `sessions`/
 * `pendingStarts` (tabId -> entry Maps). Never mutates `sessions` - a
 * matched active Session is only ever described in the return value
 * (`matchedSession`), never torn down here, since actually tearing one down
 * is an async, context-specific operation (stopping MediaStreamTracks,
 * disconnecting the real Web Audio graph) that only the caller can perform.
 *
 * A matched PendingStart IS fully resolved here - cancelling and removing
 * it is a synchronous, purely in-memory operation with no context-specific
 * side effect, and removing it IMMEDIATELY (rather than leaving it for the
 * original start attempt's own eventual `finally` cleanup) is what lets a
 * brand new START_CAPTURE for the same tabId proceed right away instead of
 * being blocked by ALREADY_IN_PROGRESS for as long as a hung getUserMedia()
 * call takes to settle, if it ever does.
 */
export function decideAndApplyStopCapture({ tabId, operationId, force, sessions, pendingStarts }) {
  const requestedOperationId = operationId ?? null;

  const session = sessions.get(tabId);
  if (session) {
    if (!force && operationId && session.operationId !== operationId) {
      return {
        tabId,
        requestedOperationId,
        status: 'operation_mismatch',
        stoppedOperationId: null,
        currentOperationId: session.operationId,
        matchedSession: null,
      };
    }
    return {
      tabId,
      requestedOperationId,
      status: 'stopped',
      stoppedOperationId: session.operationId,
      currentOperationId: null,
      matchedSession: session,
    };
  }

  const pending = pendingStarts.get(tabId);
  if (pending) {
    if (!force && operationId && pending.operationId !== operationId) {
      return {
        tabId,
        requestedOperationId,
        status: 'operation_mismatch',
        stoppedOperationId: null,
        currentOperationId: pending.operationId,
        matchedSession: null,
      };
    }
    pending.cancelled = true;
    finalizePendingStart(pendingStarts, tabId, pending);
    return {
      tabId,
      requestedOperationId,
      status: 'pending_cancelled',
      stoppedOperationId: pending.operationId,
      currentOperationId: null,
      matchedSession: null,
    };
  }

  return { tabId, requestedOperationId, status: 'absent', stoppedOperationId: null, currentOperationId: null, matchedSession: null };
}

/** Projects live Sessions into GET_ACTIVE_SESSIONS' wire shape. */
export function listSessionsForEnumeration(sessions) {
  return [...sessions.values()].map((s) => ({ tabId: s.tabId, operationId: s.operationId, pageKey: s.pageKey, gainPercent: s.gainPercent }));
}

/** Projects in-flight PendingStarts into GET_ACTIVE_SESSIONS' wire shape. */
export function listPendingForEnumeration(pendingStarts) {
  return [...pendingStarts.values()].map((p) => ({ tabId: p.tabId, operationId: p.operationId }));
}
