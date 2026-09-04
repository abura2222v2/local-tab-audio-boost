// The sole coordinator: message routing, saved-page preference storage,
// tabCapture / offscreen-document lifecycle, cold-start reconciliation, and
// the only module that mutates persistent storage (via shared/settings.js).
//
// IMPORTANT product-model note: a saved page is a stored PREFERENCE (its
// exact URL plus a preferred gain percentage), never a capture permission.
// START_CAPTURE never checks savedPages membership - any supported current
// http/https page can be temporarily boosted after an explicit user action,
// saved or not. See README.md/SECURITY.md for the full product model.

import {
  TARGETS,
  MESSAGE_TYPES,
  ERROR_CODES,
  SESSION_STOP_REASONS,
  DEFAULT_VOLUME_PERCENT,
  OFFSCREEN_DOCUMENT_PATH,
  OFFSCREEN_RESPONSE_TIMEOUT_MS,
  PAGE_AUDIO_RESPONSE_TIMEOUT_MS,
  OFFSCREEN_IDLE_CLOSE_MS,
  MIN_GAIN_PERCENT,
  MAX_GAIN_PERCENT,
} from './shared/constants.js';
import {
  registerMessageHandler,
  sendMessage,
  createRequestId,
  HandlerError,
  validatePageContextSender,
} from './shared/messages.js';
import { clampGainPercent, isPlainObject, isNonEmptyString, isValidTabId } from './shared/validation.js';
import { sanitizeTitleSnapshot, sanitizeCustomName } from './shared/saved-page-metadata.js';
import {
  BACKENDS,
  BRIDGE_COMMANDS,
  PAGE_AUDIO_STATES,
  isRunningState,
  describeRefusal,
} from './shared/page-audio-policy.js';
import { createPageAudioRegistry } from './shared/page-audio-session.js';
import { createOffscreenIdleCloser } from './shared/offscreen-idle.js';
import { canonicalizePageKey } from './shared/urls.js';
import * as settingsStore from './shared/settings.js';

// ---------------------------------------------------------------------------
// Module-level state. `sessions` is a disposable, derived cache - it is never
// treated as authoritative until it has been reconciled at least once in the
// lifetime of this service-worker instance (see ensureReconciled below).
//
// entry.state progresses: 'resolving' -> 'starting' -> 'active', with
// 'resolving' meaning "operationId is registered, but the tab's URL/pageKey
// has not been resolved yet" - registered before the chrome.tabs.get await
// specifically so a navigation/Stop/close event arriving during that await
// has something to cancel (fix for a real race: previously the operation
// wasn't registered until *after* URL resolution, so such an event would
// see no session at all and be silently ignored).
//
// A session's presence here has NOTHING to do with whether its pageKey is
// saved - a temporary (unsaved) session is exactly as real, and exactly as
// carefully lifecycle-managed, as one for a saved page. `saved` is reported
// separately (see computeTabStateData) and only ever affects whether a
// PERSIST_PAGE_VOLUME/UPDATE_SAVED_PAGE_VOLUME write is allowed to succeed.
// ---------------------------------------------------------------------------

// Every session records which BACKEND owns it:
//   'page-audio'  - fullscreen-compatible, page-local Web Audio, no tabCapture
//   'tab-capture' - the explicit compatibility backend (offscreen + capture)
// A session with no `backend` predates this field and is treated as
// tab-capture, which is what reconciliation reconstructs from the offscreen
// document's own enumeration.
/** @type {Map<number, {operationId: string, pageKey: string|null, state: 'resolving'|'starting'|'active', gainPercent: number, backend: string, startedAt: number}>} */
const sessions = new Map();

/**
 * Page-audio frame controllers this worker believes are installed. Purely
 * derived, never persisted, and bounded: navigating or closing a tab drops
 * every record beneath it (see shared/page-audio-session.js).
 */
const pageAudioFrames = createPageAudioRegistry();

function backendOf(entry) {
  return entry && entry.backend ? entry.backend : BACKENDS.TAB_CAPTURE;
}

function isPageAudioSession(entry) {
  return backendOf(entry) === BACKENDS.PAGE_AUDIO;
}

let reconciliationPromise = null;
let reconciliationComplete = false;

let offscreenCreationPromise = null;

// ---------------------------------------------------------------------------
// Small, zero-dependency timeout helper. Never lets a caller wait forever on
// a hung offscreen-document response.
// ---------------------------------------------------------------------------

const TIMEOUT_SENTINEL = Symbol('offscreen-response-timeout');

/**
 * The live offscreen-response timeout. Always OFFSCREEN_RESPONSE_TIMEOUT_MS in
 * the real extension; tests override it (via __setOffscreenResponseTimeoutForTests)
 * so a timeout-path test can assert the real behavior deterministically off a
 * short, controlled timeout instead of sleeping for multiple real seconds.
 */
let offscreenResponseTimeoutMs = OFFSCREEN_RESPONSE_TIMEOUT_MS;

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT_SENTINEL), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// Offscreen document lifecycle.
// ---------------------------------------------------------------------------

async function offscreenDocumentExists() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  return contexts.some((context) => context.documentUrl === offscreenUrl);
}

/**
 * In-flight compatibility operations (starts and stops). An idle check that
 * only looked at `sessions` would miss a capture that is mid-start, so the
 * document could be closed out from under it.
 */
let inFlightCompatibilityOperations = 0;

/** True only when the compatibility backend holds nothing at all. */
function compatibilityBackendIsIdle() {
  if (inFlightCompatibilityOperations > 0) return false;
  for (const entry of sessions.values()) {
    // A page-audio session owns no offscreen resource, so it never keeps the
    // document alive.
    if (!isPageAudioSession(entry)) return false;
  }
  return true;
}

let offscreenIdleCloseDelayMs = OFFSCREEN_IDLE_CLOSE_MS;

const offscreenIdleCloser = createOffscreenIdleCloser({
  isIdle: () => compatibilityBackendIsIdle(),
  closeDocument: async (stillIdle) => {
    // Tolerate an already-closed document; only close one that really exists.
    if (!(await offscreenDocumentExists())) return;
    // That lookup was an asynchronous gap. A compatibility start could have
    // created a document and begun capturing in it since this close was
    // approved, so the authoritative state is re-checked here - immediately
    // before the irreversible step - never only when the timer fired.
    if (!stillIdle()) return;
    await chrome.offscreen.closeDocument();
  },
  delayMs: OFFSCREEN_IDLE_CLOSE_MS,
  setTimeoutFn: (fn) => setTimeout(fn, offscreenIdleCloseDelayMs),
  clearTimeoutFn: (id) => clearTimeout(id),
});

/** Arms the debounced idle close if - and only if - nothing is left to do. */
function maybeScheduleOffscreenIdleClose() {
  offscreenIdleCloser.schedule();
}

async function ensureOffscreenDocument() {
  // Any new compatibility work cancels a pending close outright.
  offscreenIdleCloser.cancel();
  if (await offscreenDocumentExists()) return;
  if (!offscreenCreationPromise) {
    offscreenCreationPromise = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['USER_MEDIA'],
        justification: 'Process user-invoked captured tab audio locally with Web Audio.',
      })
      .finally(() => {
        offscreenCreationPromise = null;
      });
  }
  await offscreenCreationPromise;
}

// ---------------------------------------------------------------------------
// Teardown. A single function, safe to call from any trigger, any number of
// times.
//
// `force: true` bypasses operationId matching on both the local cache and
// the offscreen document's own session/pending-start map. It is reserved
// for exactly one justified case: the emergency fail-closed path, where the
// service worker no longer trusts its own operationId bookkeeping at all.
// Every other trigger - navigation, tab close/replace, saved-page removal,
// reconciliation disagreement, a failed/ambiguous capture attempt, AND an
// explicit, current-intent user Disable - uses force:false with the
// specific operationId it believes is current, so a stale trigger can
// never disturb a newer, unrelated session that happens to share the same
// tabId - both locally and at the offscreen document.
// ---------------------------------------------------------------------------

/**
 * Strictly validates a STOP_CAPTURE response's `data` against the exact
 * request it answers (`tabId`/`requestedOperationId`/`force`). A response
 * that merely has the right `status` string is NOT enough: every other
 * field must be internally consistent with that status, or the response is
 * treated as malformed (never confirmation), exactly like a timeout or an
 * `ok:false`.
 *
 *  - 'stopped'/'pending_cancelled', force:false: `stoppedOperationId` must
 *    equal the requested operationId, `currentOperationId` must be null.
 *  - 'stopped'/'pending_cancelled', force:true: `stoppedOperationId` may
 *    legitimately differ from the requested operationId (force bypasses
 *    matching) but must still be a non-empty string - something WAS
 *    actually stopped - and `currentOperationId` must be null.
 *  - 'absent': `stoppedOperationId` and `currentOperationId` must both be
 *    null, regardless of force.
 *  - 'operation_mismatch': only ever legitimate for force:false;
 *    `stoppedOperationId` must be null and `currentOperationId` must be a
 *    non-empty string that is NOT the requested operationId.
 * `requestedOperationId` itself must always echo the request, in every case.
 */
function isValidStopCaptureResultData(tabId, requestedOperationId, force, data) {
  if (!isPlainObject(data)) return false;
  if (data.tabId !== tabId) return false;
  if (data.requestedOperationId !== requestedOperationId) return false;

  switch (data.status) {
    case 'stopped':
    case 'pending_cancelled':
      if (force) {
        return isNonEmptyString(data.stoppedOperationId) && data.currentOperationId === null;
      }
      return data.stoppedOperationId === requestedOperationId && data.currentOperationId === null;
    case 'absent':
      return data.stoppedOperationId === null && data.currentOperationId === null;
    case 'operation_mismatch':
      return (
        !force &&
        data.stoppedOperationId === null &&
        isNonEmptyString(data.currentOperationId) &&
        data.currentOperationId !== requestedOperationId
      );
    default:
      return false;
  }
}

/**
 * Sends STOP_CAPTURE and waits, with a hard timeout, for a response that
 * positively confirms the offscreen document actually stopped (or
 * cancelled a pending start for) `tabId` - not merely that a response of
 * some kind came back. offscreen.js's STOP_CAPTURE response explicitly
 * reports what happened via `data.status`:
 *   - 'stopped': the exact active Session for this operationId was torn down;
 *   - 'pending_cancelled': the exact PendingStart for this operationId was cancelled;
 *   - 'absent': there was no active or pending operation for this tabId at all;
 *   - 'operation_mismatch': a DIFFERENT operation currently owns this tabId -
 *     nothing was touched. This is deliberately never treated as confirmed.
 * A response is "confirmed" only if it arrived before the timeout, is
 * itself `{ok:true}`, and its `data` passes isValidStopCaptureResultData's
 * full strict shape check (not merely "has a matching tabId and a
 * plausible-looking status") for one of the three positive outcomes above.
 * Anything else (timeout, rejection, `ok:false`, a malformed/inconsistent
 * `data`, or `operation_mismatch`) is reported as unconfirmed - the caller
 * must never treat an unconfirmed outcome as "the tab is now silent."
 */
async function confirmedStopCapture(tabId, { operationId, force = false, reason } = {}) {
  const requestedOperationId = operationId ?? null;
  const response = await withTimeout(
    sendMessage(TARGETS.OFFSCREEN, MESSAGE_TYPES.STOP_CAPTURE, { tabId, operationId, force, reason }),
    offscreenResponseTimeoutMs
  );
  const timedOut = response === TIMEOUT_SENTINEL;
  const validShape =
    !timedOut &&
    Boolean(response) &&
    response.ok === true &&
    isValidStopCaptureResultData(tabId, requestedOperationId, force, response.data);
  const status = validShape ? response.data.status : null;
  const confirmed = validShape && (status === 'stopped' || status === 'pending_cancelled' || status === 'absent');
  return { confirmed, response: timedOut ? null : response };
}

/** True only for a response that positively, unambiguously (and consistently) reports a different operation owns this tabId now. */
function isCleanOperationMismatch(tabId, requestedOperationId, force, response) {
  return (
    Boolean(response) &&
    response.ok === true &&
    isValidStopCaptureResultData(tabId, requestedOperationId, force, response.data) &&
    response.data.status === 'operation_mismatch'
  );
}

/**
 * Confirmed teardown for a session the service worker's own cache
 * currently believes exists (navigation, tab close/replace, a saved page's
 * removal, Clear all, capture-status cleanup, and explicit Disable all use
 * this).
 *
 * The local cache entry is NEVER deleted before the offscreen document has
 * positively confirmed the session actually stopped - previously this
 * function deleted the entry immediately, so a failed/lost STOP_CAPTURE
 * response could leave the service worker believing a tab was inactive
 * while the offscreen document's audio graph was still live. If the
 * response cannot be confirmed:
 *   - a clean `operation_mismatch` never deletes the local cache and never
 *     triggers the heavy, everything-dies emergency sweep - it instead
 *     invalidates and re-runs ordinary reconciliation, which honestly
 *     rebuilds the cache from the offscreen document's real current state
 *     (correctly preserving whatever newer operation now owns this tabId);
 *   - anything else (timeout, rejection, `ok:false`, malformed data)
 *     escalates to the unconditional emergency fail-closed sweep, which
 *     force-stops everything it can enumerate and falls back to
 *     closeDocument() if even that cannot be confirmed.
 * Either way this returns a structured failure instead of ever claiming
 * the tab is inactive on an outcome that wasn't actually confirmed.
 *
 * Idempotent: a duplicate or superseded call for a tabId/operationId that
 * no longer matches the current cache entry (or has no entry at all) is a
 * harmless no-op that never touches a newer, unrelated session occupying
 * the same tabId.
 */
async function requestOffscreenTeardown(tabId, { operationId, force = false, reason } = {}) {
  const current = sessions.get(tabId);
  if (!current) {
    return { ok: true, data: { tabId } };
  }
  if (!force && operationId && current.operationId !== operationId) {
    return { ok: true, data: { tabId } };
  }

  // A page-audio session owns no capture stream and no offscreen graph, so the
  // whole confirmed-STOP_CAPTURE protocol does not apply to it. Teardown means
  // returning its frames to neutral gain and dropping this worker's records.
  if (isPageAudioSession(current)) {
    const owningOperationId = current.operationId;
    await deactivatePageAudio(tabId, owningOperationId);
    const stillCurrent = sessions.get(tabId);
    if (stillCurrent && stillCurrent.operationId === owningOperationId) {
      sessions.delete(tabId);
    }
    pageAudioFrames.removeTab(tabId);
    void reason;
    maybeScheduleOffscreenIdleClose();
    return { ok: true, data: { tabId, backend: BACKENDS.PAGE_AUDIO } };
  }

  const { confirmed, response } = await confirmedStopCapture(tabId, { operationId, force, reason });

  if (confirmed) {
    const stillCurrent = sessions.get(tabId);
    if (stillCurrent && (force || !operationId || stillCurrent.operationId === operationId)) {
      sessions.delete(tabId);
    }
    // The last compatibility session may have just gone away.
    maybeScheduleOffscreenIdleClose();
    return response;
  }

  if (isCleanOperationMismatch(tabId, operationId ?? null, force, response)) {
    reconciliationComplete = false;
    await ensureReconciled().catch(() => {});
    return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'This operation was superseded.' } };
  }

  await triggerEmergencyFailClosed();
  return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not confirm that audio capture was stopped.' } };
}

// ---------------------------------------------------------------------------
// Cold-start reconciliation.
// ---------------------------------------------------------------------------

async function verifyTabMatchesPageKey(tabId, pageKey) {
  try {
    const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!frame || !frame.url) return false;
    const result = canonicalizePageKey(frame.url);
    return result.ok && result.pageKey === pageKey;
  } catch {
    return false;
  }
}

/**
 * Ordinary cold-start reconciliation. Rebuilds the service worker's cache
 * from the offscreen document's own enumeration, tearing down any
 * candidate that disagrees with current capture-status/URL truth.
 *
 * A session's pageKey is NEVER required to be present in savedPages here -
 * a temporary (unsaved) session reconstructs exactly like a saved one,
 * purely from: valid shape, Chrome confirming the tab is captured, and
 * webNavigation.getFrame confirming the current exact page still matches
 * the session's immutable pageKey. Saved-page removal/Clear all instead
 * explicitly stop their matching sessions at the moment they happen (see
 * removeSavedPageByKeyAndStopSessions/handleClearSavedPages) - reconciliation
 * itself no longer re-derives "should this still be running?" from
 * savedPages membership at all.
 *
 * The reconstructed cache is published (via `sessions.clear()` +
 * repopulation) ONLY if every single candidate has either passed every
 * check outright, or had its required teardown POSITIVELY confirmed. If
 * any required teardown cannot be confirmed - or a candidate's data is too
 * malformed to even attempt a trustworthy scoped teardown - this throws
 * instead of continuing, so no partially-built cache is ever published
 * while a candidate's offscreen graph might still be live. The caller
 * (ensureReconciled) catches that throw and runs the unconditional
 * emergency fail-closed sweep, which does not depend on a trustworthy
 * operationId at all (force:true).
 */
async function reconcileState() {
  if (!(await offscreenDocumentExists())) {
    sessions.clear();
    return;
  }

  // Time-bounded: a listener that returns `true` but never calls
  // sendResponse must never leave this - and therefore every
  // state-sensitive command/listener awaiting ensureReconciled() - hanging
  // forever. A timeout here is handled identically to an explicit
  // rejection: reconcileState() throws, ensureReconciled()'s catch runs,
  // and the emergency sweep takes over. Because only this one call is
  // wrapped in Promise.race (not the whole of reconcileState()), a late
  // response arriving after the timeout has nothing left to affect - it is
  // simply never awaited again.
  const activeSessionsResponse = await withTimeout(
    sendMessage(TARGETS.OFFSCREEN, MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {}),
    offscreenResponseTimeoutMs
  );
  if (
    activeSessionsResponse === TIMEOUT_SENTINEL ||
    !activeSessionsResponse?.ok ||
    !Array.isArray(activeSessionsResponse.data?.sessions) ||
    !Array.isArray(activeSessionsResponse.data?.pending)
  ) {
    throw new Error('Could not enumerate offscreen sessions during reconciliation.');
  }
  const offscreenSessions = activeSessionsResponse.data.sessions;
  const pendingCandidates = activeSessionsResponse.data.pending;

  let capturedTabs = [];
  try {
    capturedTabs = await chrome.tabCapture.getCapturedTabs();
  } catch {
    throw new Error('Could not query tabCapture status during reconciliation.');
  }
  const capturedStatusByTabId = new Map(capturedTabs.map((info) => [info.tabId, info.status]));

  const reconciled = new Map();

  for (const candidate of offscreenSessions) {
    const shapeOk =
      Number.isInteger(candidate?.tabId) &&
      typeof candidate?.operationId === 'string' &&
      candidate.operationId.length > 0 &&
      typeof candidate?.pageKey === 'string' &&
      candidate.pageKey.length > 0 &&
      Number.isInteger(candidate?.gainPercent) &&
      candidate.gainPercent >= MIN_GAIN_PERCENT &&
      candidate.gainPercent <= MAX_GAIN_PERCENT;

    if (!shapeOk) {
      // No trustworthy tabId/operationId to scope a stop by at all - never
      // pretend a scoped stop was possible. Fail the whole reconciliation
      // immediately; the emergency sweep's force:true path does not need a
      // trustworthy operationId and will close the offscreen document if
      // even that cannot be confirmed.
      throw new Error('Malformed offscreen session candidate during reconciliation.');
    }

    // Re-validated through the same single canonicalization function every
    // other exact-match decision in this codebase uses - never trust the
    // offscreen document's own copy of pageKey without re-deriving it.
    const canonical = canonicalizePageKey(candidate.pageKey);
    const pageKeyValid = canonical.ok && canonical.pageKey === candidate.pageKey;

    let needsTeardown = false;
    const teardownReason = SESSION_STOP_REASONS.RECONCILIATION;

    if (!pageKeyValid) {
      needsTeardown = true;
    } else {
      const status = capturedStatusByTabId.get(candidate.tabId);
      if (status !== 'active' && status !== 'pending') {
        needsTeardown = true;
      } else if (!(await verifyTabMatchesPageKey(candidate.tabId, candidate.pageKey))) {
        needsTeardown = true;
      }
    }

    if (needsTeardown) {
      // These candidates come from the offscreen document's own
      // enumeration, not from this service worker's (still-empty,
      // being-rebuilt) local cache, so the cache-gated
      // requestOffscreenTeardown does not apply here - confirmedStopCapture
      // is called directly instead.
      const { confirmed } = await confirmedStopCapture(candidate.tabId, {
        operationId: candidate.operationId,
        reason: teardownReason,
      });
      if (!confirmed) {
        // Never publish a partially-built cache when a required teardown
        // could not be positively confirmed - the offscreen graph may
        // still be live. Abort the whole attempt so the emergency sweep
        // runs instead of silently dropping this candidate while it might
        // still be capturing.
        throw new Error('Could not confirm teardown of a mismatched candidate during reconciliation.');
      }
      continue;
    }

    reconciled.set(candidate.tabId, {
      operationId: candidate.operationId,
      pageKey: candidate.pageKey,
      state: 'active',
      gainPercent: candidate.gainPercent,
    });
  }

  // PendingStarts (getUserMedia()/graph construction still in flight at the
  // offscreen document, from a previous/unknown service-worker continuation)
  // are never adopted as an active session here - this service-worker
  // instance has no way to know whether that in-flight attempt is even
  // still wanted, since whatever cache entry originally tracked it is gone.
  // Every one is unconditionally cancelled via an operation-scoped
  // STOP_CAPTURE, and only the strictly-validated 'pending_cancelled'/
  // 'stopped' (it finished and became a Session between enumeration and
  // this Stop)/'absent' (it finished and disappeared first) outcomes count
  // as positively gone - anything else aborts the whole reconciliation
  // attempt exactly like a mismatched Session candidate does, so
  // `reconciliationComplete` can never become true while a candidate might
  // still be live.
  const claimedTabIds = new Set(reconciled.keys());
  for (const candidate of pendingCandidates) {
    const shapeOk =
      isValidTabId(candidate?.tabId) &&
      typeof candidate?.operationId === 'string' &&
      candidate.operationId.length > 0;
    if (!shapeOk) {
      throw new Error('Malformed pending-start candidate during reconciliation.');
    }
    if (claimedTabIds.has(candidate.tabId)) {
      // A genuine offscreen-side inconsistency - the same tabId cannot
      // legitimately be both an active Session and a pending start at
      // once. Never guess which one is real; abort and let the emergency
      // sweep's unconditional force:true path settle it.
      throw new Error('Conflicting pending-start candidate during reconciliation.');
    }
    claimedTabIds.add(candidate.tabId);

    const { confirmed } = await confirmedStopCapture(candidate.tabId, {
      operationId: candidate.operationId,
      reason: SESSION_STOP_REASONS.RECONCILIATION,
    });
    if (!confirmed) {
      throw new Error('Could not confirm cancellation of a pending-start candidate during reconciliation.');
    }
    // Never inserted into `reconciled` - a cancelled PendingStart is gone,
    // not active, regardless of which of the three positive outcomes above
    // actually applied.
  }

  // Only reached once every candidate has either passed every check or
  // been positively confirmed stopped/cancelled - never a partial/
  // best-effort result.
  //
  // Page-audio sessions are deliberately carried across: the offscreen
  // document has no knowledge of them (they own no capture stream and no
  // offscreen graph), so its enumeration must never be read as evidence that
  // they are gone. Their own lifecycle is driven by navigation/tab events.
  const survivingPageAudio = [...sessions.entries()].filter(([, entry]) => isPageAudioSession(entry));
  sessions.clear();
  for (const [tabId, entry] of survivingPageAudio) {
    sessions.set(tabId, entry);
  }
  for (const [tabId, entry] of reconciled) {
    sessions.set(tabId, entry);
  }
}

/**
 * Runs when reconcileState() itself fails to complete (as opposed to
 * ordinary per-session disagreement, which reconcileState() already
 * handles on its own), OR when a capture attempt is left in an ambiguous
 * state after streamId acquisition and its own operation-scoped cleanup
 * cannot be confirmed (see cleanUpAmbiguousOffscreenAttempt below). Nothing
 * evaluated so far can be trusted. This is an unconditional,
 * best-effort-then-guaranteed shutdown of everything the offscreen
 * document holds, followed by a clean retry opportunity.
 *
 * Every offscreen round trip here is time-bounded: a hung
 * GET_ACTIVE_SESSIONS or STOP_CAPTURE response must never prevent
 * closeDocument() from eventually running.
 */
async function emergencyFailClosed() {
  let recoveredViaOffscreen = false;

  try {
    const response = await withTimeout(
      sendMessage(TARGETS.OFFSCREEN, MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {}),
      offscreenResponseTimeoutMs
    );

    if (
      response !== TIMEOUT_SENTINEL &&
      response?.ok &&
      Array.isArray(response.data?.sessions) &&
      Array.isArray(response.data?.pending)
    ) {
      let allConfirmed = true;
      // Sweep both real Sessions and in-flight PendingStarts - a
      // getUserMedia() call still awaiting completion holds no Session yet
      // but must still be cancelled, or it could complete later and create
      // a live audio graph nobody is tracking anymore. BOTH arrays must be
      // genuinely present and well-formed: a response with a valid
      // `sessions` array but a malformed or missing `pending` is an
      // untrustworthy enumeration, and is treated exactly like a total
      // failure (recoveredViaOffscreen stays false -> closeDocument runs),
      // never silently swept with an empty pending list.
      const candidates = [...response.data.sessions, ...response.data.pending];
      for (const candidate of candidates) {
        if (!Number.isInteger(candidate?.tabId)) {
          allConfirmed = false;
          continue;
        }
        // Reuses the same strict confirmation contract as every other
        // teardown path (a bare `ok:true` is not sufficient - the response
        // must positively echo back the exact tabId being stopped, with a
        // status of 'stopped'/'pending_cancelled'/'absent') so an offscreen
        // document that is merely confused, rather than genuinely gone,
        // cannot make this emergency sweep falsely believe it succeeded.
        // force:true here means an 'operation_mismatch' can never occur -
        // it bypasses operationId matching entirely on both Sessions and
        // PendingStarts.
        const { confirmed } = await confirmedStopCapture(candidate.tabId, {
          operationId: candidate.operationId,
          force: true,
          reason: SESSION_STOP_REASONS.EMERGENCY_FAIL_CLOSED,
        });
        if (!confirmed) {
          allConfirmed = false;
        }
      }
      recoveredViaOffscreen = allConfirmed;
    } else {
      recoveredViaOffscreen = false;
    }
  } catch {
    recoveredViaOffscreen = false;
  }

  try {
    if (!recoveredViaOffscreen) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    // Nothing further can be done - there may be no document to close, or
    // closing itself failed. Either way, fall through to clearing the
    // cache below, which is the one guarantee this function must always
    // keep.
  } finally {
    sessions.clear();
  }
}

/** Shared by ensureReconciled's own failure path and by an ambiguous mid-capture failure. */
async function triggerEmergencyFailClosed() {
  await emergencyFailClosed();
  reconciliationComplete = false;
}

function ensureReconciled() {
  if (reconciliationComplete) return Promise.resolve();
  if (!reconciliationPromise) {
    reconciliationPromise = reconcileState()
      .then(() => {
        reconciliationComplete = true;
      })
      .catch(async () => {
        await triggerEmergencyFailClosed();
        throw new HandlerError(ERROR_CODES.RECONCILIATION_FAILED, 'Could not verify extension state. Please try again.');
      })
      .finally(() => {
        reconciliationPromise = null;
      });
  }
  return reconciliationPromise;
}

// ---------------------------------------------------------------------------
// Shared helpers.
// ---------------------------------------------------------------------------

function describeUrlErrorCode(code) {
  switch (code) {
    case ERROR_CODES.UNSUPPORTED_SCHEME:
      return 'This type of page cannot be boosted.';
    case ERROR_CODES.CREDENTIALS_IN_URL:
      return "This page's address contains embedded credentials and can't be used.";
    case ERROR_CODES.RESTRICTED_PAGE:
      return 'This page cannot be captured.';
    case ERROR_CODES.INVALID_URL:
    default:
      return 'This page has no usable address.';
  }
}

/**
 * Resolves a tab's canonical exact pageKey, and alongside it the tab's CURRENT
 * title as read from chrome.tabs.get here in the service worker. The title is
 * read server-side on purpose: "Add this page" never trusts a title supplied by
 * the popup (see handleAddCurrentPage), so a compromised or buggy popup cannot
 * write an arbitrary label into storage. The raw title is passed on to
 * sanitizeTitleSnapshot before it is ever stored.
 */
async function resolvePageKeyForTab(tabId) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return { ok: false, error: { code: ERROR_CODES.NO_TAB, message: 'Tab could not be found.' } };
  }
  if (!tab || !tab.url) {
    return { ok: false, error: { code: ERROR_CODES.NO_TAB, message: 'Tab has no accessible URL.' } };
  }
  const result = canonicalizePageKey(tab.url);
  if (!result.ok) {
    return { ok: false, error: { code: result.code, message: describeUrlErrorCode(result.code) } };
  }
  return { ok: true, pageKey: result.pageKey, title: typeof tab.title === 'string' ? tab.title : '' };
}

/**
 * `saved` reports whether the tab's exact current pageKey has a stored
 * preference - independent of `state`. A page needs no saved preference to
 * be temporarily boosted; `saved` only ever affects whether
 * PERSIST_PAGE_VOLUME is allowed to write anything.
 */
async function computeTabStateData(tabId) {
  const entry = sessions.get(tabId);

  // `tabId` is always included so the GET_TAB_STATE response is
  // self-describing: the popup's controller derives its own working tabId
  // from this state (it has no other server-authoritative source), and every
  // START_CAPTURE / SET_TAB_GAIN it then issues carries a valid tabId. This
  // matches the tabId already carried by TAB_STATE_CHANGED broadcasts.
  if (entry && entry.state === 'resolving') {
    return {
      tabId,
      pageKey: null,
      displayUrl: null,
      saved: false,
      state: 'resolving',
      gainPercent: DEFAULT_VOLUME_PERCENT,
      restricted: false,
      operationId: entry.operationId,
    };
  }

  const resolved = await resolvePageKeyForTab(tabId);
  if (!resolved.ok) {
    return {
      tabId,
      pageKey: null,
      displayUrl: null,
      saved: false,
      state: 'inactive',
      gainPercent: DEFAULT_VOLUME_PERCENT,
      restricted: true,
      errorCode: resolved.error.code,
      errorMessage: resolved.error.message,
      operationId: null,
    };
  }
  const savedPages = await settingsStore.getSavedPages();
  const savedRecord = savedPages[resolved.pageKey];
  const saved = Boolean(savedRecord);
  const matchesEntry = Boolean(entry) && entry.pageKey === resolved.pageKey;
  const state = matchesEntry ? entry.state : 'inactive';
  // Schema 6: a saved page's stored value is a record, so the inactive
  // display volume comes from its volumePercent field.
  const gainPercent =
    state === 'active' && entry ? entry.gainPercent : (savedRecord ? savedRecord.volumePercent : DEFAULT_VOLUME_PERCENT);
  return {
    tabId,
    pageKey: resolved.pageKey,
    displayUrl: resolved.pageKey,
    saved,
    state,
    gainPercent,
    restricted: false,
    // Which engine owns this tab's session, so the popup can say whether
    // fullscreen still works normally.
    backend: matchesEntry ? backendOf(entry) : null,
    // The popup uses this to scope SET_TAB_GAIN/PERSIST_PAGE_VOLUME to the
    // exact session generation it observed - never derived from anything
    // other than this tab's own current cache entry.
    operationId: matchesEntry ? entry.operationId : null,
  };
}

async function broadcastTabState(tabId, extra = {}) {
  try {
    const data = await computeTabStateData(tabId);
    await sendMessage(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED, { tabId, ...data, ...extra });
  } catch {
    // Best-effort only - the popup may not be open.
  }
}

async function broadcastSavedPagesChanged() {
  try {
    const savedPages = await settingsStore.getSavedPages();
    await sendMessage(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGES_CHANGED, {
      savedPages,
      activePageKeys: listActivePageKeys(),
    });
  } catch {
    // Best-effort only - the saved-pages view may not be open.
  }
}

/**
 * Narrowly-scoped notice to any open popup that ONE exact saved pageKey's
 * stored value changed. The popup refreshes only if that pageKey matches the
 * tab it is open on, and never starts capture - see handlePopupMessage in
 * popup.js. Carries just the pageKey (never the whole map), so the popup is
 * not subscribed to a broad map broadcast.
 */
async function broadcastSavedPageChangedToPopup(pageKey) {
  try {
    await sendMessage(TARGETS.POPUP, MESSAGE_TYPES.SAVED_PAGE_CHANGED, { pageKey });
  } catch {
    // Best-effort only - the popup may not be open.
  }
}

/**
 * Narrowly-scoped LIVE-gain notice to any open Saved-pages/options view that
 * ONE exact pageKey's live gain changed while the POPUP slider was driving an
 * active session (see handleSetTabGain). An open Saved-pages view moves only
 * the matching exact row's slider + percentage in real time; it never
 * persists and no other row is touched. Carries just the pageKey + the
 * already-confirmed, already-clamped gainPercent (never the whole map). For an
 * unsaved page the options view has no matching row, so this is a harmless
 * no-op there - it can never create a saved entry.
 */
async function broadcastSavedPageLiveGainToOptions(pageKey, gainPercent) {
  try {
    await sendMessage(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED, { pageKey, gainPercent });
  } catch {
    // Best-effort only - the saved-pages view may not be open.
  }
}

function staleResult() {
  return { ok: false, error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'This operation was cancelled.' } };
}

/**
 * Handles a capture attempt left in an ambiguous state at the offscreen
 * layer: either an explicit failure response, a malformed/missing
 * response, or a stale continuation whose eventual response can no longer
 * be trusted. Always attempts an operation-scoped (force:false) teardown
 * for this exact operationId first - safe to send even if no graph was
 * ever actually created there (a harmless no-op in that case). If that
 * cleanup cannot be confirmed within a timeout, escalates to the full
 * emergency fail-closed path rather than assuming the graph is gone.
 */
async function cleanUpAmbiguousOffscreenAttempt(tabId, operationId) {
  const { confirmed, response } = await confirmedStopCapture(tabId, {
    operationId,
    force: false,
    reason: SESSION_STOP_REASONS.CAPTURE_START_FAILED,
  });
  if (confirmed) return;
  if (isCleanOperationMismatch(tabId, operationId ?? null, false, response)) {
    // A newer operation already occupies this tabId at the offscreen
    // layer - this stale attempt never had anything in the local cache to
    // begin with, so there is nothing to reconcile and nothing to clean
    // up. Never escalate to a full emergency sweep just because a start
    // attempt lost a supersession race.
    return;
  }
  await triggerEmergencyFailClosed();
}

/**
 * The one function that actually starts a capture - used by the public
 * START_CAPTURE handler for every request, saved page or not. Every
 * asynchronous step re-checks that this operation is still the current one
 * for its tabId before proceeding. Any failure or ambiguity after
 * streamId acquisition always attempts offscreen-side cleanup - it never
 * merely deletes the local cache entry and hopes the offscreen document
 * agrees.
 *
 * The starting gain is `initialGainPercent` (already clamped by the caller),
 * bound to this exact operation and passed straight through to the offscreen
 * START_CAPTURE. savedPages is never consulted here - the popup supplies the
 * value the user's slider currently shows (or the displayed default/saved
 * value for an Enable click), so capture starts at exactly that value.
 *
 * Precondition: the caller has already registered
 * `{operationId, pageKey, state:'starting'}` in `sessions` for `tabId`
 * before calling this.
 */
async function beginCaptureForPage(tabId, pageKey, operationId, initialGainPercent) {
  inFlightCompatibilityOperations += 1;
  try {
    return await beginCaptureForPageInner(tabId, pageKey, operationId, initialGainPercent);
  } finally {
    inFlightCompatibilityOperations -= 1;
    // Whether it succeeded or failed, this is a moment worth re-evaluating:
    // a failed start may have left nothing behind at all.
    maybeScheduleOffscreenIdleClose();
  }
}

async function beginCaptureForPageInner(tabId, pageKey, operationId, initialGainPercent) {
  function stillCurrent() {
    const entry = sessions.get(tabId);
    return Boolean(entry) && entry.operationId === operationId && entry.state === 'starting';
  }

  let streamAcquired = false;

  try {
    await ensureReconciled();
    if (!stillCurrent()) return staleResult();

    sessions.get(tabId).gainPercent = initialGainPercent;

    try {
      await ensureOffscreenDocument();
    } catch {
      if (stillCurrent()) sessions.delete(tabId);
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not initialize the audio engine.' } };
    }
    if (!stillCurrent()) return staleResult();

    let streamId;
    try {
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch {
      if (stillCurrent()) sessions.delete(tabId);
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not start audio capture for this tab.' } };
    }
    streamAcquired = true;
    if (!stillCurrent()) {
      // A cancellation raced in right as the stream id was granted, before
      // any offscreen message was sent - nothing exists at the offscreen
      // layer yet for this operationId, but ask anyway (harmless no-op)
      // for symmetry and defense in depth.
      await cleanUpAmbiguousOffscreenAttempt(tabId, operationId);
      return staleResult();
    }

    const gainPercent = sessions.get(tabId).gainPercent;
    // Time-bounded: a START_CAPTURE round trip that never resolves must
    // never leave this operation stuck in 'starting' forever, or the
    // tab's native output suppressed with nothing to un-suppress it. A
    // timeout is treated exactly like any other ambiguous outcome below -
    // it is never assumed to mean "no graph was created."
    const startResponse = await withTimeout(
      sendMessage(TARGETS.OFFSCREEN, MESSAGE_TYPES.START_CAPTURE, {
        tabId,
        streamId,
        operationId,
        pageKey,
        gainPercent,
      }),
      offscreenResponseTimeoutMs
    );

    const timedOut = startResponse === TIMEOUT_SENTINEL;
    const confirmed =
      !timedOut && Boolean(startResponse) && startResponse.ok === true && startResponse.data?.operationId === operationId;

    if (!stillCurrent()) {
      // A cancellation raced in while the offscreen document was creating
      // the graph. Ask it to tear down whatever it just built, scoped by
      // our own (now-stale) operationId so a newer session is never
      // disturbed - never touch the local cache here, it may already
      // belong to a different, legitimate operation.
      await cleanUpAmbiguousOffscreenAttempt(tabId, operationId);
      return staleResult();
    }

    if (!confirmed) {
      // Ambiguous or explicit failure: the response may be a clean
      // rejection (no graph was ever created), or a lost/malformed
      // response to a START_CAPTURE that actually succeeded at the
      // offscreen layer. Treat it as ambiguous either way - always attempt
      // offscreen-side cleanup, never merely delete the local cache entry.
      sessions.delete(tabId);
      await cleanUpAmbiguousOffscreenAttempt(tabId, operationId);
      return {
        ok: false,
        error: startResponse?.error ?? { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not start audio capture.' },
      };
    }

    // The direct response to the offscreen START_CAPTURE request is the
    // only authoritative confirmation that the audio graph exists. There is
    // no separate asynchronous "session started" event anywhere in this
    // protocol - offscreen only ever sends SESSION_STOPPED/SESSION_ERROR
    // after startup has already completed.
    return { ok: true };
  } catch (err) {
    if (stillCurrent()) sessions.delete(tabId);
    if (streamAcquired) {
      // An unexpected exception after streamId acquisition must not merely
      // delete the local cache - the offscreen document may still hold a
      // live (or partially built) graph for this operationId.
      await cleanUpAmbiguousOffscreenAttempt(tabId, operationId);
    }
    if (err instanceof HandlerError) throw err;
    return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not start audio capture due to an unexpected error.' } };
  }
}

/**
 * Best-effort live-propagates a confirmed gain to every OTHER currently
 * active session sharing the exact same immutable pageKey - used by both
 * handlePersistPageVolume (a tab-scoped commit) and
 * handleUpdateSavedPageVolume (the saved-pages view's direct, non-tab-
 * scoped update). The storage write that precedes this call is already
 * authoritative and unconditional; a failure to live-propagate to one
 * particular tab here is best-effort only, and must never silently mark
 * that tab's local cache as updated when the offscreen document did not
 * positively confirm the change actually applied. Only a positively
 * confirmed change updates that tab's cache AND broadcasts TAB_STATE_CHANGED
 * for it, so an open popup on that exact active tab immediately shows the
 * new percentage - and a failed propagation never falsely updates either.
 */
/**
 * Applies one confirmed, operation-scoped live gain to ONE active session, and
 * updates the local cache + notifies observers only on positive confirmation.
 * The single primitive behind every live-gain path (popup slider, saved-pages
 * row drag, and bulk Reset-to-100), so they can never diverge on what counts
 * as "the offscreen document actually applied this".
 *
 * Returns true only if the offscreen document echoed back this exact
 * tabId/gain AND the operation was still current afterwards. A failed, stale,
 * or superseded update returns false and changes nothing - never a cache entry
 * claiming a gain that was not applied, and never a broadcast implying one.
 */
async function applyConfirmedGainToSession(tabId, operationId, clamped) {
  // Route to whichever backend owns this session. page-audio talks to its
  // injected frame controllers; tab-capture talks to the offscreen document.
  const owning = sessions.get(tabId);
  if (owning && owning.operationId === operationId && isPageAudioSession(owning)) {
    const confirmed = await setPageAudioGain(tabId, operationId, clamped);
    if (!confirmed) return false;
    const current = sessions.get(tabId);
    if (!current || current.operationId !== operationId) return false;
    current.gainPercent = clamped;
    await broadcastTabState(tabId);
    return true;
  }

  const gainResponse = await sendMessage(TARGETS.OFFSCREEN, MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: clamped,
    operationId,
  });
  const gainConfirmed =
    Boolean(gainResponse) &&
    gainResponse.ok === true &&
    gainResponse.data?.tabId === tabId &&
    gainResponse.data?.gainPercent === clamped;
  if (!gainConfirmed) return false;
  const current = sessions.get(tabId);
  if (!current || current.operationId !== operationId) return false;
  current.gainPercent = clamped;
  await broadcastTabState(tabId);
  return true;
}

async function propagateGainToSessionsSharingPageKey(pageKey, clamped) {
  // Snapshotted first (mirroring stopSnapshotSessions below) so concurrent
  // application never iterates `sessions` while it is being mutated, then
  // applied to every matching tabId in parallel: each target is a distinct
  // tabId, so their offscreen/page-audio round trips and cache updates never
  // touch one another's state.
  const snapshot = [...sessions.entries()].filter(
    ([, entry]) => entry.pageKey === pageKey && entry.state === 'active'
  );
  await Promise.all(
    snapshot.map(([otherTabId, otherEntry]) => applyConfirmedGainToSession(otherTabId, otherEntry.operationId, clamped))
  );
}

// ---------------------------------------------------------------------------
// Message handlers.
// ---------------------------------------------------------------------------

async function handleGetTabState({ tabId }) {
  await ensureReconciled();
  const data = await computeTabStateData(tabId);
  return { ok: true, data };
}

/**
 * The exact pageKeys that currently have an ACTIVE session, so the saved-pages
 * view can show a per-row boosting status. Derived purely from the live
 * in-memory session cache - session state is never persisted, and this list is
 * never stored.
 */
function listActivePageKeys() {
  const keys = new Set();
  for (const entry of sessions.values()) {
    if (entry.state === 'active' && entry.pageKey) keys.add(entry.pageKey);
  }
  return [...keys];
}

async function handleGetSavedPages() {
  await ensureReconciled();
  const savedPages = await settingsStore.getSavedPages();
  return { ok: true, data: { savedPages, activePageKeys: listActivePageKeys() } };
}

/**
 * `expectedPageKey` is the popup's last server-derived pageKey for this
 * tab - never trusted as authority, only compared against a freshly
 * re-derived pageKey below. This is what prevents a navigation that races
 * the "Add this page" click (the click resolves against page A, but by
 * the time chrome.tabs.get here actually runs the tab has moved to page
 * B) from silently adding whichever page the tab happens to show *now*.
 *
 * `gainPercent` is the popup's current main-slider value, saved atomically
 * alongside the URL. Saving never starts, requires, or restarts a capture
 * session - if a temporary session is already active for this tab, it
 * simply becomes associated with the newly saved preference (its own
 * lifecycle is completely untouched by this call).
 */
async function handleAddCurrentPage({ tabId, expectedPageKey, gainPercent }) {
  await ensureReconciled();
  const resolved = await resolvePageKeyForTab(tabId);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  if (resolved.pageKey !== expectedPageKey) {
    return { ok: false, error: { code: ERROR_CODES.PAGE_CHANGED, message: 'This page changed before the action could complete.' } };
  }
  const clamped = clampGainPercent(gainPercent) ?? DEFAULT_VOLUME_PERCENT;
  // Schema 6: the titleSnapshot is the tab's CURRENT title, read by this
  // service worker from chrome.tabs.get above - never a value the popup sent,
  // and never fetched from the network. It is sanitized (control characters
  // stripped, whitespace collapsed, length-limited) before storage.
  // customName is deliberately not supplied here, so an existing user-chosen
  // name survives a re-save untouched (see addSavedPage). Saving never starts,
  // stops, or restarts a capture session.
  const result = await settingsStore.addSavedPage(resolved.pageKey, clamped, {
    titleSnapshot: sanitizeTitleSnapshot(resolved.title),
  });
  broadcastSavedPagesChanged();
  broadcastTabState(tabId);
  return { ok: true, data: result };
}

/**
 * A manually entered URL is NEVER visited, fetched, or captured, so it can
 * have no titleSnapshot - only the optional local name the user typed. An
 * empty name leaves the display falling back to a locally derived URL label.
 * Re-adding an already-saved URL never duplicates it: the existing record's
 * titleSnapshot is preserved, and an existing customName is only replaced when
 * the user actually supplied a new one.
 */
async function handleAddPageManual({ rawUrl, gainPercent, customName }) {
  await ensureReconciled();
  const result = canonicalizePageKey(rawUrl);
  if (!result.ok) return { ok: false, error: { code: result.code, message: describeUrlErrorCode(result.code) } };
  const clamped = gainPercent === undefined ? DEFAULT_VOLUME_PERCENT : (clampGainPercent(gainPercent) ?? DEFAULT_VOLUME_PERCENT);
  const added = await settingsStore.addSavedPage(result.pageKey, clamped, {
    customName: sanitizeCustomName(customName),
  });
  broadcastSavedPagesChanged();
  broadcastSavedPageChangedToPopup(result.pageKey);
  return { ok: true, data: added };
}

/**
 * Snapshots the currently-cached sessions matching `predicate` ONCE, then
 * stops each through confirmed, operation-scoped teardown. Returns
 * `{ ok: true }` only if every snapshot session was positively confirmed
 * stopped (or was already gone / owned by a newer unrelated operation - a
 * safe no-op via requestOffscreenTeardown's own cache/operationId gate);
 * returns the first structured failure otherwise (an unconfirmed, timed-out,
 * mismatched, malformed, or failed stop). A brand-new capture that starts
 * for the same page AFTER this snapshot is deliberately NOT chased - that
 * would risk an unbounded retry loop; it simply becomes a temporary unsaved
 * session once the saved preference is gone.
 */
async function stopSnapshotSessions(predicate, reason) {
  const snapshot = [...sessions.entries()].filter(([, entry]) => predicate(entry));
  // Every snapshotted session is a distinct tabId, so their teardowns are
  // independent and safe to run concurrently (requestOffscreenTeardown never
  // touches any tabId's cache entry other than its own). Every teardown is
  // still attempted even if an earlier one (by snapshot order) fails - the
  // first failure is what gets reported, but a slow or failing stop for one
  // tab no longer blocks - or gets skipped ahead of - the rest.
  const results = await Promise.all(
    snapshot.map(([tabId, entry]) => requestOffscreenTeardown(tabId, { operationId: entry.operationId, reason }))
  );
  return results.find((result) => !result.ok) ?? { ok: true };
}

/**
 * Deletes one saved preference, but only AFTER every live session for that
 * exact page has been positively confirmed stopped. If any required stop
 * cannot be confirmed, the saved entry is left completely intact and a
 * structured failure is returned - the storage mutation never runs, and
 * SAVED_PAGES_CHANGED is never broadcast.
 */
/**
 * The single safe per-page deletion core, shared by the individual row Delete
 * (REMOVE_SAVED_PAGE) and by bulk Delete selected (DELETE_SELECTED_SAVED_PAGES),
 * so both obey exactly the same contract:
 *
 *  1. snapshot every active session whose immutable pageKey EXACTLY matches;
 *  2. stop each through confirmed, operation-scoped teardown;
 *  3. only if every required teardown was positively confirmed, remove the
 *     saved record. An unconfirmed teardown leaves the record fully intact and
 *     reports a structured failure - the preference is never deleted while an
 *     offscreen graph for it might still be live.
 *
 * An UNSAVED session is never touched (it has no saved record to remove and
 * does not match any pageKey being deleted unless it genuinely is that exact
 * page), and no other exact URL - same hostname or not - is affected.
 */
async function deleteOneSavedPage(pageKey) {
  const stopResult = await stopSnapshotSessions(
    (entry) => entry.pageKey === pageKey,
    SESSION_STOP_REASONS.REMOVED_FROM_SAVED_PAGES
  );
  if (!stopResult.ok) {
    return { pageKey, ok: false, error: stopResult.error };
  }
  const result = await settingsStore.removeSavedPage(pageKey);
  return { pageKey, ok: true, removed: result.removed };
}

async function handleRemoveSavedPage({ pageKey }) {
  await ensureReconciled();
  const result = await deleteOneSavedPage(pageKey);
  if (!result.ok) return { ok: false, error: result.error };
  broadcastSavedPagesChanged();
  broadcastSavedPageChangedToPopup(pageKey);
  return { ok: true, data: { pageKey, removed: result.removed } };
}

/**
 * Bulk delete over the saved-pages view's current selection. Every page is an
 * INDEPENDENT result: one page whose teardown cannot be confirmed keeps its
 * saved record and reports a structured failure, while unrelated selected
 * pages still complete normally. Never reports success for a page that failed -
 * the caller folds the per-page results back into its selection, dropping the
 * successes and keeping the failures selected for a retry.
 */
async function handleDeleteSelectedSavedPages({ pageKeys }) {
  await ensureReconciled();
  // Each pageKey is an exact, distinct page - no two selected pageKeys can
  // ever share a live session's tabId (a session's pageKey is immutable and
  // unique to its tab) - so deleting them is embarrassingly parallel. Storage
  // writes still serialize correctly through settingsStore's own mutation
  // queue regardless of the order these settle in.
  const outcomes = await Promise.all(pageKeys.map((pageKey) => deleteOneSavedPage(pageKey)));
  let anyDeleted = false;
  const results = outcomes.map((result) => {
    if (result.ok) anyDeleted = true;
    return result.ok ? { pageKey: result.pageKey, ok: true } : { pageKey: result.pageKey, ok: false, error: result.error };
  });
  if (anyDeleted) {
    broadcastSavedPagesChanged();
    for (const result of results) {
      if (result.ok) broadcastSavedPageChangedToPopup(result.pageKey);
    }
  }
  return { ok: true, data: { results } };
}

/**
 * Resets ONE selected page's saved volume to 100% (GainNode gain 1.0). This is
 * not a deletion and never stops capture: a page that is currently boosting
 * stays boosting, just at 1.0.
 *
 * For an ACTIVE saved page every matching snapshot session must positively
 * confirm the operation-scoped 100% live update BEFORE the saved preference is
 * committed - if any confirmation fails, 100% is not persisted for that page
 * and a structured failure is returned. An inactive page simply persists.
 */
async function resetOneSavedPageTo100(pageKey) {
  const snapshot = [...sessions.entries()].filter(
    ([, entry]) => entry.pageKey === pageKey && entry.state === 'active'
  );

  for (const [tabId, entry] of snapshot) {
    const confirmed = await applyConfirmedGainToSession(tabId, entry.operationId, DEFAULT_VOLUME_PERCENT);
    if (!confirmed) {
      return {
        pageKey,
        ok: false,
        error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not apply 100% to this page’s active tab.' },
      };
    }
    // The row in any open Saved-pages view follows the confirmed live change.
    broadcastSavedPageLiveGainToOptions(pageKey, DEFAULT_VOLUME_PERCENT);
  }

  const result = await settingsStore.persistExistingVolumeIfPreconditionHolds(
    pageKey,
    DEFAULT_VOLUME_PERCENT,
    () => true
  );
  if (result.aborted) {
    return { pageKey, ok: false, error: { code: ERROR_CODES.PAGE_NOT_SAVED, message: 'This page is not saved.' } };
  }
  return { pageKey, ok: true };
}

/**
 * Bulk "Reset selected to 100%". Independent per-page results exactly like
 * bulk delete: a failure for one page never blocks another, and a page whose
 * live update could not be confirmed does not get 100% persisted.
 */
async function handleResetSelectedSavedPagesTo100({ pageKeys }) {
  await ensureReconciled();
  // Same independence argument as handleDeleteSelectedSavedPages: distinct
  // exact pageKeys can never share a session's tabId, so resetting them is
  // safe to run concurrently.
  const results = await Promise.all(pageKeys.map((pageKey) => resetOneSavedPageTo100(pageKey)));
  let anyChanged = false;
  for (const result of results) {
    if (result.ok) anyChanged = true;
  }
  if (anyChanged) {
    broadcastSavedPagesChanged();
    for (const result of results) {
      if (result.ok) broadcastSavedPageChangedToPopup(result.pageKey);
    }
  }
  return { ok: true, data: { results } };
}

/**
 * Sets one saved page's local customName. Display-only: pageKey,
 * volumePercent, and titleSnapshot are all untouched, and no capture session is
 * started, stopped, or otherwise disturbed. An empty name clears the override.
 * Renaming a page that no longer exists returns a structured PAGE_NOT_SAVED
 * rather than resurrecting it.
 */
async function handleRenameSavedPage({ pageKey, customName }) {
  await ensureReconciled();
  const result = await settingsStore.renameSavedPage(pageKey, customName);
  if (result.aborted) {
    return { ok: false, error: { code: ERROR_CODES.PAGE_NOT_SAVED, message: 'This page is not saved.' } };
  }
  broadcastSavedPagesChanged();
  return { ok: true, data: { pageKey, customName: result.customName } };
}

/**
 * Clears every saved preference, but only AFTER every currently-cached
 * session has been positively confirmed stopped. Aborts without clearing
 * storage (returning a structured failure) if any required stop cannot be
 * confirmed.
 */
async function handleClearSavedPages() {
  await ensureReconciled();
  const stopResult = await stopSnapshotSessions(() => true, SESSION_STOP_REASONS.REMOVED_FROM_SAVED_PAGES);
  if (!stopResult.ok) return stopResult;
  const result = await settingsStore.clearSavedPages();
  broadcastSavedPagesChanged();
  return { ok: true, data: result };
}

/**
 * The saved-pages view's own direct, pageKey-scoped update - never tied to
 * any one tab or operationId, since it is not sent by a popup observing a
 * particular tab's session generation. Updates only that exact URL's saved
 * default; never starts a new capture session. If one or more sessions are
 * currently active for the identical exact pageKey, the new gain is
 * applied to them only after a confirmed, operation-scoped offscreen
 * response per session - a failed live update never corrupts the stored
 * value (already committed, unconditionally) or leaves a session's local
 * cache claiming an unconfirmed value.
 */
async function handleUpdateSavedPageVolume({ pageKey, gainPercent }) {
  await ensureReconciled();
  const clamped = clampGainPercent(gainPercent);
  if (clamped === null) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_MESSAGE, message: 'Invalid gain value.' } };
  }
  const result = await settingsStore.persistExistingVolumeIfPreconditionHolds(pageKey, clamped, () => true);
  if (result.aborted) {
    return { ok: false, error: { code: ERROR_CODES.PAGE_NOT_SAVED, message: 'This page is not saved.' } };
  }
  await propagateGainToSessionsSharingPageKey(pageKey, clamped);
  broadcastSavedPagesChanged();
  // Notify any popup open on this exact page: an ACTIVE tab already got its
  // TAB_STATE_CHANGED from propagateGainToSessionsSharingPageKey above; this
  // additionally covers an INACTIVE popup on the identical saved page, which
  // refreshes to show the new saved default (never starting capture).
  broadcastSavedPageChangedToPopup(pageKey);
  return { ok: true, data: result };
}

/**
 * The saved-pages view's LIVE (non-persisting) row-slider drag. Sent
 * throttled while a row slider is moved, before the final value is committed
 * (separately) via UPDATE_SAVED_PAGE_VOLUME on release. This handler NEVER
 * writes storage and NEVER starts a capture session - it only propagates the
 * new gain to any currently active session(s) sharing the identical exact
 * pageKey, through the same confirmed, operation-scoped offscreen update that
 * every other live-gain path uses (see propagateGainToSessionsSharingPageKey:
 * a failed/stale update never falsely marks a session's cache updated, and
 * only a positively confirmed change broadcasts TAB_STATE_CHANGED so an open
 * popup on that exact active tab moves its slider in real time). If no session
 * is active for this pageKey, it is simply a no-op - no different path, query,
 * fragment, scheme, port, hostname, or subdomain is ever affected, because
 * propagation is gated on exact pageKey equality.
 */
async function handleSavedPageLiveGain({ pageKey, gainPercent }) {
  await ensureReconciled();
  const clamped = clampGainPercent(gainPercent);
  if (clamped === null) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_MESSAGE, message: 'Invalid gain value.' } };
  }
  await propagateGainToSessionsSharingPageKey(pageKey, clamped);
  return { ok: true, data: { pageKey, gainPercent: clamped } };
}

/**
 * Registers `{operationId, pageKey:null, state:'resolving'}` in the cache
 * BEFORE resolving the tab's URL - specifically so a navigation/Stop/close
 * event arriving *during* the chrome.tabs.get call has something to
 * cancel. Returns the resolved pageKey on success, or a stale/error result
 * if the operation was cancelled or the URL could not be resolved.
 */
async function beginResolvingOperation(tabId) {
  const operationId = createRequestId();
  // The backend defaults to tab-capture and is upgraded to page-audio by
  // handleStartPageAudio once it owns this operation, so a session is never
  // left without an owning backend.
  sessions.set(tabId, {
    operationId,
    pageKey: null,
    state: 'resolving',
    gainPercent: DEFAULT_VOLUME_PERCENT,
    backend: BACKENDS.TAB_CAPTURE,
    startedAt: Date.now(),
  });

  function stillResolving() {
    const entry = sessions.get(tabId);
    return Boolean(entry) && entry.operationId === operationId && entry.state === 'resolving';
  }

  const resolved = await resolvePageKeyForTab(tabId);

  if (!stillResolving()) {
    return { ok: false, stale: true, operationId };
  }

  if (!resolved.ok) {
    sessions.delete(tabId);
    return { ok: false, stale: false, operationId, error: resolved.error };
  }

  const entry = sessions.get(tabId);
  entry.pageKey = resolved.pageKey;
  entry.state = 'starting';

  return { ok: true, operationId, pageKey: resolved.pageKey };
}

/**
 * Starts a temporary capture session for the current tab's exact page -
 * saved or not. There is no savedPages precondition here at all.
 *
 * `expectedPageKey` is the popup's last server-derived pageKey for this tab
 * (the exact page the click/slider interaction was observed on). It is
 * never trusted as URL authority: the resolving operation is registered
 * BEFORE chrome.tabs.get (so a navigation/Stop/close during that await can
 * still cancel it), the service worker derives the tab's actual current
 * canonical pageKey itself, and only then compares. A mismatch means the
 * tab navigated between the popup's last observed state and this call -
 * capture is aborted with PAGE_CHANGED, the just-registered resolving
 * operation is cancelled, and getMediaStreamId / the offscreen START_CAPTURE
 * are never reached. `initialGainPercent` (the user's current slider value,
 * or the displayed default/saved value for an Enable click) is clamped and
 * bound to this exact operationId as the session's starting gain - see
 * beginCaptureForPage.
 */
// ---------------------------------------------------------------------------
// Page-audio backend (fullscreen-compatible).
//
// Nothing in this section calls chrome.tabCapture or creates an offscreen
// document. Injection happens only from an explicit popup action, uses
// packaged files (never a generated code string), and the service worker stays
// the sole authority: a page reply can report its own state, but can never
// supply a tabId, pageKey, operationId, or permission decision.
// ---------------------------------------------------------------------------

const PAGE_AUDIO_BRIDGE_FILE = 'page-audio/page-audio-bridge.js';
const PAGE_AUDIO_CONTROLLER_FILE = 'page-audio/page-audio-controller.js';

/** Sends one narrow, validated command to a frame's bridge, always settling. */
async function sendPageAudioCommand(tabId, frameId, command) {
  const response = await withTimeout(
    (async () => {
      try {
        return await chrome.tabs.sendMessage(tabId, { target: 'page-audio', command }, { frameId });
      } catch {
        return null;
      }
    })(),
    PAGE_AUDIO_RESPONSE_TIMEOUT_MS
  );
  if (response === TIMEOUT_SENTINEL || !response) return { ok: false, reason: 'NO_RESPONSE' };
  return response;
}

/**
 * Lists the http/https frames of a tab that are worth trying to inject. Uses
 * webNavigation frame data (already permitted) rather than the tabs
 * permission, and never reads a URL for any tab other than the one the user
 * just acted on.
 */
async function listInjectableFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    if (!Array.isArray(frames)) return [{ frameId: 0, documentId: undefined }];
    return frames
      .filter((frame) => typeof frame.url === 'string' && /^https?:/i.test(frame.url))
      .map((frame) => ({ frameId: frame.frameId, documentId: frame.documentId }));
  } catch {
    // Fall back to the top frame, which activeTab always covers.
    return [{ frameId: 0, documentId: undefined }];
  }
}

/**
 * Installs the isolated bridge and the MAIN-world controller into one frame.
 * Both are packaged files; installation is idempotent on the page side, so a
 * repeat injection finds the existing controller instead of building a second
 * audio graph.
 */
async function injectPageAudioIntoFrame(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: [PAGE_AUDIO_BRIDGE_FILE],
    });
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      files: [PAGE_AUDIO_CONTROLLER_FILE],
    });
    return { ok: true };
  } catch (err) {
    // A frame this extension cannot script (a cross-origin player iframe with
    // no granted permission) is reported, never silently escalated.
    return { ok: false, reason: 'FRAME_NOT_ACCESSIBLE', message: err?.message ?? String(err) };
  }
}

/**
 * Starts the page-audio backend for a tab: inject every reachable http/https
 * frame, install the controller at the requested gain, and fold the per-frame
 * outcomes into one honest state. A page whose media cannot be safely routed
 * reports UNSUPPORTED_MEDIA with a reason - it never falls back on its own.
 */
async function activatePageAudio(tabId, operationToken, gainPercent) {
  const frames = await listInjectableFrames(tabId);

  // Every frame is injected and installed independently - a page with
  // several iframes (ads, a separate player frame, etc.) no longer pays for
  // each frame's injectScript + INSTALL round trip one at a time. Each task
  // only ever touches its own frameId's record in pageAudioFrames, which is
  // keyed per (tabId, frameId) and safe to write from concurrent tasks (see
  // shared/page-audio-session.js).
  const perFrameOutcomes = await Promise.all(
    frames.map(async ({ frameId, documentId }) => {
      const injected = await injectPageAudioIntoFrame(tabId, frameId);
      if (!injected.ok) return { inaccessible: true };

      const response = await sendPageAudioCommand(tabId, frameId, {
        type: BRIDGE_COMMANDS.INSTALL,
        operationToken,
        gainPercent,
      });
      if (!response.ok || !response.data) return { inaccessible: false };

      const data = response.data;
      pageAudioFrames.setFrame(tabId, frameId, {
        documentId,
        operationToken,
        state: data.state,
        gainPercent,
      });
      return { frameId, state: data.state, refusals: data.refusals ?? [] };
    })
  );

  const inaccessibleFrames = perFrameOutcomes.filter((outcome) => outcome.inaccessible === true).length;
  const results = perFrameOutcomes.filter((outcome) => outcome.frameId !== undefined);

  if (results.length === 0) {
    return {
      ok: false,
      state: inaccessibleFrames > 0 ? PAGE_AUDIO_STATES.PERMISSION_REQUIRED : PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA,
      reason:
        inaccessibleFrames > 0
          ? "This page's player is in a frame this extension cannot access."
          : 'No page audio engine could be installed on this page.',
    };
  }

  // Prefer the strongest outcome any frame achieved.
  const active = results.find((r) => r.state === PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA);
  if (active) return { ok: true, state: PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA };

  const armed = results.find((r) => r.state === PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA);
  if (armed) return { ok: true, state: PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA };

  const suspended = results.find((r) => r.state === PAGE_AUDIO_STATES.CONTEXT_SUSPENDED);
  if (suspended) return { ok: true, state: PAGE_AUDIO_STATES.CONTEXT_SUSPENDED };

  const refusal = results.flatMap((r) => r.refusals)[0] ?? null;
  return { ok: false, state: PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA, reason: describeRefusal(refusal) };
}

/** Applies a confirmed gain to every live frame of a page-audio session. */
async function setPageAudioGain(tabId, operationToken, gainPercent) {
  const frames = pageAudioFrames.listFramesForOperation(tabId, operationToken);
  const confirmations = await Promise.all(
    frames.map(async (frame) => {
      const response = await sendPageAudioCommand(tabId, frame.frameId, {
        type: BRIDGE_COMMANDS.SET_GAIN,
        operationToken,
        gainPercent,
      });
      if (response.ok && response.data && !response.data.rejected) {
        pageAudioFrames.updateFrameState(tabId, frame.frameId, operationToken, {
          gainPercent,
          state: response.data.state,
        });
        return true;
      }
      return false;
    })
  );
  return confirmations.some(Boolean);
}

/**
 * Disable for page-audio: return every frame to neutral gain (1.0) and drop
 * its observer, then forget the frames.
 *
 * The AudioContext is deliberately NOT closed. createMediaElementSource
 * permanently reroutes an element through its context for the document's
 * lifetime, so closing it would silence media that is still playing. Neutral
 * gain is audibly identical to the extension not being there, and every
 * page-side object becomes collectible when the document goes away.
 */
async function deactivatePageAudio(tabId, operationToken) {
  const frames = pageAudioFrames.listFramesForOperation(tabId, operationToken);
  // Per-frame order (reset before disposing that same frame's observer) is
  // preserved within each frame's own task; frames themselves are independent
  // and torn down concurrently.
  await Promise.all(
    frames.map(async (frame) => {
      await sendPageAudioCommand(tabId, frame.frameId, { type: BRIDGE_COMMANDS.RESET_TO_NEUTRAL, operationToken });
      await sendPageAudioCommand(tabId, frame.frameId, { type: BRIDGE_COMMANDS.DISPOSE_OBSERVERS, operationToken });
      pageAudioFrames.removeFrame(tabId, frame.frameId);
    })
  );
  return { ok: true };
}

/**
 * The ordinary Enable path. Registers a resolving operation first (so a
 * navigation during URL resolution can still cancel it), verifies the tab is
 * still on the exact page the popup acted on, then activates page-audio.
 * A failure here NEVER starts tabCapture - it returns a structured reason so
 * the popup can offer compatibility mode as a separate, deliberate choice.
 */
async function handleStartPageAudio({ tabId, expectedPageKey, initialGainPercent }) {
  await ensureReconciled();
  const existing = sessions.get(tabId);
  if (existing) {
    return { ok: true, data: { state: existing.state, backend: backendOf(existing) } };
  }

  const resolution = await beginResolvingOperation(tabId);
  if (!resolution.ok) {
    return resolution.stale ? staleResult() : { ok: false, error: resolution.error };
  }
  const { operationId, pageKey } = resolution;

  if (pageKey !== expectedPageKey) {
    const entry = sessions.get(tabId);
    if (entry && entry.operationId === operationId) sessions.delete(tabId);
    return { ok: false, error: { code: ERROR_CODES.PAGE_CHANGED, message: 'This page changed before boosting could start.' } };
  }

  const clamped = clampGainPercent(initialGainPercent) ?? DEFAULT_VOLUME_PERCENT;
  const entry = sessions.get(tabId);
  if (entry && entry.operationId === operationId) {
    entry.backend = BACKENDS.PAGE_AUDIO;
    entry.gainPercent = clamped;
  }

  const result = await activatePageAudio(tabId, operationId, clamped);

  const current = sessions.get(tabId);
  if (!current || current.operationId !== operationId) {
    // Superseded while injecting - undo whatever this operation installed.
    await deactivatePageAudio(tabId, operationId);
    return staleResult();
  }

  if (!result.ok) {
    sessions.delete(tabId);
    pageAudioFrames.removeTab(tabId);
    return {
      ok: false,
      error: { code: ERROR_CODES.PAGE_AUDIO_UNSUPPORTED, message: result.reason, pageAudioState: result.state },
    };
  }

  current.state = 'active';
  current.startedAt = Date.now();
  return { ok: true, data: { state: 'active', operationId, backend: BACKENDS.PAGE_AUDIO, pageAudioState: result.state } };
}

async function handleStartCapture({ tabId, expectedPageKey, initialGainPercent }) {
  await ensureReconciled();
  const existing = sessions.get(tabId);
  if (existing) {
    return { ok: true, data: { state: existing.state } };
  }

  const resolution = await beginResolvingOperation(tabId);
  if (!resolution.ok) {
    return resolution.stale ? staleResult() : { ok: false, error: resolution.error };
  }

  const { operationId, pageKey } = resolution;

  if (pageKey !== expectedPageKey) {
    // The tab shows a different exact page than the popup acted on - never
    // start capture on a page the user did not choose. Cancel the resolving/
    // starting operation we just registered (only if it is still ours), so
    // no getMediaStreamId or offscreen START_CAPTURE is ever attempted.
    const entry = sessions.get(tabId);
    if (entry && entry.operationId === operationId) sessions.delete(tabId);
    return { ok: false, error: { code: ERROR_CODES.PAGE_CHANGED, message: 'This page changed before boosting could start.' } };
  }

  const clampedInitial = clampGainPercent(initialGainPercent) ?? DEFAULT_VOLUME_PERCENT;
  const result = await beginCaptureForPage(tabId, pageKey, operationId, clampedInitial);
  if (!result.ok) return result;

  const entry = sessions.get(tabId);
  if (entry && entry.operationId === operationId) entry.state = 'active';
  return { ok: true, data: { state: 'active', operationId } };
}

async function handleStopCapture({ tabId }) {
  await ensureReconciled();
  const entry = sessions.get(tabId);
  if (!entry) return { ok: true, data: { state: 'inactive' } };
  // A normal, current-intent user action: uses this tab's exact current
  // operationId with force:false, exactly like every other lifecycle
  // trigger, so that a newer operation which has already superseded this
  // one on the same tabId (started right before this message was
  // processed) can never be disturbed by this Disable. force:true is
  // reserved for the emergency fail-closed path, where no operationId can
  // be trusted at all.
  const result = await requestOffscreenTeardown(tabId, {
    operationId: entry.operationId,
    force: false,
    reason: SESSION_STOP_REASONS.USER_DISABLED,
  });
  if (!result.ok) return result;
  return { ok: true, data: { state: 'inactive' } };
}

/**
 * `expectedOperationId` is the popup's last known operationId for this
 * tab (from GET_TAB_STATE/TAB_STATE_CHANGED) - required and checked
 * against the tab's actual current session so a message from a
 * superseded session generation (e.g. a delayed slider drag from before
 * the user disabled and re-enabled boosting) can never affect whichever
 * session is current now. Works identically for a temporary (unsaved)
 * session and a saved one - live gain is never gated by savedPages
 * membership, only by having a genuinely active session.
 */
async function handleSetTabGain({ tabId, gainPercent, expectedOperationId }) {
  await ensureReconciled();
  const entry = sessions.get(tabId);
  if (!entry || entry.state !== 'active' || entry.operationId !== expectedOperationId) {
    return { ok: false, error: { code: ERROR_CODES.NOT_ACTIVE, message: 'This tab is not currently being boosted.' } };
  }
  const operationId = entry.operationId;
  const clamped = clampGainPercent(gainPercent) ?? entry.gainPercent;

  // A page-audio session owns no offscreen graph: its gain lives in the
  // injected frame controllers. Route there instead, keeping the identical
  // "only a confirmed change updates the cache" contract.
  if (isPageAudioSession(entry)) {
    const confirmedInPage = await setPageAudioGain(tabId, operationId, clamped);
    if (!confirmedInPage) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not update the volume for this tab.' } };
    }
    const currentPage = sessions.get(tabId);
    if (currentPage && currentPage.operationId === operationId) {
      currentPage.gainPercent = clamped;
      broadcastSavedPageLiveGainToOptions(currentPage.pageKey, clamped);
    }
    return { ok: true, data: { tabId, gainPercent: clamped } };
  }

  // The local cache is the value the popup will read back on its next
  // GET_TAB_STATE - it must never claim a gain was applied that the
  // offscreen document did not positively confirm. Sent BEFORE any local
  // mutation; the cache is only updated afterward, and only if the
  // response is a confirmed match for this exact operationId/tabId/value.
  const response = await sendMessage(TARGETS.OFFSCREEN, MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: clamped,
    operationId,
  });
  const confirmed =
    Boolean(response) && response.ok === true && response.data?.tabId === tabId && response.data?.gainPercent === clamped;
  if (!confirmed) {
    return response?.ok === false
      ? response
      : { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'Could not update the volume for this tab.' } };
  }
  const current = sessions.get(tabId);
  if (current && current.operationId === operationId) {
    current.gainPercent = clamped;
    // The popup slider just drove this active session's live gain. Notify any
    // open Saved-pages view so the matching exact row's slider + percentage
    // move in real time - narrowly scoped to this session's immutable pageKey,
    // never persisting anything. A stale/unconfirmed response never reaches
    // here (the confirmation gate above already returned), so a Saved-pages
    // row is only ever moved by a live gain the offscreen document confirmed.
    broadcastSavedPageLiveGainToOptions(current.pageKey, clamped);
  }
  return { ok: true, data: { tabId, gainPercent: clamped } };
}

/**
 * Persists a slider value only for a tab that currently has an ACTIVE
 * session, only for the exact page that session's immutable pageKey names,
 * AND only if that exact page is saved - persistExistingVolumeIfPreconditionHolds
 * never creates a missing savedPages entry, so this is a harmless rejected
 * no-op both for an unsaved page (nothing to persist to) and for a delayed
 * message arriving after the page was removed, Clear all, a navigation, or
 * Stop. `expectedOperationId` additionally scopes this to the exact session
 * generation the popup last observed - see handleSetTabGain's doc comment
 * above for why.
 */
async function handlePersistPageVolume({ tabId, gainPercent, expectedOperationId }) {
  await ensureReconciled();
  const clamped = clampGainPercent(gainPercent);
  if (clamped === null) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_MESSAGE, message: 'Invalid gain value.' } };
  }

  const entry = sessions.get(tabId);
  if (!entry || entry.state !== 'active' || entry.operationId !== expectedOperationId) {
    return { ok: false, error: { code: ERROR_CODES.NOT_ACTIVE, message: 'This tab is not currently being boosted.' } };
  }

  const operationId = entry.operationId;
  const pageKey = entry.pageKey;

  function stillActiveForThisOperation() {
    const current = sessions.get(tabId);
    return (
      Boolean(current) && current.operationId === operationId && current.state === 'active' && current.pageKey === pageKey
    );
  }

  const result = await settingsStore.persistExistingVolumeIfPreconditionHolds(pageKey, clamped, stillActiveForThisOperation);

  if (result.aborted) {
    const notSaved = result.code === 'PAGE_NOT_SAVED';
    return {
      ok: false,
      error: notSaved
        ? { code: ERROR_CODES.PAGE_NOT_SAVED, message: 'This page is not saved.' }
        : { code: ERROR_CODES.NOT_ACTIVE, message: 'This tab is not currently being boosted.' },
    };
  }

  await propagateGainToSessionsSharingPageKey(pageKey, clamped);

  // After a successful storage commit, tell every open Saved-pages/options
  // view the authoritative new savedPages so the matching row slider and
  // percentage update without a manual reload. Exact-page-scoped: only this
  // one pageKey changed; no other saved URL is touched.
  broadcastSavedPagesChanged();

  return { ok: true, data: result };
}

async function handleSessionStopped({ tabId, operationId, reason }) {
  const entry = sessions.get(tabId);
  if (entry && entry.operationId === operationId) {
    sessions.delete(tabId);
  }
  broadcastTabState(tabId, { lastStopReason: reason });
  return { ok: true, data: {} };
}

async function handleSessionError({ tabId, operationId, code, message }) {
  const entry = sessions.get(tabId);
  if (entry && entry.operationId === operationId) {
    sessions.delete(tabId);
  }
  broadcastTabState(tabId, { errorCode: code, errorMessage: message });
  return { ok: true, data: {} };
}

async function handleMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.GET_TAB_STATE:
      return handleGetTabState(message.payload);
    case MESSAGE_TYPES.GET_SAVED_PAGES:
      return handleGetSavedPages();
    case MESSAGE_TYPES.ADD_CURRENT_PAGE:
      return handleAddCurrentPage(message.payload);
    case MESSAGE_TYPES.ADD_PAGE_MANUAL:
      return handleAddPageManual(message.payload);
    case MESSAGE_TYPES.REMOVE_SAVED_PAGE:
      return handleRemoveSavedPage(message.payload);
    case MESSAGE_TYPES.CLEAR_SAVED_PAGES:
      return handleClearSavedPages();
    case MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME:
      return handleUpdateSavedPageVolume(message.payload);
    case MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN:
      return handleSavedPageLiveGain(message.payload);
    case MESSAGE_TYPES.RENAME_SAVED_PAGE:
      return handleRenameSavedPage(message.payload);
    case MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100:
      return handleResetSelectedSavedPagesTo100(message.payload);
    case MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES:
      return handleDeleteSelectedSavedPages(message.payload);
    case MESSAGE_TYPES.START_PAGE_AUDIO:
      return handleStartPageAudio(message.payload);
    case MESSAGE_TYPES.START_CAPTURE:
      return handleStartCapture(message.payload);
    case MESSAGE_TYPES.STOP_CAPTURE:
      return handleStopCapture(message.payload);
    case MESSAGE_TYPES.SET_TAB_GAIN:
      return handleSetTabGain(message.payload);
    case MESSAGE_TYPES.PERSIST_PAGE_VOLUME:
      return handlePersistPageVolume(message.payload);
    case MESSAGE_TYPES.SESSION_STOPPED:
      return handleSessionStopped(message.payload);
    case MESSAGE_TYPES.SESSION_ERROR:
      return handleSessionError(message.payload);
    default:
      throw new HandlerError(ERROR_CODES.INVALID_MESSAGE, `Unknown message type: ${message.type}`);
  }
}

// An explicit, message-type-specific allowed-sender matrix - rather than
// accepting every regular command from either popup or options
// indiscriminately, each message type is mapped to the exact single
// context that protocol design ever legitimately sends it (see the
// popup.js/options.js message call sites). All three possible senders are
// real page/frame extension contexts, where Chrome's MessageSender.url is
// reliably present - unlike validateServiceWorkerOriginatedSender (used by
// offscreen.js/popup.js/options.js for the reverse direction), there is no
// bypass here for an absent url.
const POPUP_ONLY_MESSAGE_TYPES = new Set([
  MESSAGE_TYPES.GET_TAB_STATE,
  MESSAGE_TYPES.ADD_CURRENT_PAGE,
  MESSAGE_TYPES.ADD_PAGE_MANUAL,
  MESSAGE_TYPES.START_PAGE_AUDIO,
  MESSAGE_TYPES.START_CAPTURE,
  MESSAGE_TYPES.STOP_CAPTURE,
  MESSAGE_TYPES.SET_TAB_GAIN,
  MESSAGE_TYPES.PERSIST_PAGE_VOLUME,
]);
const OPTIONS_ONLY_MESSAGE_TYPES = new Set([
  MESSAGE_TYPES.GET_SAVED_PAGES,
  MESSAGE_TYPES.REMOVE_SAVED_PAGE,
  MESSAGE_TYPES.CLEAR_SAVED_PAGES,
  MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
  MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN,
  MESSAGE_TYPES.RENAME_SAVED_PAGE,
  MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100,
  MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES,
]);
const OFFSCREEN_ONLY_MESSAGE_TYPES = new Set([MESSAGE_TYPES.SESSION_STOPPED, MESSAGE_TYPES.SESSION_ERROR]);

function validateServiceWorkerSender(sender, message) {
  if (OFFSCREEN_ONLY_MESSAGE_TYPES.has(message.type)) {
    return validatePageContextSender(sender, TARGETS.OFFSCREEN);
  }
  if (POPUP_ONLY_MESSAGE_TYPES.has(message.type)) {
    return validatePageContextSender(sender, TARGETS.POPUP);
  }
  if (OPTIONS_ONLY_MESSAGE_TYPES.has(message.type)) {
    return validatePageContextSender(sender, TARGETS.OPTIONS);
  }
  // An unrecognized message type - validateMessage() already rejects these
  // before validateSender ever runs in practice, but fail closed regardless.
  return false;
}

registerMessageHandler(TARGETS.SERVICE_WORKER, handleMessage, { validateSender: validateServiceWorkerSender });

// ---------------------------------------------------------------------------
// Navigation / tab / capture-status listeners - all registered synchronously
// at module top level, per the Chrome extensions event-page/service-worker
// model, so Chrome can wake this worker for any of them. Each one operates
// generically on "does sessions.get(tabId) exist" without caring whether
// its state is 'resolving', 'starting', or 'active', or whether its pageKey
// is saved - all three states are cancellable in-progress-or-live states,
// and a temporary (unsaved) session is torn down exactly like a saved one.
// ---------------------------------------------------------------------------

async function handleFullNavigation(details) {
  // A subframe navigating destroys only that frame's page-audio controller.
  // The old document is gone, so its record must not survive to receive a
  // command intended for the document that replaced it.
  if (details.frameId !== 0) {
    pageAudioFrames.invalidateFrame(details.tabId, details.frameId);
    return;
  }
  await ensureReconciled();
  // A top-level navigation invalidates every frame record for the tab.
  pageAudioFrames.invalidateTab(details.tabId);
  const entry = sessions.get(details.tabId);
  if (!entry) {
    // No live session on this tab. If the page that just committed is one
    // the user saved a preferred volume for, re-apply that boost
    // automatically - this is what makes a saved page resume its volume
    // after a browser/PC restart, a plain reload, or being opened in a new
    // tab, without any popup interaction.
    await maybeAutoResumeSavedPage(details.tabId, details.url);
    return;
  }
  await requestOffscreenTeardown(details.tabId, {
    operationId: entry.operationId,
    reason: SESSION_STOP_REASONS.FULL_NAVIGATION,
  });
}

/**
 * Auto-resume for a freshly-committed top-level page: if the tab has no live
 * session and its exact URL matches a saved page, start the page-audio
 * backend at the saved volume. Only the page-audio (fullscreen-compatible)
 * backend can be resumed this way - tab capture requires a genuine user
 * gesture on every call and is deliberately never started here.
 *
 * Every failure is swallowed: a saved page whose media cannot be routed
 * (cross-origin without CORS, DRM, an inaccessible frame) must fail exactly
 * as silently as it would have if the user had never opened the popup. The
 * URL is only ever matched against locally saved pages via the single
 * canonical matcher; it is never transmitted or stored here.
 */
async function maybeAutoResumeSavedPage(tabId, url) {
  // Never fight an in-flight or already-live session on this tab.
  if (sessions.has(tabId)) return;
  if (typeof url !== 'string' || url === '') return;

  const result = canonicalizePageKey(url);
  if (!result.ok) return;

  const savedPages = await settingsStore.getSavedPages();
  const savedRecord = savedPages[result.pageKey];
  if (!savedRecord) return;

  // A navigation could have superseded this one while we read storage.
  if (sessions.has(tabId)) return;

  await handleStartPageAudio({
    tabId,
    expectedPageKey: result.pageKey,
    initialGainPercent: savedRecord.volumePercent,
  });
}

async function handleSameDocumentNavigation(details) {
  if (details.frameId !== 0) return;
  await ensureReconciled();
  const entry = sessions.get(details.tabId);
  if (!entry) return;
  // Same-document route changes keep the document (and therefore the page
  // controller) alive, so frame records survive here - only a genuine exact
  // pageKey change below tears the session down.
  if (entry.pageKey !== null) {
    const result = canonicalizePageKey(details.url);
    if (result.ok && result.pageKey === entry.pageKey) return;
  }
  await requestOffscreenTeardown(details.tabId, {
    operationId: entry.operationId,
    reason: SESSION_STOP_REASONS.SAME_DOCUMENT_PAGE_CHANGED,
  });
}

async function handleTabRemoved(tabId) {
  // A closed tab can hold no page-audio controller, so drop every record for
  // it unconditionally - the registry must never retain a dead tab.
  pageAudioFrames.removeTab(tabId);
  await ensureReconciled();
  const entry = sessions.get(tabId);
  if (!entry) return;
  await requestOffscreenTeardown(tabId, { operationId: entry.operationId, reason: SESSION_STOP_REASONS.TAB_CLOSED });
}

async function handleTabReplaced(removedTabId) {
  await ensureReconciled();
  const entry = sessions.get(removedTabId);
  if (!entry) return;
  await requestOffscreenTeardown(removedTabId, { operationId: entry.operationId, reason: SESSION_STOP_REASONS.REPLACED });
}

async function handleCaptureStatusChanged(info) {
  await ensureReconciled();
  const observedEntry = sessions.get(info.tabId);
  if (!observedEntry) return;
  const observedOperationId = observedEntry.operationId;

  if (info.status === 'active' || info.status === 'pending') {
    return; // purely informational
  }

  let capturedTabs = [];
  try {
    capturedTabs = await chrome.tabCapture.getCapturedTabs();
  } catch {
    capturedTabs = [];
  }

  const currentEntry = sessions.get(info.tabId);
  if (!currentEntry || currentEntry.operationId !== observedOperationId) {
    return; // stale - a newer operation has since started on this tab
  }

  const stillReportedLive = capturedTabs.some(
    (candidate) => candidate.tabId === info.tabId && (candidate.status === 'active' || candidate.status === 'pending')
  );
  if (stillReportedLive) return;

  await requestOffscreenTeardown(info.tabId, { operationId: currentEntry.operationId, reason: SESSION_STOP_REASONS.CLEANUP });
}

function reportListenerFailure(label, err) {
  console.warn(`[service-worker] ${label} failed:`, err?.message ?? err);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  handleFullNavigation(details).catch((err) => reportListenerFailure('onCommitted', err));
});

chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
  handleSameDocumentNavigation(details).catch((err) => reportListenerFailure('onHistoryStateUpdated', err));
});

chrome.webNavigation.onReferenceFragmentUpdated.addListener((details) => {
  handleSameDocumentNavigation(details).catch((err) => reportListenerFailure('onReferenceFragmentUpdated', err));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  handleTabRemoved(tabId).catch((err) => reportListenerFailure('tabs.onRemoved', err));
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  handleTabReplaced(removedTabId).catch((err) => reportListenerFailure('tabs.onReplaced', err));
});

chrome.tabCapture.onStatusChanged.addListener((info) => {
  handleCaptureStatusChanged(info).catch((err) => reportListenerFailure('tabCapture.onStatusChanged', err));
});

settingsStore.ensureStorageHardened();

/**
 * Test-only: resets internal singleton state between test runs. Not called
 * by any extension context - only by tests/service-worker-logic.test.js,
 * so each test group can rely on a fresh "first service-worker instance"
 * view of live-session state.
 */
export function __resetForTests() {
  sessions.clear();
  reconciliationPromise = null;
  reconciliationComplete = false;
  offscreenCreationPromise = null;
  offscreenResponseTimeoutMs = OFFSCREEN_RESPONSE_TIMEOUT_MS;
  pageAudioFrames.clear();
  inFlightCompatibilityOperations = 0;
  offscreenIdleCloser.cancel();
  offscreenIdleCloseDelayMs = OFFSCREEN_IDLE_CLOSE_MS;
}

/**
 * Test-only: shortens (or restores) the offscreen-response timeout so a
 * timeout-path test runs deterministically off a controlled value instead of
 * a multi-second real-wall-clock sleep. Never called by any extension context.
 */
export function __setOffscreenIdleCloseDelayForTests(ms) {
  offscreenIdleCloseDelayMs = typeof ms === 'number' && ms > 0 ? ms : OFFSCREEN_IDLE_CLOSE_MS;
}

/** Test-only: the derived runtime state Stage 2 asserts stays bounded. */
export function __getRuntimeStateForTests() {
  return {
    sessions: sessions.size,
    pageAudioFrames: pageAudioFrames.size(),
    inFlightCompatibilityOperations,
    offscreenIdleCloseScheduled: offscreenIdleCloser.isScheduled(),
    compatibilityIdle: compatibilityBackendIsIdle(),
  };
}

export function __setOffscreenResponseTimeoutForTests(ms) {
  offscreenResponseTimeoutMs = typeof ms === 'number' && ms > 0 ? ms : OFFSCREEN_RESPONSE_TIMEOUT_MS;
}
