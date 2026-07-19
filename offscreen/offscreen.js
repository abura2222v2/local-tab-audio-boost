// The only context that owns live audio objects: one shared AudioContext
// and a Map<tabId, Session>. Never reads or writes chrome.storage.local,
// never evaluates saved-page policy, and contains no timer or polling loop
// of any kind.

import { TARGETS, MESSAGE_TYPES, ERROR_CODES } from '../shared/constants.js';
import { registerMessageHandler, sendMessage, HandlerError, validateServiceWorkerOriginatedSender } from '../shared/messages.js';
import {
  isValidOffscreenStartCapturePayload,
  isValidOffscreenStopCapturePayload,
  isValidOffscreenSetGainPayload,
  clampGainPercent,
} from '../shared/validation.js';
import { canonicalizePageKey } from '../shared/urls.js';
import {
  registerPendingStart,
  isStillPending,
  finalizePendingStart,
  decideAndApplyStopCapture,
  listSessionsForEnumeration,
  listPendingForEnumeration,
} from '../shared/offscreen-state.js';

/**
 * @typedef {Object} Session
 * @property {number} tabId
 * @property {string} operationId
 * @property {string} pageKey immutable for the session's lifetime
 * @property {number} gainPercent
 * @property {MediaStream} mediaStream
 * @property {MediaStreamAudioSourceNode} sourceNode
 * @property {GainNode} gainNode
 * @property {{track: MediaStreamTrack, listener: () => void}[]} trackListenerRecords
 */

/** @type {Map<number, Session>} */
const sessions = new Map();

/**
 * @typedef {Object} PendingStart
 * @property {number} tabId
 * @property {string} operationId
 * @property {boolean} cancelled
 */

// Registered synchronously, before the first await in handleStartCapture -
// specifically so an operation-scoped STOP_CAPTURE arriving while
// getUserMedia()/graph construction is still in flight (no real Session
// exists yet) has something concrete to find and cancel, instead of seeing
// nothing at all and reporting a misleading "already stopped."
/** @type {Map<number, PendingStart>} */
const pendingStarts = new Map();

let audioContext = null;

function ensureAudioContext() {
  if (!audioContext || audioContext.state === 'closed') {
    audioContext = new AudioContext();
  }
  return audioContext;
}

async function suspendAudioContextIfIdle() {
  if (sessions.size === 0 && pendingStarts.size === 0 && audioContext && audioContext.state === 'running') {
    try {
      await audioContext.suspend();
    } catch {
      // Best-effort - nothing more can be done if this fails.
    }
  }
}

// Exported so the linear, unclamped percent->GainNode.gain mapping (100% =
// 1.0, 200% = 2.0, 300% = 3.0) can be asserted directly in a Node test.
export function gainValueForPercent(gainPercent) {
  return gainPercent / 100;
}

function stopAllTracks(mediaStream) {
  for (const track of mediaStream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Best-effort.
    }
  }
}

/**
 * One idempotent teardown path, safe to call repeatedly, safe against a
 * partially-started session, and safe regardless of how many tracks the
 * underlying MediaStream has (including zero). `force: true` bypasses
 * operationId matching and is reserved for the service worker's emergency
 * fail-closed sweep alone; every ordinary trigger - including an explicit
 * user Disable - passes the specific operationId it believes is current
 * (force:false), so the request is only honored if it targets the
 * operationId this session actually holds, and a stale request can never
 * disturb a newer session occupying the same tabId.
 */
async function teardownSession(tabId, { force = false, operationId } = {}) {
  const session = sessions.get(tabId);
  if (!session) return { existed: false };
  if (!force && operationId && session.operationId !== operationId) {
    return { existed: false, mismatched: true };
  }

  for (const track of session.mediaStream.getTracks()) {
    const record = session.trackListenerRecords.find((entry) => entry.track === track);
    if (record) {
      try {
        record.track.removeEventListener('ended', record.listener);
      } catch {
        // Best-effort.
      }
    }
    try {
      track.stop();
    } catch {
      // Best-effort.
    }
  }

  try {
    session.sourceNode.disconnect();
  } catch {
    // Best-effort - already disconnected is a safe no-op in practice.
  }
  try {
    session.gainNode.disconnect();
  } catch {
    // Best-effort.
  }

  sessions.delete(tabId);
  await suspendAudioContextIfIdle();
  return { existed: true, operationId: session.operationId };
}

function handleTrackEnded(tabId, operationId) {
  const session = sessions.get(tabId);
  if (!session || session.operationId !== operationId) return;
  teardownSession(tabId, { operationId }).then(() => {
    sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.SESSION_ERROR, {
      tabId,
      operationId,
      code: ERROR_CODES.CAPTURE_FAILED,
      message: 'Audio capture stopped unexpectedly.',
    }).catch(() => {});
  });
}

async function handleStartCapture(payload) {
  if (!isValidOffscreenStartCapturePayload(payload)) {
    throw new HandlerError(ERROR_CODES.INVALID_MESSAGE, 'Invalid START_CAPTURE payload.');
  }
  const { tabId, streamId, operationId, pageKey, gainPercent } = payload;

  if (sessions.has(tabId) || pendingStarts.has(tabId)) {
    throw new HandlerError(ERROR_CODES.ALREADY_IN_PROGRESS, 'A session already exists for this tab.');
  }

  // Defense in depth: never trust the service worker's pageKey unconditionally.
  const pageKeyResult = canonicalizePageKey(pageKey);
  if (!pageKeyResult.ok || pageKeyResult.pageKey !== pageKey) {
    throw new HandlerError(ERROR_CODES.INVALID_MESSAGE, 'Invalid pageKey.');
  }

  // Registered synchronously, before the first await, so an operation-
  // scoped STOP_CAPTURE arriving during getUserMedia()/graph construction
  // finds something real to cancel (see PendingStart's own doc comment).
  const pending = registerPendingStart(pendingStarts, tabId, operationId);

  function stillPending() {
    return isStillPending(pendingStarts, tabId, pending);
  }

  function cancelledError() {
    return new HandlerError(ERROR_CODES.ALREADY_IN_PROGRESS, 'This operation was cancelled before capture completed.');
  }

  try {
    const context = ensureAudioContext();
    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        throw new HandlerError(ERROR_CODES.CAPTURE_FAILED, 'Could not resume the audio engine.');
      }
    }
    if (!stillPending()) {
      throw cancelledError();
    }

    let mediaStream;
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: {
            chromeMediaSource: 'tab',
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      });
    } catch {
      throw new HandlerError(ERROR_CODES.CAPTURE_FAILED, 'Could not obtain the tab audio stream.');
    }

    if (!stillPending() || sessions.has(tabId)) {
      // Cancelled (timeout, navigation, Stop, Disable, Remove, or emergency
      // fail-closed) while getUserMedia was in flight - never insert the
      // active Session. Every track this abandoned MediaStream holds is
      // stopped immediately; nothing is left running unaccounted for.
      stopAllTracks(mediaStream);
      throw cancelledError();
    }

    let sourceNode;
    let gainNode;
    try {
      sourceNode = context.createMediaStreamSource(mediaStream);
      gainNode = context.createGain();
      gainNode.gain.value = gainValueForPercent(gainPercent);
      sourceNode.connect(gainNode);
      gainNode.connect(context.destination);
    } catch {
      stopAllTracks(mediaStream);
      throw new HandlerError(ERROR_CODES.CAPTURE_FAILED, 'Could not build the audio graph.');
    }

    if (!stillPending()) {
      // No further await happens between graph construction and here, so
      // this cannot actually be reached in practice - kept for defense in
      // depth and to make every boundary uniformly guarded.
      try {
        sourceNode.disconnect();
      } catch {
        // Best-effort.
      }
      try {
        gainNode.disconnect();
      } catch {
        // Best-effort.
      }
      stopAllTracks(mediaStream);
      throw cancelledError();
    }

    const trackListenerRecords = mediaStream.getTracks().map((track) => {
      const listener = () => handleTrackEnded(tabId, operationId);
      track.addEventListener('ended', listener);
      return { track, listener };
    });

    sessions.set(tabId, {
      tabId,
      operationId,
      pageKey,
      gainPercent,
      mediaStream,
      sourceNode,
      gainNode,
      trackListenerRecords,
    });

    return { ok: true, data: { tabId, operationId } };
  } finally {
    // Terminal on every path, success or failure - a real Session, if one
    // was created, now lives in `sessions` instead, and this PendingStart's
    // job is done either way. A no-op if a STOP_CAPTURE already cancelled
    // and removed this exact object (see decideAndApplyStopCapture) - the
    // identity check inside finalizePendingStart is what prevents this from
    // ever deleting a newer, unrelated PendingStart that has since taken
    // this same tabId key.
    finalizePendingStart(pendingStarts, tabId, pending);
  }
}

/**
 * The response's `data` explicitly proves what actually happened, rather
 * than the bare `{tabId}` this used to return regardless of outcome -
 * that older shape let a same-tabId operationId mismatch (a stale request
 * arriving after a newer, different operation already occupies this
 * tabId) look identical to a genuine confirmed stop, since both returned
 * `ok:true`. The service worker's own confirmedStopCapture() (in
 * service-worker.js) treats only `stopped`/`pending_cancelled`/`absent`
 * as positive confirmation; `operation_mismatch` is deliberately never
 * treated as confirmation there.
 *
 *  - 'stopped': the exact active Session for this operationId was torn down.
 *  - 'pending_cancelled': the exact PendingStart for this operationId was cancelled.
 *  - 'absent': there was no active or pending operation for this tabId at all.
 *  - 'operation_mismatch': a *different* operation currently owns this tabId
 *    (Session or PendingStart) - force:false and this request's operationId
 *    did not match it, so nothing was touched.
 */
async function handleStopCapture(payload) {
  if (!isValidOffscreenStopCapturePayload(payload)) {
    throw new HandlerError(ERROR_CODES.INVALID_MESSAGE, 'Invalid STOP_CAPTURE payload.');
  }
  const { tabId, operationId, reason } = payload;
  const forced = payload.force === true;

  // decideAndApplyStopCapture (shared/offscreen-state.js) is the single,
  // shared source of truth for this decision - the Node test suite's fake
  // offscreen responder uses the exact same function, so the two can never
  // silently diverge in what counts as a match, a mismatch, or an absent
  // target. It fully resolves a matched PendingStart (cancels AND removes
  // it immediately - see review round 4, fix #5) but only ever *describes*
  // a matched Session via `matchedSession`, since tearing one down is an
  // async, real-audio-graph operation only this module can perform.
  const decision = decideAndApplyStopCapture({ tabId, operationId, force: forced, sessions, pendingStarts });

  if (decision.status === 'stopped' && decision.matchedSession) {
    const result = await teardownSession(tabId, { force: forced, operationId });
    // `result.existed` must be true here - decideAndApplyStopCapture's own
    // match check above already confirmed either an exact operationId
    // match or force:true, and nothing else can run concurrently between
    // that check and this call (no await between them).
    if (result.existed) {
      sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.SESSION_STOPPED, {
        tabId,
        operationId: result.operationId,
        reason: reason ?? 'cleanup',
      }).catch(() => {});
    }
  }

  const { matchedSession, ...responseData } = decision;
  return { ok: true, data: responseData };
}

async function handleSetTabGain(payload) {
  if (!isValidOffscreenSetGainPayload(payload)) {
    throw new HandlerError(ERROR_CODES.INVALID_MESSAGE, 'Invalid SET_TAB_GAIN payload.');
  }
  const { tabId, operationId } = payload;
  const clamped = clampGainPercent(payload.gainPercent);
  const session = sessions.get(tabId);
  // Defense in depth, mirroring the operationId scoping already enforced
  // for START_CAPTURE/STOP_CAPTURE: a gain command aimed at a superseded
  // session generation must never be applied to whichever session
  // currently occupies this tabId.
  if (!session || clamped === null || session.operationId !== operationId) {
    throw new HandlerError(ERROR_CODES.NOT_ACTIVE, 'No active session for this tab.');
  }
  const context = ensureAudioContext();
  // A short ramp avoids audible clicks/zipper noise - not dynamics
  // processing, just an anti-click ramp on the one AudioParam that exists.
  session.gainNode.gain.setTargetAtTime(gainValueForPercent(clamped), context.currentTime, 0.01);
  session.gainPercent = clamped;
  return { ok: true, data: { tabId, gainPercent: clamped } };
}

/**
 * `pending` accounts for in-flight PendingStarts alongside real Sessions,
 * so the service worker's emergency fail-closed sweep (and, per review
 * round 4 fix #2, ordinary cold-start reconciliation) can positively
 * cancel an operation that is still stuck inside getUserMedia() - not
 * just ones that already completed and became a Session. A cancelled
 * PendingStart is never present here at all, since decideAndApplyStopCapture
 * removes it from `pendingStarts` the instant it is cancelled.
 */
async function handleGetActiveSessions() {
  return {
    ok: true,
    data: {
      sessions: listSessionsForEnumeration(sessions),
      pending: listPendingForEnumeration(pendingStarts),
    },
  };
}

async function handleMessage(message) {
  switch (message.type) {
    case MESSAGE_TYPES.START_CAPTURE:
      return handleStartCapture(message.payload);
    case MESSAGE_TYPES.STOP_CAPTURE:
      return handleStopCapture(message.payload);
    case MESSAGE_TYPES.SET_TAB_GAIN:
      return handleSetTabGain(message.payload);
    case MESSAGE_TYPES.GET_ACTIVE_SESSIONS:
      return handleGetActiveSessions();
    default:
      throw new HandlerError(ERROR_CODES.INVALID_MESSAGE, `Unknown message type: ${message.type}`);
  }
}

// Only the service worker ever sends a message addressed to this
// document - see validateServiceWorkerOriginatedSender's own doc comment
// in shared/messages.js for exactly what is and isn't trusted here.
registerMessageHandler(TARGETS.OFFSCREEN, handleMessage, { validateSender: validateServiceWorkerOriginatedSender });
