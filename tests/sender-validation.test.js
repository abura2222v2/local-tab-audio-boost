// Deterministic unit tests for the two shared sender-validation helpers in
// shared/messages.js, used identically by every extension context to build
// its own explicit allowed-sender matrix (see each context's registerMessageHandler
// call site). These are the same functions the real offscreen.js/popup.js/
// options.js/service-worker.js use - tested directly here rather than via
// the DOM/AudioContext-dependent modules that call them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS } from '../shared/constants.js';

const FAKE_EXTENSION_ID = 'fake-extension-id';

globalThis.chrome = {
  runtime: {
    id: FAKE_EXTENSION_ID,
    getURL(path) {
      return `fake-extension://${FAKE_EXTENSION_ID}/${path}`;
    },
  },
};

const { validateServiceWorkerOriginatedSender, validatePageContextSender, expectedContextUrl } = await import(
  '../shared/messages.js'
);

const swUrl = expectedContextUrl(TARGETS.SERVICE_WORKER);
const offscreenUrl = expectedContextUrl(TARGETS.OFFSCREEN);
const popupUrl = expectedContextUrl(TARGETS.POPUP);
const optionsUrl = expectedContextUrl(TARGETS.OPTIONS);

// ---------------------------------------------------------------------------
// validateServiceWorkerOriginatedSender - used by offscreen.js/popup.js/
// options.js, all of which only ever receive messages the service worker
// itself sent. Chrome's MessageSender.url is documented as potentially
// absent specifically for a service-worker sender, so (and only so) an
// absent url is accepted here.
// ---------------------------------------------------------------------------

test('validateServiceWorkerOriginatedSender: accepts a sender with no url at all (the documented SW-sender exception)', () => {
  assert.equal(validateServiceWorkerOriginatedSender({ id: FAKE_EXTENSION_ID }), true);
});

test('validateServiceWorkerOriginatedSender: accepts a sender whose url exactly matches the service worker', () => {
  assert.equal(validateServiceWorkerOriginatedSender({ id: FAKE_EXTENSION_ID, url: swUrl }), true);
});

test('validateServiceWorkerOriginatedSender: rejects a sender whose url is present but wrong, even with a valid id', () => {
  assert.equal(validateServiceWorkerOriginatedSender({ id: FAKE_EXTENSION_ID, url: popupUrl }), false);
  assert.equal(validateServiceWorkerOriginatedSender({ id: FAKE_EXTENSION_ID, url: offscreenUrl }), false);
});

test('validateServiceWorkerOriginatedSender: rejects a url claiming to be a completely different extension', () => {
  assert.equal(
    validateServiceWorkerOriginatedSender({ id: FAKE_EXTENSION_ID, url: 'fake-extension://someone-else/service-worker.js' }),
    false
  );
});

test('validateServiceWorkerOriginatedSender: an empty-string url is present, not absent, and must still match exactly', () => {
  // Guards against a naive falsy check (`!sender.url`) accidentally treating
  // an empty string the same as "genuinely absent" - only `undefined` gets
  // the documented exception.
  assert.equal(validateServiceWorkerOriginatedSender({ id: FAKE_EXTENSION_ID, url: '' }), false);
});

// ---------------------------------------------------------------------------
// validatePageContextSender - used by service-worker.js for every command
// it receives (popup/options) and every event (offscreen). All three are
// real page/frame extension contexts, where MessageSender.url is reliably
// present - there is no bypass for an absent url here.
// ---------------------------------------------------------------------------

test('validatePageContextSender: accepts a sender whose url matches the requested target exactly', () => {
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID, url: offscreenUrl }, TARGETS.OFFSCREEN), true);
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID, url: popupUrl }, TARGETS.POPUP), true);
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID, url: optionsUrl }, TARGETS.OPTIONS), true);
});

test('validatePageContextSender: rejects a sender whose url does not match the requested target', () => {
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID, url: popupUrl }, TARGETS.OFFSCREEN), false);
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID, url: optionsUrl }, TARGETS.POPUP), false);
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID, url: offscreenUrl }, TARGETS.OPTIONS), false);
});

test('validatePageContextSender: rejects a sender with no url at all - no bypass for page-context senders', () => {
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID }, TARGETS.OFFSCREEN), false);
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID }, TARGETS.POPUP), false);
  assert.equal(validatePageContextSender({ id: FAKE_EXTENSION_ID }, TARGETS.OPTIONS), false);
});

test('validatePageContextSender: rejects an entirely absent sender', () => {
  assert.equal(validatePageContextSender(undefined, TARGETS.OFFSCREEN), false);
});

// ---------------------------------------------------------------------------
// The full service-worker-side matrix, mirroring service-worker.js's own
// validateServiceWorkerSender exactly (SESSION_STOPPED/SESSION_ERROR must
// come from offscreen; every other message type must come from popup or
// options) - see tests/service-worker-logic.test.js's "fix4" section for
// the same matrix exercised end to end through the real message handler.
// ---------------------------------------------------------------------------

function validateServiceWorkerSenderMatrix(sender, isSessionEvent) {
  if (isSessionEvent) return validatePageContextSender(sender, TARGETS.OFFSCREEN);
  return validatePageContextSender(sender, TARGETS.POPUP) || validatePageContextSender(sender, TARGETS.OPTIONS);
}

test('service-worker matrix: a session event from the genuine offscreen document is accepted', () => {
  assert.equal(validateServiceWorkerSenderMatrix({ id: FAKE_EXTENSION_ID, url: offscreenUrl }, true), true);
});

test('service-worker matrix: a session event claiming to come from the popup is rejected', () => {
  assert.equal(validateServiceWorkerSenderMatrix({ id: FAKE_EXTENSION_ID, url: popupUrl }, true), false);
});

test('service-worker matrix: a regular command from the popup or options is accepted', () => {
  assert.equal(validateServiceWorkerSenderMatrix({ id: FAKE_EXTENSION_ID, url: popupUrl }, false), true);
  assert.equal(validateServiceWorkerSenderMatrix({ id: FAKE_EXTENSION_ID, url: optionsUrl }, false), true);
});

test('service-worker matrix: a regular command claiming to come from the offscreen document is rejected', () => {
  assert.equal(validateServiceWorkerSenderMatrix({ id: FAKE_EXTENSION_ID, url: offscreenUrl }, false), false);
});
