// Tests for the pure page-audio policy: which media may be routed, how gain
// maps, and which bridge commands are accepted. See shared/page-audio-policy.js.
//
// The safety rule being pinned down: createMediaElementSource permanently
// reroutes an element for the document's lifetime, and doing that to media the
// context cannot read produces silence that cannot be undone. So anything
// uncertain must be refused BEFORE routing, never probed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BACKENDS,
  isValidBackend,
  PAGE_AUDIO_STATES,
  isRunningState,
  isTerminalFailureState,
  BRIDGE_COMMANDS,
  isValidBridgeCommand,
  gainValueFromPercent,
  classifyMediaElement,
  summarizeDocumentState,
  ATTACH_REFUSAL,
  describeRefusal,
} from '../shared/page-audio-policy.js';

const ORIGIN = 'https://example.com';
const media = (overrides = {}) => ({ tagName: 'VIDEO', documentOrigin: ORIGIN, currentSrc: '', ...overrides });

// ===========================================================================
// Backends
// ===========================================================================

test('policy: exactly two backends exist and are validated', () => {
  assert.equal(BACKENDS.PAGE_AUDIO, 'page-audio');
  assert.equal(BACKENDS.TAB_CAPTURE, 'tab-capture');
  assert.equal(isValidBackend('page-audio'), true);
  assert.equal(isValidBackend('tab-capture'), true);
  assert.equal(isValidBackend('anything-else'), false);
  assert.equal(isValidBackend(undefined), false);
});

// ===========================================================================
// Gain mapping (#13)
// ===========================================================================

test('policy #13: gain maps 0/100/200/300 to 0.0/1.0/2.0/3.0', () => {
  assert.equal(gainValueFromPercent(0), 0);
  assert.equal(gainValueFromPercent(100), 1);
  assert.equal(gainValueFromPercent(200), 2);
  assert.equal(gainValueFromPercent(300), 3);
  assert.equal(gainValueFromPercent(155), 1.55);
});

// ===========================================================================
// Bridge command vocabulary (#30 security)
// ===========================================================================

test('policy: the bridge vocabulary is narrow - install, gain, query, reset, dispose', () => {
  assert.deepEqual(Object.values(BRIDGE_COMMANDS).sort(), [
    'DISPOSE_OBSERVERS',
    'INSTALL',
    'QUERY_STATE',
    'RESET_TO_NEUTRAL',
    'SET_GAIN',
  ]);
});

test('policy: a bridge command must carry an operation token and a valid gain where relevant', () => {
  const token = 'op-1';
  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.INSTALL, operationToken: token, gainPercent: 150 }), true);
  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.SET_GAIN, operationToken: token, gainPercent: 0 }), true);
  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.QUERY_STATE, operationToken: token }), true);

  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.SET_GAIN, gainPercent: 150 }), false, 'no token');
  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.SET_GAIN, operationToken: '', gainPercent: 150 }), false);
  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.SET_GAIN, operationToken: token, gainPercent: 301 }), false);
  assert.equal(isValidBridgeCommand({ type: BRIDGE_COMMANDS.SET_GAIN, operationToken: token, gainPercent: 1.5 }), false);
  assert.equal(isValidBridgeCommand({ type: 'EVALUATE', operationToken: token, code: 'x' }), false, 'no generic execution');
  assert.equal(isValidBridgeCommand(null), false);
  assert.equal(isValidBridgeCommand('SET_GAIN'), false);
});

// ===========================================================================
// Media classification (#18-#21)
// ===========================================================================

test('policy #18: same-origin http(s) media is safe', () => {
  const verdict = classifyMediaElement(media({ currentSrc: 'https://example.com/movie.mp4' }));
  assert.equal(verdict.safe, true);
});

test('policy #19: blob and data media are safe (this is how MSE playback appears)', () => {
  assert.equal(classifyMediaElement(media({ currentSrc: 'blob:https://example.com/abc' })).safe, true);
  assert.equal(classifyMediaElement(media({ currentSrc: 'data:audio/wav;base64,AAAA' })).safe, true);
});

test('policy #20: cross-origin media with no CORS mode is refused', () => {
  const verdict = classifyMediaElement(media({ currentSrc: 'https://cdn.other.test/movie.mp4' }));
  assert.equal(verdict.safe, false);
  assert.equal(verdict.reason, ATTACH_REFUSAL.CROSS_ORIGIN_NO_CORS);
});

test('policy: cross-origin media that explicitly opted into CORS is safe', () => {
  for (const mode of ['anonymous', 'use-credentials', 'ANONYMOUS']) {
    const verdict = classifyMediaElement(media({ currentSrc: 'https://cdn.other.test/m.mp4', crossOrigin: mode }));
    assert.equal(verdict.safe, true, `crossOrigin=${mode} should be safe`);
  }
});

test('policy: DRM-protected media is refused', () => {
  const verdict = classifyMediaElement(media({ currentSrc: 'https://example.com/a.mp4', hasEncryptedMedia: true }));
  assert.equal(verdict.safe, false);
  assert.equal(verdict.reason, ATTACH_REFUSAL.PROTECTED_MEDIA);
});

test('policy: a non-media element is refused', () => {
  assert.equal(classifyMediaElement(media({ tagName: 'DIV' })).reason, ATTACH_REFUSAL.NOT_MEDIA_ELEMENT);
  assert.equal(classifyMediaElement({}).reason, ATTACH_REFUSAL.NOT_MEDIA_ELEMENT);
});

test('policy: an element with no source yet is RETRYABLE, not a failure', () => {
  const verdict = classifyMediaElement(media({ currentSrc: '' }));
  assert.equal(verdict.safe, false);
  assert.equal(verdict.reason, ATTACH_REFUSAL.NO_SOURCE_YET);
  assert.equal(verdict.retryable, true, 'the controller keeps waiting for a late player');
});

test('policy: an unsupported scheme and an already-attached element are refused', () => {
  assert.equal(classifyMediaElement(media({ currentSrc: 'ftp://example.com/a.mp4' })).reason, ATTACH_REFUSAL.UNSUPPORTED_SCHEME);
  assert.equal(
    classifyMediaElement(media({ currentSrc: 'https://example.com/a.mp4', alreadyAttached: true })).reason,
    ATTACH_REFUSAL.ALREADY_ATTACHED
  );
});

test('policy: an audio element is treated the same as a video element', () => {
  assert.equal(classifyMediaElement(media({ tagName: 'AUDIO', currentSrc: 'https://example.com/a.mp3' })).safe, true);
});

test('policy: a malformed currentSrc never throws - it is simply not same-origin', () => {
  const verdict = classifyMediaElement(media({ currentSrc: 'https://[not a url' }));
  assert.equal(verdict.safe, false);
});

// ===========================================================================
// Document state summary (#13 of section 13 - honest reporting)
// ===========================================================================

test('policy: attached media reports ACTIVE, and a suspended context reports CONTEXT_SUSPENDED', () => {
  assert.equal(summarizeDocumentState({ attachedCount: 1 }), PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA);
  assert.equal(
    summarizeDocumentState({ attachedCount: 1, contextState: 'suspended' }),
    PAGE_AUDIO_STATES.CONTEXT_SUSPENDED
  );
});

test('policy: nothing attached but nothing blocking reports ARMED, never a fake success', () => {
  assert.equal(summarizeDocumentState({ attachedCount: 0, refusals: [] }), PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA);
  assert.equal(
    summarizeDocumentState({ attachedCount: 0, refusals: [ATTACH_REFUSAL.NO_SOURCE_YET] }),
    PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA,
    'a not-yet-loaded player keeps waiting'
  );
});

test('policy #24: a genuinely blocking refusal reports UNSUPPORTED_MEDIA, not success', () => {
  assert.equal(
    summarizeDocumentState({ attachedCount: 0, refusals: [ATTACH_REFUSAL.CROSS_ORIGIN_NO_CORS] }),
    PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA
  );
  assert.equal(
    summarizeDocumentState({ attachedCount: 0, refusals: [ATTACH_REFUSAL.PROTECTED_MEDIA] }),
    PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA
  );
});

test('policy: running vs terminal states are distinguished', () => {
  assert.equal(isRunningState(PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA), true);
  assert.equal(isRunningState(PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA), true);
  assert.equal(isRunningState(PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA), false);
  assert.equal(isTerminalFailureState(PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA), true);
  assert.equal(isTerminalFailureState(PAGE_AUDIO_STATES.PERMISSION_DENIED), true);
  assert.equal(isTerminalFailureState(PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA), false);
});

test('policy: every refusal has a human explanation for the popup', () => {
  for (const reason of Object.values(ATTACH_REFUSAL)) {
    const text = describeRefusal(reason);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 10, `${reason} needs a real explanation`);
  }
});
