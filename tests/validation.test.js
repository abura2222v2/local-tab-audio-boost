import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidTarget,
  isValidMessageType,
  isValidTabId,
  isValidGainPercent,
  clampGainPercent,
  validateMessage,
  normalizeSavedPages,
  isNonEmptyString,
  isValidOffscreenSetGainPayload,
  isValidOffscreenStopCapturePayload,
  isValidOffscreenStartCapturePayload,
} from '../shared/validation.js';
import { TARGETS, MESSAGE_TYPES, SESSION_STOP_REASONS, MAX_GAIN_PERCENT } from '../shared/constants.js';

test('valid and invalid target', () => {
  assert.equal(isValidTarget(TARGETS.SERVICE_WORKER), true);
  assert.equal(isValidTarget('nonsense'), false);
  assert.equal(isValidTarget(undefined), false);
});

test('valid and invalid message type', () => {
  assert.equal(isValidMessageType(MESSAGE_TYPES.START_CAPTURE), true);
  assert.equal(isValidMessageType('NOT_A_TYPE'), false);
});

test('valid and invalid tabId', () => {
  assert.equal(isValidTabId(42), true);
  assert.equal(isValidTabId(0), false);
  assert.equal(isValidTabId(-1), false);
  assert.equal(isValidTabId(1.5), false);
  assert.equal(isValidTabId('42'), false);
});

test('gain clamping honors the documented 0-300 boundary', () => {
  assert.equal(clampGainPercent(-50), 0);
  assert.equal(clampGainPercent(500), 300);
  assert.equal(clampGainPercent(300), 300); // 300 is exactly the max, unchanged
  assert.equal(clampGainPercent(150.4), 150);
  assert.equal(clampGainPercent(Number.NaN), null);
  assert.equal(clampGainPercent('100'), null);
});

test('isValidGainPercent enforces integer bounds (0-300)', () => {
  assert.equal(isValidGainPercent(0), true);
  assert.equal(isValidGainPercent(300), true);
  assert.equal(isValidGainPercent(301), false);
  assert.equal(isValidGainPercent(-1), false);
  assert.equal(isValidGainPercent(50.5), false);
});

// ===========================================================================
// Max gain 300%: the single MAX_GAIN_PERCENT constant is the authority, and
// every validator/clamp tracks it. (Required tests 1 & 2.)
// ===========================================================================

test('max-gain: MAX_GAIN_PERCENT is 300 and 300% passes validation', () => {
  assert.equal(MAX_GAIN_PERCENT, 300);
  assert.equal(isValidGainPercent(MAX_GAIN_PERCENT), true);
  assert.equal(isValidGainPercent(300), true);
});

test('max-gain: values above 300 clamp to 300 (clampGainPercent) or reject (isValidGainPercent), per the existing contract', () => {
  assert.equal(clampGainPercent(301), 300);
  assert.equal(clampGainPercent(1000), 300);
  assert.equal(isValidGainPercent(301), false);
  assert.equal(isValidGainPercent(400), false);
});

test('max-gain: the offscreen SET_TAB_GAIN payload validator (typeof number only) accepts 300, and a full-range START_CAPTURE payload with gainPercent 300 validates', () => {
  assert.equal(isValidOffscreenSetGainPayload({ tabId: 7, gainPercent: 300, operationId: 'op-1' }), true);
  assert.equal(isValidOffscreenStartCapturePayload({ tabId: 7, streamId: 's', operationId: 'op', pageKey: 'https://e.example/', gainPercent: 300 }), true);
  // 400 is out of the integer range for the START_CAPTURE offscreen payload.
  assert.equal(isValidOffscreenStartCapturePayload({ tabId: 7, streamId: 's', operationId: 'op', pageKey: 'https://e.example/', gainPercent: 400 }), false);
});

test('validateMessage rejects a malformed pageKey payload', () => {
  const message = {
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.REMOVE_SAVED_PAGE,
    requestId: 'id-1',
    payload: { pageKey: '' },
  };
  assert.equal(validateMessage(message).ok, false);
});

test('validateMessage accepts a well-formed message', () => {
  const message = {
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.GET_TAB_STATE,
    requestId: 'id-1',
    payload: { tabId: 7 },
  };
  assert.equal(validateMessage(message).ok, true);
});

test('validateMessage rejects an unknown type', () => {
  const message = { target: TARGETS.SERVICE_WORKER, type: 'BOGUS', requestId: 'id-1', payload: {} };
  assert.equal(validateMessage(message).ok, false);
});

test('validateMessage rejects a missing requestId', () => {
  const message = { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.GET_SAVED_PAGES, payload: {} };
  assert.equal(validateMessage(message).ok, false);
});

test('validateMessage rejects a non-object message', () => {
  assert.equal(validateMessage(null).ok, false);
  assert.equal(validateMessage('hello').ok, false);
});

/**
 * Schema 6: every surviving value is a record. A bare number (schema 5) is
 * migrated in place to a record with empty metadata.
 */
const rec = (volumePercent, titleSnapshot = '', customName = '') => ({ volumePercent, titleSnapshot, customName });

test('normalizeSavedPages recovers malformed storage safely', () => {
  assert.deepEqual(normalizeSavedPages(null), {});
  assert.deepEqual(normalizeSavedPages(undefined), {});
  assert.deepEqual(normalizeSavedPages([1, 2, 3]), {});
  assert.deepEqual(
    normalizeSavedPages({ 'https://a.example/': 100, 'https://b.example/': 999, bad: 'x', '': 50 }),
    { 'https://a.example/': rec(100) }
  );
});

test('schema6: a schema-5 bare number migrates to a full record with empty metadata', () => {
  assert.deepEqual(normalizeSavedPages({ 'https://a.example/': 209 }), { 'https://a.example/': rec(209) });
});

test('schema6: an existing valid record survives normalization intact', () => {
  const input = { 'https://a.example/': { volumePercent: 175, titleSnapshot: 'My title', customName: 'Nick' } };
  assert.deepEqual(normalizeSavedPages(input), { 'https://a.example/': rec(175, 'My title', 'Nick') });
});

test('schema6: unrecognized record properties are dropped, never trusted', () => {
  const input = {
    'https://a.example/': { volumePercent: 150, titleSnapshot: 'T', customName: 'C', evil: 'x', schemaVersion: 99 },
  };
  const result = normalizeSavedPages(input);
  assert.deepEqual(Object.keys(result['https://a.example/']).sort(), ['customName', 'titleSnapshot', 'volumePercent']);
});

test('schema6: invalid metadata types normalize to empty strings; an invalid volume drops the record', () => {
  const result = normalizeSavedPages({
    'https://ok.example/': { volumePercent: 120, titleSnapshot: 42, customName: { nope: true } },
    'https://bad-volume.example/': { volumePercent: 999, titleSnapshot: 'x', customName: '' },
    'https://non-integer.example/': { volumePercent: 120.5, titleSnapshot: '', customName: '' },
    'https://not-an-object.example/': 'nope',
  });
  assert.deepEqual(result, { 'https://ok.example/': rec(120) });
});

// ===========================================================================
// r5 issue #6: every stored/migrated savedPages key must pass the single
// canonical matcher (canonicalizePageKey) and be retained only in canonical
// form - unsupported, restricted, credentialed, and malformed URLs are
// dropped; equivalent forms collapse deterministically; distinct
// path/query/fragment stay separate.
// ===========================================================================

test('r5-6: a non-URL key ("not a URL") is dropped', () => {
  assert.deepEqual(normalizeSavedPages({ 'not a URL': 100 }), {});
});

test('r5-6: a restricted Chrome Web Store URL key is dropped', () => {
  assert.deepEqual(normalizeSavedPages({ 'https://chromewebstore.google.com/detail/x': 100 }), {});
  assert.deepEqual(normalizeSavedPages({ 'https://chrome.google.com/webstore/detail/x': 100 }), {});
});

test('r5-6: a credentialed URL key is dropped', () => {
  assert.deepEqual(normalizeSavedPages({ 'https://user:pass@example.com/': 100 }), {});
});

test('r5-6: an unsupported-scheme key is dropped', () => {
  assert.deepEqual(normalizeSavedPages({ 'ftp://example.com/file': 100 }), {});
  assert.deepEqual(normalizeSavedPages({ 'chrome://settings/': 100 }), {});
});

test('r5-6: a valid exact URL and percentage survive unchanged', () => {
  assert.deepEqual(normalizeSavedPages({ 'https://a.example/path?q=1#f': 175 }), { 'https://a.example/path?q=1#f': rec(175) });
});

test('r5-6: equivalent default-port / hostname-case forms normalize deterministically onto one canonical key', () => {
  const result = normalizeSavedPages({ 'https://example.com:443/': 120, 'https://EXAMPLE.com/': 150 });
  // Both canonicalize to https://example.com/ ; exactly one key survives, and
  // the first one encountered (the :443 form) deterministically wins.
  assert.deepEqual(Object.keys(result), ['https://example.com/']);
  assert.equal(result['https://example.com/'].volumePercent, 120);
});

test('r5-6: distinct path / query / fragment forms remain separate keys', () => {
  const result = normalizeSavedPages({
    'https://a.example/one': 100,
    'https://a.example/two': 110,
    'https://a.example/one?x=1': 120,
    'https://a.example/one#frag': 130,
  });
  assert.deepEqual(result, {
    'https://a.example/one': rec(100),
    'https://a.example/two': rec(110),
    'https://a.example/one?x=1': rec(120),
    'https://a.example/one#frag': rec(130),
  });
});

test('isNonEmptyString', () => {
  assert.equal(isNonEmptyString('x'), true);
  assert.equal(isNonEmptyString(''), false);
  assert.equal(isNonEmptyString(5), false);
});

// ===========================================================================
// Review round 4, fix #1: payload validation must be keyed by BOTH target
// and type - SET_TAB_GAIN carries a genuinely different shape depending on
// whether it is addressed to the service worker (popup's expectedOperationId)
// or the offscreen document (operationId). Before this fix, a single flat
// type-keyed map applied the popup-facing validator to EVERY SET_TAB_GAIN
// message regardless of target, which would have rejected the real
// service-worker -> offscreen SET_TAB_GAIN payload outright.
// ===========================================================================

function offscreenSetGainMessage(payload) {
  return { target: TARGETS.OFFSCREEN, type: MESSAGE_TYPES.SET_TAB_GAIN, requestId: 'req-1', payload };
}

function serviceWorkerSetGainMessage(payload) {
  return { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.SET_TAB_GAIN, requestId: 'req-1', payload };
}

test('r4fix1: the exact real service-worker -> offscreen SET_TAB_GAIN payload passes validation', () => {
  const message = offscreenSetGainMessage({ tabId: 7, gainPercent: 140, operationId: 'op-abc' });
  assert.equal(validateMessage(message).ok, true);
});

test('r4fix1: the exact real popup -> service-worker SET_TAB_GAIN payload passes validation', () => {
  const message = serviceWorkerSetGainMessage({ tabId: 7, gainPercent: 140, expectedOperationId: 'op-abc' });
  assert.equal(validateMessage(message).ok, true);
});

test('r4fix1: the offscreen-shaped SET_TAB_GAIN payload (operationId) is rejected when addressed to the service worker', () => {
  const message = serviceWorkerSetGainMessage({ tabId: 7, gainPercent: 140, operationId: 'op-abc' });
  assert.equal(validateMessage(message).ok, false);
});

test('r4fix1: the popup-shaped SET_TAB_GAIN payload (expectedOperationId) is rejected when addressed to the offscreen document', () => {
  const message = offscreenSetGainMessage({ tabId: 7, gainPercent: 140, expectedOperationId: 'op-abc' });
  assert.equal(validateMessage(message).ok, false);
});

test('r4fix1: offscreen-target SET_TAB_GAIN missing operationId entirely is rejected', () => {
  const message = offscreenSetGainMessage({ tabId: 7, gainPercent: 140 });
  assert.equal(validateMessage(message).ok, false);
  assert.equal(isValidOffscreenSetGainPayload({ tabId: 7, gainPercent: 140 }), false);
});

test('r4fix1: service-worker-target SET_TAB_GAIN missing expectedOperationId entirely is rejected', () => {
  const message = serviceWorkerSetGainMessage({ tabId: 7, gainPercent: 140 });
  assert.equal(validateMessage(message).ok, false);
});

test('r4fix1: START_CAPTURE/STOP_CAPTURE also carry target-specific shapes - the full offscreen START_CAPTURE payload validates only at the offscreen target', () => {
  const offscreenPayload = { tabId: 7, streamId: 's-1', operationId: 'op-abc', pageKey: 'https://example.com/', gainPercent: 100 };
  assert.equal(
    validateMessage({ target: TARGETS.OFFSCREEN, type: MESSAGE_TYPES.START_CAPTURE, requestId: 'r', payload: offscreenPayload }).ok,
    true
  );
  assert.equal(isValidOffscreenStartCapturePayload(offscreenPayload), true);
});

test('r4fix1: the service-worker-target STOP_CAPTURE shape ({tabId}) is exactly what popup.js sends', () => {
  assert.equal(
    validateMessage({ target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.STOP_CAPTURE, requestId: 'r', payload: { tabId: 7 } }).ok,
    true
  );
});

// ===========================================================================
// r5 issue #3: the service-worker START_CAPTURE payload now carries the
// popup's server-derived expectedPageKey plus the user's initialGainPercent,
// so a start can be scoped to the exact page the user acted on and can begin
// at exactly the slider value they chose.
// ===========================================================================

test('r5-3: the real popup -> service-worker START_CAPTURE payload (tabId + expectedPageKey + initialGainPercent) validates', () => {
  assert.equal(
    validateMessage({
      target: TARGETS.SERVICE_WORKER,
      type: MESSAGE_TYPES.START_CAPTURE,
      requestId: 'r',
      payload: { tabId: 7, expectedPageKey: 'https://example.com/', initialGainPercent: 150 },
    }).ok,
    true
  );
});

test('r5-3: a START_CAPTURE missing expectedPageKey is rejected', () => {
  assert.equal(
    validateMessage({
      target: TARGETS.SERVICE_WORKER,
      type: MESSAGE_TYPES.START_CAPTURE,
      requestId: 'r',
      payload: { tabId: 7, initialGainPercent: 150 },
    }).ok,
    false
  );
});

test('r5-3: a START_CAPTURE missing initialGainPercent (or with a non-numeric one) is rejected', () => {
  assert.equal(
    validateMessage({
      target: TARGETS.SERVICE_WORKER,
      type: MESSAGE_TYPES.START_CAPTURE,
      requestId: 'r',
      payload: { tabId: 7, expectedPageKey: 'https://example.com/' },
    }).ok,
    false
  );
  assert.equal(
    validateMessage({
      target: TARGETS.SERVICE_WORKER,
      type: MESSAGE_TYPES.START_CAPTURE,
      requestId: 'r',
      payload: { tabId: 7, expectedPageKey: 'https://example.com/', initialGainPercent: '150' },
    }).ok,
    false
  );
});

test('r5-3: the bare-{tabId} START_CAPTURE shape (the pre-r5 popup shape) is now rejected', () => {
  assert.equal(
    validateMessage({ target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.START_CAPTURE, requestId: 'r', payload: { tabId: 7 } }).ok,
    false
  );
});

test('r4fix1: GET_ACTIVE_SESSIONS is offscreen-only - an empty payload validates there', () => {
  assert.equal(
    validateMessage({ target: TARGETS.OFFSCREEN, type: MESSAGE_TYPES.GET_ACTIVE_SESSIONS, requestId: 'r', payload: {} }).ok,
    true
  );
});

// ===========================================================================
// Review round 4, fix #3 (payload half): isValidOffscreenStopCapturePayload
// must require operationId for force:false, reject a non-boolean `force`
// (never coerce an arbitrary value like the string "false"), and reject an
// unknown `reason`.
// ===========================================================================

test('r4fix3: force:false without operationId is rejected', () => {
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: false }), false);
});

test('r4fix3: force:false with a non-empty operationId is accepted', () => {
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: false, operationId: 'op-1' }), true);
});

test('r4fix3: force:true without operationId is accepted (the emergency sweep may not have one to give)', () => {
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: true }), true);
});

test('r4fix3: a non-boolean force (including the string "false") is rejected outright, never coerced', () => {
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: 'false', operationId: 'op-1' }), false);
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: 1, operationId: 'op-1' }), false);
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: 0, operationId: 'op-1' }), false);
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, force: null, operationId: 'op-1' }), false);
});

test('r4fix3: an unknown reason is rejected, but every real SESSION_STOP_REASONS value is accepted', () => {
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, operationId: 'op-1', reason: 'not-a-real-reason' }), false);
  for (const reason of Object.values(SESSION_STOP_REASONS)) {
    assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, operationId: 'op-1', reason }), true, `expected reason "${reason}" to be accepted`);
  }
});

test('r4fix3: reason is optional - omitting it entirely is still valid', () => {
  assert.equal(isValidOffscreenStopCapturePayload({ tabId: 7, operationId: 'op-1' }), true);
});

// ===========================================================================
// Product-model correction: saved-page-oriented message shapes. Saving a
// page is a stored preference, never a capture permission - none of these
// validators have anything to do with whether START_CAPTURE is allowed.
// ===========================================================================

test('ADD_CURRENT_PAGE requires tabId, expectedPageKey, and a numeric gainPercent (the popup slider value saved atomically)', () => {
  const valid = {
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.ADD_CURRENT_PAGE,
    requestId: 'r',
    payload: { tabId: 7, expectedPageKey: 'https://example.com/', gainPercent: 150 },
  };
  assert.equal(validateMessage(valid).ok, true);

  const missingGain = { ...valid, payload: { tabId: 7, expectedPageKey: 'https://example.com/' } };
  assert.equal(validateMessage(missingGain).ok, false);

  const missingExpectedPageKey = { ...valid, payload: { tabId: 7, gainPercent: 150 } };
  assert.equal(validateMessage(missingExpectedPageKey).ok, false);
});

test('ADD_PAGE_MANUAL accepts an optional numeric gainPercent (the manual-add modal\'s initial volume) and rejects a non-numeric one', () => {
  const withoutGain = { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.ADD_PAGE_MANUAL, requestId: 'r', payload: { rawUrl: 'https://example.com/' } };
  assert.equal(validateMessage(withoutGain).ok, true);

  const withGain = { ...withoutGain, payload: { rawUrl: 'https://example.com/', gainPercent: 80 } };
  assert.equal(validateMessage(withGain).ok, true);

  const withScope = { ...withoutGain, payload: { rawUrl: 'https://example.com/section', matchMode: 'path' } };
  assert.equal(validateMessage(withScope).ok, true);

  const withBadScope = { ...withoutGain, payload: { rawUrl: 'https://example.com/', matchMode: 'wildcard' } };
  assert.equal(validateMessage(withBadScope).ok, false);

  const withBadGain = { ...withoutGain, payload: { rawUrl: 'https://example.com/', gainPercent: '80' } };
  assert.equal(validateMessage(withBadGain).ok, false);
});

test('UPDATE_SAVED_PAGE_VOLUME requires pageKey and a numeric gainPercent - never tab or operationId-scoped', () => {
  const valid = {
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    requestId: 'r',
    payload: { pageKey: 'https://example.com/', gainPercent: 60 },
  };
  assert.equal(validateMessage(valid).ok, true);

  const missingPageKey = { ...valid, payload: { gainPercent: 60 } };
  assert.equal(validateMessage(missingPageKey).ok, false);

  const missingGain = { ...valid, payload: { pageKey: 'https://example.com/' } };
  assert.equal(validateMessage(missingGain).ok, false);
});

test('REMOVE_SAVED_PAGE and CLEAR_SAVED_PAGES validate at the service-worker target', () => {
  assert.equal(
    validateMessage({ target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.REMOVE_SAVED_PAGE, requestId: 'r', payload: { pageKey: 'https://example.com/' } }).ok,
    true
  );
  assert.equal(
    validateMessage({ target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.CLEAR_SAVED_PAGES, requestId: 'r', payload: {} }).ok,
    true
  );
});

test('SAVED_PAGES_CHANGED validates at the options target (renamed from ALLOWED_PAGES_CHANGED)', () => {
  assert.equal(
    validateMessage({ target: TARGETS.OPTIONS, type: MESSAGE_TYPES.SAVED_PAGES_CHANGED, requestId: 'r', payload: {} }).ok,
    true
  );
});

test('sync: SAVED_PAGE_CHANGED validates at the POPUP target and requires a non-empty pageKey', () => {
  assert.equal(
    validateMessage({ target: TARGETS.POPUP, type: MESSAGE_TYPES.SAVED_PAGE_CHANGED, requestId: 'r', payload: { pageKey: 'https://e.example/' } }).ok,
    true
  );
  // Missing/empty pageKey is rejected.
  assert.equal(
    validateMessage({ target: TARGETS.POPUP, type: MESSAGE_TYPES.SAVED_PAGE_CHANGED, requestId: 'r', payload: {} }).ok,
    false
  );
  assert.equal(
    validateMessage({ target: TARGETS.POPUP, type: MESSAGE_TYPES.SAVED_PAGE_CHANGED, requestId: 'r', payload: { pageKey: '' } }).ok,
    false
  );
});

test('the obsolete ADD_PAGE_AND_ENABLE message type no longer exists', () => {
  assert.equal('ADD_PAGE_AND_ENABLE' in MESSAGE_TYPES, false);
  assert.equal(isValidMessageType('ADD_PAGE_AND_ENABLE'), false);
});
