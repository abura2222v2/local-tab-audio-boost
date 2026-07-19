// Deterministic, DOM-free tests for shared/popup-controller.js - the popup's
// slider-driven capture-start / first-value orchestration (r5 issue #1/#3).
//
// These exercise the REAL popup event order: a slider `input` fires BEFORE
// any capture session (and thus any operationId) exists, which starts a
// capture and must then apply the user's chosen value to the resulting
// operation - never dropping it, and never letting the post-start server
// refresh reset the slider back to the server's initial/saved value. The
// tests deliberately do NOT hand-order "await START_CAPTURE; await
// SET_TAB_GAIN" - they drive onSliderInput and let the controller sequence
// the messages exactly as the real popup would.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPopupController } from '../shared/popup-controller.js';
import { clampGainPercent } from '../shared/validation.js';

const TAB_ID = 1;
const THROTTLE_MS = 20;

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A small fake "service worker + offscreen" that mirrors just enough of the
 * real START_CAPTURE / SET_TAB_GAIN / GET_TAB_STATE contract for the
 * controller to orchestrate against. `offscreenLiveGain` is the value the
 * (fake) live audio graph is actually at - i.e. "the final offscreen gain".
 */
function createHarness({ pageKey, savedValue = null } = {}) {
  let currentPageKey = pageKey;
  let savedGain = savedValue; // null => unsaved; number => saved default
  let session = null; // { operationId, gainPercent } while active
  let opCounter = 0;

  let offscreenLiveGain = null; // the applied live gain for the current session
  const sliderDisplays = [];
  const startCalls = [];
  const setLiveGainCalls = [];
  const persistCalls = [];

  let startGate = null; // Promise the next startCapture awaits, if set
  let releaseStartGate = null;
  let startResultOverride = null;

  function serverState() {
    if (session) {
      return {
        tabId: TAB_ID,
        pageKey: currentPageKey,
        displayUrl: currentPageKey,
        saved: savedGain !== null,
        state: 'active',
        gainPercent: session.gainPercent,
        operationId: session.operationId,
        restricted: false,
      };
    }
    return {
      tabId: TAB_ID,
      pageKey: currentPageKey,
      displayUrl: currentPageKey,
      saved: savedGain !== null,
      state: 'inactive',
      gainPercent: savedGain ?? 100,
      operationId: null,
      restricted: false,
    };
  }

  const deps = {
    startCapture: async (payload) => {
      startCalls.push(payload);
      if (startGate) await startGate;
      if (startResultOverride) return startResultOverride;
      if (payload.expectedPageKey !== currentPageKey) {
        return { ok: false, error: { code: 'PAGE_CHANGED', message: 'page changed' } };
      }
      opCounter += 1;
      const op = `op-${opCounter}`;
      const initial = clampGainPercent(payload.initialGainPercent) ?? 100;
      session = { operationId: op, gainPercent: initial };
      offscreenLiveGain = initial;
      return { ok: true, data: { state: 'active', operationId: op } };
    },
    setLiveGain: async ({ tabId, gainPercent, operationId }) => {
      setLiveGainCalls.push([gainPercent, operationId]);
      if (session && session.operationId === operationId) {
        const clamped = clampGainPercent(gainPercent) ?? session.gainPercent;
        session.gainPercent = clamped;
        offscreenLiveGain = clamped;
        return { ok: true, data: { tabId, gainPercent: clamped } };
      }
      return { ok: false, error: { code: 'NOT_ACTIVE', message: 'not active' } };
    },
    persistVolume: async ({ tabId, gainPercent, operationId }) => {
      persistCalls.push([gainPercent, operationId]);
      return { ok: true, data: {} };
    },
    refresh: async () => {
      controller.setServerState(serverState());
    },
    setSliderDisplay: (value) => {
      sliderDisplays.push(value);
    },
    liveThrottleMs: THROTTLE_MS,
  };

  const controller = createPopupController(deps);

  return {
    controller,
    prime: () => controller.setServerState(serverState()),
    serverState,
    navigateTo: (nextPageKey, nextSavedValue = null) => {
      currentPageKey = nextPageKey;
      savedGain = nextSavedValue;
      session = null;
      offscreenLiveGain = null;
    },
    pushServerState: (partial) => controller.setServerState({ ...serverState(), ...partial }),
    gateNextStart: () => {
      startGate = new Promise((resolve) => {
        releaseStartGate = resolve;
      });
    },
    releaseStart: () => {
      if (releaseStartGate) releaseStartGate();
      startGate = null;
    },
    setStartResultOverride: (r) => {
      startResultOverride = r;
    },
    get offscreenLiveGain() {
      return offscreenLiveGain;
    },
    get session() {
      return session;
    },
    sliderDisplays,
    startCalls,
    setLiveGainCalls,
    persistCalls,
  };
}

test('r5-1 #1: inactive UNSAVED page, first slider input 150 -> final offscreen gain is 150', async () => {
  const h = createHarness({ pageKey: 'https://p1.example/', savedValue: null });
  h.prime();
  h.controller.onSliderInput(150);
  await tick(THROTTLE_MS * 2);
  assert.equal(h.offscreenLiveGain, 150);
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.sliderDisplays[h.sliderDisplays.length - 1], 150, 'slider ends showing the chosen value, not reset');
});

test('r5-1 #2: inactive SAVED page (stored 120), first input 175 -> final offscreen gain is 175, not 120', async () => {
  const h = createHarness({ pageKey: 'https://p2.example/', savedValue: 120 });
  h.prime();
  assert.equal(h.sliderDisplays[h.sliderDisplays.length - 1], 120, 'slider initially shows the saved value while inactive');
  h.controller.onSliderInput(175);
  await tick(THROTTLE_MS * 2);
  assert.equal(h.offscreenLiveGain, 175, 'the session ends at the user-chosen 175, never the saved 120');
  assert.equal(h.sliderDisplays[h.sliderDisplays.length - 1], 175);
});

test('r5-1 #3: inputs 130, 160, 190 while START_CAPTURE is in flight -> exactly one START_CAPTURE, final live gain 190', async () => {
  const h = createHarness({ pageKey: 'https://p3.example/', savedValue: null });
  h.prime();
  h.gateNextStart();
  h.controller.onSliderInput(130); // triggers the (gated) start
  h.controller.onSliderInput(160); // updates desired only
  h.controller.onSliderInput(190); // updates desired only
  await tick(5);
  assert.equal(h.startCalls.length, 1, 'a drag never issues more than one concurrent START_CAPTURE');
  h.releaseStart();
  await tick(THROTTLE_MS * 2);
  assert.equal(h.startCalls.length, 1);
  assert.equal(h.offscreenLiveGain, 190, 'the LATEST dragged value wins, applied to the resulting operation');
});

test('r5-1 #4: a failed start applies no stale gain', async () => {
  const h = createHarness({ pageKey: 'https://p4.example/', savedValue: null });
  h.prime();
  h.setStartResultOverride({ ok: false, error: { code: 'CAPTURE_FAILED', message: 'nope' } });
  h.controller.onSliderInput(150);
  await tick(THROTTLE_MS * 2);
  assert.equal(h.offscreenLiveGain, null, 'no session ever started');
  assert.deepEqual(h.setLiveGainCalls, [], 'no stale SET_TAB_GAIN was applied');
});

test('r5-1 #5: navigation during start (PAGE_CHANGED) discards the pending value - no stale gain applied', async () => {
  const h = createHarness({ pageKey: 'https://p5-a.example/', savedValue: null });
  h.prime();
  h.gateNextStart();
  h.controller.onSliderInput(150); // start (gated) for page A, desired=150
  await tick(5);
  // The tab navigates to page B before the gated start resolves.
  h.navigateTo('https://p5-b.example/', null);
  h.releaseStart(); // start now resolves against page B -> expectedPageKey mismatch -> PAGE_CHANGED
  await tick(THROTTLE_MS * 2);
  assert.equal(h.session, null, 'capture never started on the page the user did not act on');
  assert.deepEqual(h.setLiveGainCalls, [], 'the pending 150 was discarded, never applied as a stale gain');
});

test('r5-1 #6: a popup server refresh while start is in flight does NOT overwrite the still-pending user value', async () => {
  const h = createHarness({ pageKey: 'https://p6.example/', savedValue: null });
  h.prime(); // inactive, slider shows 100
  h.gateNextStart();
  h.controller.onSliderInput(175); // desired=175, start (gated) in flight
  await tick(5);
  assert.equal(h.sliderDisplays[h.sliderDisplays.length - 1], 175, 'slider shows the chosen 175');
  // A server broadcast arrives mid-flight, still reporting the pre-start
  // value (100) for the same page - it must NOT clobber the pending 175.
  h.pushServerState({ state: 'inactive', gainPercent: 100, operationId: null });
  assert.equal(h.sliderDisplays[h.sliderDisplays.length - 1], 175, 'the pending user value survives the refresh, not reset to 100');
  h.releaseStart();
  await tick(THROTTLE_MS * 2);
  assert.equal(h.offscreenLiveGain, 175);
});

test('r5-1: Enable-boosting on a saved page starts at the displayed saved value', async () => {
  const h = createHarness({ pageKey: 'https://enable-saved.example/', savedValue: 145 });
  h.prime();
  await h.controller.onEnableClick();
  await tick(THROTTLE_MS * 2);
  assert.equal(h.offscreenLiveGain, 145, 'Enable uses the displayed default/saved value as the initial gain');
  assert.equal(h.startCalls[0].initialGainPercent, 145);
});

test('r5-1: saved and unsaved pages behave identically for live gain, but only the saved page persists on change', async () => {
  // Unsaved: live gain works, storage is never written.
  const unsaved = createHarness({ pageKey: 'https://unsaved.example/', savedValue: null });
  unsaved.prime();
  unsaved.controller.onSliderInput(160);
  await tick(THROTTLE_MS * 2);
  assert.equal(unsaved.offscreenLiveGain, 160);
  unsaved.controller.onSliderChange(160); // release while active
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(unsaved.persistCalls, [], 'an unsaved page never writes storage');

  // Saved: identical live behavior, and a change persists the final value.
  const saved = createHarness({ pageKey: 'https://saved.example/', savedValue: 100 });
  saved.prime();
  saved.controller.onSliderInput(160);
  await tick(THROTTLE_MS * 2);
  assert.equal(saved.offscreenLiveGain, 160, 'live gain is identical to the unsaved case');
  saved.controller.onSliderChange(185); // release at 185 while active
  await tick(THROTTLE_MS * 2);
  assert.equal(saved.offscreenLiveGain, 185);
  assert.equal(saved.persistCalls.length >= 1, true, 'a saved page persists the committed value');
  assert.equal(saved.persistCalls[saved.persistCalls.length - 1][0], 185);
});

test('r5-1: input alone (no change) on a saved active session never persists', async () => {
  const h = createHarness({ pageKey: 'https://saved-input-only.example/', savedValue: 100 });
  h.prime();
  h.controller.onSliderInput(150); // starts the session
  await tick(THROTTLE_MS * 2);
  h.controller.onSliderInput(170); // pure input while active
  h.controller.onSliderInput(190);
  await tick(THROTTLE_MS * 2);
  assert.deepEqual(h.persistCalls, [], 'input alone never persists, even on a saved page');
  assert.equal(h.offscreenLiveGain, 190);
});
