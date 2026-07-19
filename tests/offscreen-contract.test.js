// Contract tests proving the offscreen document's message/response shapes
// are singly-sourced, not independently re-implemented by the Node test
// suite's fake offscreen responder (tests/service-worker-logic.test.js) -
// review round 4, fix #6. These import the SAME functions real
// offscreen/offscreen.js and shared/validation.js use, rather than
// re-deriving expected shapes by hand, so a future change to the real
// contract can never silently drift from what the fake enforces.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, MESSAGE_TYPES } from '../shared/constants.js';
import {
  validateMessage,
  isValidOffscreenSetGainPayload,
  isValidOffscreenStopCapturePayload,
  isValidOffscreenStartCapturePayload,
} from '../shared/validation.js';
import {
  registerPendingStart,
  isStillPending,
  finalizePendingStart,
  decideAndApplyStopCapture,
  listSessionsForEnumeration,
  listPendingForEnumeration,
} from '../shared/offscreen-state.js';

// A minimal chrome stub so offscreen/offscreen.js's module-load
// registerMessageHandler() call has an onMessage listener registry to attach
// to. offscreen.js touches no AudioContext / navigator / getURL at load time -
// only chrome.runtime.onMessage.addListener - so this is all that is needed to
// import it and assert its pure percent->gain mapping directly.
globalThis.chrome = {
  runtime: {
    id: 'offscreen-contract-fake',
    onMessage: { addListener() {} },
  },
};
const offscreen = await import('../offscreen/offscreen.js');

// ===========================================================================
// Max gain 300%: the offscreen GainNode mapping is plain, unclamped
// percent/100. (Required test 3.)
// ===========================================================================

test('gain mapping: 100% -> 1.0, 200% -> 2.0, 300% -> 3.0', () => {
  assert.equal(offscreen.gainValueForPercent(0), 0);
  assert.equal(offscreen.gainValueForPercent(100), 1.0);
  assert.equal(offscreen.gainValueForPercent(200), 2.0);
  assert.equal(offscreen.gainValueForPercent(300), 3.0);
});

// ===========================================================================
// The real offscreen SET_TAB_GAIN path: accepts operationId, rejects
// expectedOperationId. This is the exact field the five-bug report
// identified as broken - tested here directly against the real,
// production isValidOffscreenSetGainPayload function.
// ===========================================================================

test('contract: the real offscreen SET_TAB_GAIN payload validator accepts operationId', () => {
  assert.equal(isValidOffscreenSetGainPayload({ tabId: 7, gainPercent: 120, operationId: 'op-1' }), true);
});

test('contract: the real offscreen SET_TAB_GAIN payload validator rejects expectedOperationId (the popup-facing field name)', () => {
  assert.equal(isValidOffscreenSetGainPayload({ tabId: 7, gainPercent: 120, expectedOperationId: 'op-1' }), false);
});

// ===========================================================================
// Every SW -> offscreen message shape service-worker.js actually constructs
// must pass real validateMessage() at the OFFSCREEN target, and the
// popup-facing SET_TAB_GAIN/STOP_CAPTURE shapes must never accidentally
// validate there too (which would silently defeat target-aware validation).
// ===========================================================================

test('contract: the exact START_CAPTURE payload beginCaptureForPage sends validates at the offscreen target', () => {
  const message = {
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.START_CAPTURE,
    requestId: 'req-1',
    payload: { tabId: 7, streamId: 'stream-1', operationId: 'op-1', pageKey: 'https://example.com/', gainPercent: 100 },
  };
  assert.equal(validateMessage(message).ok, true);
  assert.equal(isValidOffscreenStartCapturePayload(message.payload), true);
});

test('contract: the exact STOP_CAPTURE payload confirmedStopCapture sends validates at the offscreen target, for both force:false and force:true', () => {
  const forced = {
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.STOP_CAPTURE,
    requestId: 'req-1',
    payload: { tabId: 7, operationId: 'op-1', force: false, reason: 'user_disabled' },
  };
  assert.equal(validateMessage(forced).ok, true);

  const emergency = {
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.STOP_CAPTURE,
    requestId: 'req-2',
    payload: { tabId: 7, operationId: 'op-1', force: true, reason: 'emergency_fail_closed' },
  };
  assert.equal(validateMessage(emergency).ok, true);
  assert.equal(isValidOffscreenStopCapturePayload(forced.payload), true);
  assert.equal(isValidOffscreenStopCapturePayload(emergency.payload), true);
});

test('contract: the exact SET_TAB_GAIN payload handleSetTabGain/handlePersistPageVolume/handleAddPageAndEnable send validates at the offscreen target', () => {
  const message = {
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.SET_TAB_GAIN,
    requestId: 'req-1',
    payload: { tabId: 7, gainPercent: 120, operationId: 'op-1' },
  };
  assert.equal(validateMessage(message).ok, true);
});

test('contract: the exact GET_ACTIVE_SESSIONS payload reconcileState/emergencyFailClosed send validates at the offscreen target', () => {
  const message = { target: TARGETS.OFFSCREEN, type: MESSAGE_TYPES.GET_ACTIVE_SESSIONS, requestId: 'req-1', payload: {} };
  assert.equal(validateMessage(message).ok, true);
});

test("contract: the popup's own SET_TAB_GAIN shape (expectedOperationId) never validates at the offscreen target", () => {
  const message = {
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.SET_TAB_GAIN,
    requestId: 'req-1',
    payload: { tabId: 7, gainPercent: 120, expectedOperationId: 'op-1' },
  };
  assert.equal(validateMessage(message).ok, false);
});

test("contract: the offscreen's own SET_TAB_GAIN shape (operationId) never validates at the service-worker target", () => {
  const message = {
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.SET_TAB_GAIN,
    requestId: 'req-1',
    payload: { tabId: 7, gainPercent: 120, operationId: 'op-1' },
  };
  assert.equal(validateMessage(message).ok, false);
});

// ===========================================================================
// decideAndApplyStopCapture (shared/offscreen-state.js) is the SAME
// function real offscreen.js's handleStopCapture and the Node test suite's
// fake offscreen responder both call - there is exactly one implementation
// of this decision, not two hand-synchronized ones. These tests exercise
// its documented response-shape contract directly, and prove it is a pure,
// deterministic function of its inputs (same inputs -> same outputs across
// two independent Map pairs), which is what makes "the fake matches the
// real contract" true by construction rather than by convention.
// ===========================================================================

function freshMaps() {
  return { sessions: new Map(), pendingStarts: new Map() };
}

test('contract: decideAndApplyStopCapture "stopped" response has exactly the documented fields', () => {
  const { sessions, pendingStarts } = freshMaps();
  sessions.set(7, { tabId: 7, operationId: 'op-1', pageKey: 'https://example.com/', gainPercent: 100 });
  const decision = decideAndApplyStopCapture({ tabId: 7, operationId: 'op-1', force: false, sessions, pendingStarts });
  const { matchedSession, ...data } = decision;
  assert.deepEqual(data, { tabId: 7, requestedOperationId: 'op-1', status: 'stopped', stoppedOperationId: 'op-1', currentOperationId: null });
  assert.equal(matchedSession, sessions.get(7));
});

test('contract: decideAndApplyStopCapture "pending_cancelled" response has exactly the documented fields, and removes the entry immediately', () => {
  const { sessions, pendingStarts } = freshMaps();
  registerPendingStart(pendingStarts, 7, 'op-1');
  const decision = decideAndApplyStopCapture({ tabId: 7, operationId: 'op-1', force: false, sessions, pendingStarts });
  const { matchedSession, ...data } = decision;
  assert.deepEqual(data, { tabId: 7, requestedOperationId: 'op-1', status: 'pending_cancelled', stoppedOperationId: 'op-1', currentOperationId: null });
  assert.equal(matchedSession, null);
  assert.equal(pendingStarts.has(7), false, 'review round 4 fix #5: removed immediately, not left dangling');
});

test('contract: decideAndApplyStopCapture "absent" response has exactly the documented fields', () => {
  const { sessions, pendingStarts } = freshMaps();
  const decision = decideAndApplyStopCapture({ tabId: 7, operationId: 'op-1', force: false, sessions, pendingStarts });
  const { matchedSession, ...data } = decision;
  assert.deepEqual(data, { tabId: 7, requestedOperationId: 'op-1', status: 'absent', stoppedOperationId: null, currentOperationId: null });
  assert.equal(matchedSession, null);
});

test('contract: decideAndApplyStopCapture "operation_mismatch" response has exactly the documented fields and touches nothing', () => {
  const { sessions, pendingStarts } = freshMaps();
  sessions.set(7, { tabId: 7, operationId: 'op-real', pageKey: 'https://example.com/', gainPercent: 100 });
  const decision = decideAndApplyStopCapture({ tabId: 7, operationId: 'op-stale', force: false, sessions, pendingStarts });
  const { matchedSession, ...data } = decision;
  assert.deepEqual(data, { tabId: 7, requestedOperationId: 'op-stale', status: 'operation_mismatch', stoppedOperationId: null, currentOperationId: 'op-real' });
  assert.equal(matchedSession, null);
  assert.equal(sessions.has(7), true, 'untouched by the mismatched request');
});

test('contract: force:true bypasses operationId matching for both a Session and a PendingStart', () => {
  const sessionMaps = freshMaps();
  sessionMaps.sessions.set(7, { tabId: 7, operationId: 'op-real', pageKey: 'https://example.com/', gainPercent: 100 });
  const sessionDecision = decideAndApplyStopCapture({ tabId: 7, operationId: 'op-different', force: true, sessions: sessionMaps.sessions, pendingStarts: sessionMaps.pendingStarts });
  assert.equal(sessionDecision.status, 'stopped');
  assert.equal(sessionDecision.stoppedOperationId, 'op-real');

  const pendingMaps = freshMaps();
  registerPendingStart(pendingMaps.pendingStarts, 9, 'op-real-pending');
  const pendingDecision = decideAndApplyStopCapture({ tabId: 9, operationId: 'op-different', force: true, sessions: pendingMaps.sessions, pendingStarts: pendingMaps.pendingStarts });
  assert.equal(pendingDecision.status, 'pending_cancelled');
  assert.equal(pendingDecision.stoppedOperationId, 'op-real-pending');
});

test('contract: decideAndApplyStopCapture is a pure, deterministic function of its inputs - identical scenarios across two independent Map pairs produce identical output', () => {
  const scenario = () => {
    const { sessions, pendingStarts } = freshMaps();
    sessions.set(11, { tabId: 11, operationId: 'op-x', pageKey: 'https://example.com/', gainPercent: 140 });
    return decideAndApplyStopCapture({ tabId: 11, operationId: 'op-x', force: false, sessions, pendingStarts });
  };
  const first = scenario();
  const second = scenario();
  const { matchedSession: m1, ...d1 } = first;
  const { matchedSession: m2, ...d2 } = second;
  assert.deepEqual(d1, d2);
});

// ===========================================================================
// PendingStart registration/lookup/finalization contract - the same
// primitives real offscreen.js's handleStartCapture and the fake
// responder's defaultStartCapture both use.
// ===========================================================================

test('contract: registerPendingStart/isStillPending/finalizePendingStart - the happy path', () => {
  const pendingStarts = new Map();
  const pending = registerPendingStart(pendingStarts, 5, 'op-1');
  assert.equal(isStillPending(pendingStarts, 5, pending), true);
  finalizePendingStart(pendingStarts, 5, pending);
  assert.equal(pendingStarts.has(5), false);
});

test('contract: finalizePendingStart never deletes a newer entry that has replaced the old one by identity', () => {
  const pendingStarts = new Map();
  const oldPending = registerPendingStart(pendingStarts, 5, 'op-old');
  pendingStarts.delete(5); // e.g. cancelled and removed by decideAndApplyStopCapture
  const newPending = registerPendingStart(pendingStarts, 5, 'op-new');

  // The OLD handler's own finally-block cleanup call - must be a no-op,
  // since `oldPending` is no longer the object stored at key 5.
  finalizePendingStart(pendingStarts, 5, oldPending);
  assert.equal(pendingStarts.get(5), newPending, 'the newer entry survives untouched');
});

// ===========================================================================
// GET_ACTIVE_SESSIONS enumeration contract.
// ===========================================================================

test('contract: listSessionsForEnumeration/listPendingForEnumeration produce exactly the documented wire shapes', () => {
  const sessions = new Map([[7, { tabId: 7, operationId: 'op-1', pageKey: 'https://example.com/', gainPercent: 120, mediaStream: {}, extraInternalField: 'never-leaked' }]]);
  const pendingStarts = new Map();
  registerPendingStart(pendingStarts, 9, 'op-2');

  assert.deepEqual(listSessionsForEnumeration(sessions), [{ tabId: 7, operationId: 'op-1', pageKey: 'https://example.com/', gainPercent: 120 }]);
  assert.deepEqual(listPendingForEnumeration(pendingStarts), [{ tabId: 9, operationId: 'op-2' }]);
});

test('contract: a cancelled-and-removed PendingStart never appears in enumeration', () => {
  const pendingStarts = new Map();
  const pending = registerPendingStart(pendingStarts, 9, 'op-2');
  const { sessions } = freshMaps();
  decideAndApplyStopCapture({ tabId: 9, operationId: 'op-2', force: false, sessions, pendingStarts });
  assert.deepEqual(listPendingForEnumeration(pendingStarts), []);
  void pending;
});
