// Deterministic, DOM-free tests for the Saved-pages row-slider live-vs-persist
// timing. See shared/saved-page-slider.js:
//  - input drives LIVE gain only, throttled LEADING + TRAILING (the latest
//    value in a window is applied at the trailing edge, so no final value is
//    dropped) - and NEVER persists;
//  - change flushes the final live value, then persists exactly once;
//  - dispose() cancels a pending trailing timer so a closing options page
//    cannot fire a stale live update against a later session.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSavedPageSliderController } from '../shared/saved-page-slider.js';

const THROTTLE_MS = 20;

function createRecorder() {
  const liveCalls = []; // [value]
  const persistCalls = []; // [value]
  const controller = createSavedPageSliderController({
    sendLiveGain: (value) => liveCalls.push(value),
    persist: (value) => {
      persistCalls.push(value);
      return { ok: true };
    },
    liveThrottleMs: THROTTLE_MS,
  });
  return { controller, liveCalls, persistCalls };
}

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('saved-slider: input drives live gain immediately (leading edge), never persists', () => {
  const { controller, liveCalls, persistCalls } = createRecorder();
  controller.onInput(209);
  assert.deepEqual(liveCalls, [209]);
  assert.deepEqual(persistCalls, [], 'input alone never persists');
});

test('saved-slider: input alone never persists, even after a real delay', async () => {
  const { controller, persistCalls } = createRecorder();
  controller.onInput(120);
  await tick(THROTTLE_MS * 5);
  assert.deepEqual(persistCalls, []);
});

test('saved-slider: rapid inputs 150 -> 180 -> 240 finish at 240 (trailing-latest), no value dropped', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(150); // leading -> 150 sent now
  controller.onInput(180); // within window -> trailing pending
  controller.onInput(240); // latest wins for the trailing edge
  assert.deepEqual(liveCalls, [150], 'only the leading value sent so far');
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [150, 240], 'the final live gain is 240, applied at the trailing edge');
});

test('saved-slider: change flushes the final live value first, then persists exactly once', () => {
  const { controller, liveCalls, persistCalls } = createRecorder();
  controller.onInput(150); // leading live 150
  controller.onChange(240); // release at 240 -> flush live 240, then persist 240
  assert.deepEqual(liveCalls, [150, 240]);
  assert.deepEqual(persistCalls, [240], 'persists only the final committed value, exactly once');
});

test('saved-slider: change flushes a pending trailing value that was never sent live', async () => {
  const { controller, liveCalls, persistCalls } = createRecorder();
  controller.onInput(150); // leading 150
  controller.onInput(200); // trailing pending 200 (not yet live)
  controller.onChange(200); // release -> flush live 200 now, persist 200 once
  assert.deepEqual(liveCalls, [150, 200]);
  assert.deepEqual(persistCalls, [200]);
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [150, 200], 'the superseded trailing timer never double-sends');
});

test('saved-slider: many committed values persist once each (change is once-per-commit)', () => {
  const { controller, persistCalls } = createRecorder();
  controller.onChange(120);
  controller.onChange(160);
  controller.onChange(200);
  assert.deepEqual(persistCalls, [120, 160, 200]);
});

test('saved-slider: dispose cancels a pending trailing timer (closing options never fires a stale live update)', async () => {
  const { controller, liveCalls } = createRecorder();
  controller.onInput(150); // leading 150
  controller.onInput(240); // trailing pending 240
  controller.dispose(); // options page closing / row re-rendered
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(liveCalls, [150], 'the pending trailing 240 never fired after dispose');
});
