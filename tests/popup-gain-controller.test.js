// Deterministic, DOM-free tests for the popup's live-vs-persisted slider
// timing on an already-active session. See shared/popup-gain-controller.js:
//  - input drives live audio only, throttled LEADING + TRAILING (the latest
//    value in a window is applied at the window's trailing edge);
//  - change always flushes the final value to live audio first, then persists;
//  - a fallback flush never leaves a pending final live value unsent;
//  - persistence is caller-gated (the recorder's persistNow always records,
//    so the saved-vs-unsaved gating itself is tested in popup-controller).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGainInputController } from '../shared/popup-gain-controller.js';

const THROTTLE_MS = 20;

function createRecorder() {
  const liveCalls = []; // [value, operationId]
  const persistCalls = []; // [value, operationId]
  const controller = createGainInputController({
    sendLiveGain: (value, operationId) => liveCalls.push([value, operationId]),
    persistNow: (value, operationId) => persistCalls.push([value, operationId]),
    liveThrottleMs: THROTTLE_MS,
  });
  return { controller, liveCalls, persistCalls };
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('input alone never sends a persistent write, even after a real delay', async () => {
  const { controller, persistCalls } = createRecorder();
  controller.onInput(120);
  await tick(THROTTLE_MS * 5);
  assert.deepEqual(persistCalls, []);
});

test('input drives live gain immediately (leading edge)', () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(150);
  assert.deepEqual(liveCalls, [[150, null]]);
});

// --- r5 issue #2: trailing-latest throttle ---

test('r5-2: rapid input 110 -> 180 within the window ends with the latest value applied live (trailing edge)', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(110); // leading -> 110 sent now
  controller.onInput(180); // within window -> trailing pending
  assert.deepEqual(liveCalls, [[110, null]], 'only the leading value has been sent so far');
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [[110, null], [180, null]], 'the latest value is applied at the trailing edge');
});

test('r5-2: several inputs within one window collapse to leading + the single latest trailing value', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(110); // leading
  controller.onInput(160);
  controller.onInput(190); // latest wins for the trailing edge
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [[110, null], [190, null]]);
});

test('r5-2: a trailing value equal to the leading value is not redundantly re-sent', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(140); // leading 140
  controller.onInput(140); // same value -> no trailing send needed
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [[140, null]]);
});

test('change persists immediately, with no delay', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onChange(140);
  assert.deepEqual(persistCalls, [[140, null]]);
});

test('r5-2: change always flushes the final value to live audio first (even before persisting)', () => {
  const { controller, liveCalls, persistCalls } = createRecorder();
  controller.onInput(110); // leading live 110
  controller.onChange(180); // must flush live 180 first, then persist 180
  assert.deepEqual(liveCalls, [[110, null], [180, null]]);
  assert.deepEqual(persistCalls, [[180, null]]);
});

test('r5-2: change flushes the pending trailing value to live audio even when no further live send was due', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(100); // leading 100
  controller.onInput(175); // trailing pending 175 (not yet sent)
  controller.onChange(175); // release at 175 -> must flush live 175 now, not wait for the window
  assert.deepEqual(liveCalls, [[100, null], [175, null]]);
  await tick(THROTTLE_MS * 2);
  // The superseded trailing timer must not double-send 175 after the window.
  assert.deepEqual(liveCalls, [[100, null], [175, null]]);
});

test('a long pause between input ticks (simulating a paused drag) still sends no write', async () => {
  const { controller, persistCalls } = createRecorder();
  controller.onInput(100);
  await tick(THROTTLE_MS * 2);
  controller.onInput(105);
  await tick(THROTTLE_MS * 2);
  controller.onInput(110);
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(persistCalls, []);
});

test('flushFallback sends the last value live if it is still pending, then persists it once', async () => {
  const { controller, liveCalls, persistCalls } = createRecorder();
  controller.onInput(110); // leading live 110
  controller.onInput(180); // trailing pending 180 (not yet live)
  controller.flushFallback(); // pagehide before the window elapsed
  assert.deepEqual(liveCalls, [[110, null], [180, null]], 'the pending final live value is flushed, not lost');
  assert.deepEqual(persistCalls, [[180, null]]);
  await tick(THROTTLE_MS * 2);
  // The cancelled trailing timer must not re-send after the flush.
  assert.deepEqual(liveCalls, [[110, null], [180, null]]);
});

test('flushFallback is a no-op if the last value already matches what was persisted via change', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onChange(90);
  controller.flushFallback();
  assert.deepEqual(persistCalls, [[90, null]]); // exactly one, from change
});

test('flushFallback is a no-op if nothing was ever touched', () => {
  const { controller, persistCalls } = createRecorder();
  controller.flushFallback();
  assert.deepEqual(persistCalls, []);
});

test('onServerState establishes a clean baseline so a stale fallback does not resend it', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onServerState(100, 'op-1');
  controller.flushFallback();
  assert.deepEqual(persistCalls, []);
});

test('input after a server-state baseline still sends no write until change or flush', async () => {
  const { controller, persistCalls } = createRecorder();
  controller.onServerState(100, 'op-1');
  controller.onInput(175);
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(persistCalls, []);
  controller.flushFallback();
  assert.deepEqual(persistCalls, [[175, 'op-1']]);
});

// --- operationId scoping ---

test('onInput/onChange tag their calls with the operationId established by the last onServerState', () => {
  const { controller, liveCalls, persistCalls } = createRecorder();
  controller.onServerState(100, 'op-A');
  controller.onInput(120); // live 120/op-A
  controller.onChange(130); // live 130/op-A (flush) + persist 130/op-A
  assert.deepEqual(liveCalls, [[120, 'op-A'], [130, 'op-A']]);
  assert.deepEqual(persistCalls, [[130, 'op-A']]);
});

test('r5-2: a trailing callback from operation A never fires for (or after superseding to) operation B', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onServerState(100, 'op-A');
  controller.onInput(110); // leading live 110/op-A
  controller.onInput(180); // trailing pending 180 for op-A
  controller.onServerState(120, 'op-B'); // supersede: the op-A trailing must be cancelled
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [[110, 'op-A']], 'the op-A trailing never fired, and never as op-B');
});

test('a fresh onServerState with a new operationId resets the baseline, discarding a stale mid-drag value', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onServerState(100, 'op-A');
  controller.onInput(150); // mid-drag, never committed
  controller.onServerState(120, 'op-B'); // new generation, new baseline
  controller.flushFallback();
  assert.deepEqual(persistCalls, []); // stale 150/op-A never persisted
});

test('after an operationId reset, a later flush is tagged with the new operationId, never the stale one', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onServerState(100, 'op-A');
  controller.onInput(150);
  controller.onServerState(120, 'op-B');
  controller.onInput(140); // fresh drag under op-B
  controller.flushFallback();
  assert.deepEqual(persistCalls, [[140, 'op-B']]);
});

test('flushFallback with no operationId ever established sends null, never throws', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onInput(160);
  controller.flushFallback();
  assert.deepEqual(persistCalls, [[160, null]]);
});
