// Tests for the offscreen idle-close scheduler. See shared/offscreen-idle.js.
//
// Closing the offscreen document reclaims a whole renderer process, but it is
// only safe when the compatibility backend genuinely holds nothing. The
// hazards being pinned down here are the classic ones for a debounced
// destructive timer: a stale timer firing after work resumed, and state that
// was idle at scheduling time but busy by firing time.
//
// The clock is injected, so none of this needs a real sleep.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOffscreenIdleCloser } from '../shared/offscreen-idle.js';

function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutFn(fn, delay) {
      const id = nextId++;
      pending.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    async advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending.entries()]) {
        if (entry.at <= now) {
          pending.delete(id);
          await entry.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

function makeCloser({ idle = true, delayMs = 10000 } = {}) {
  const clock = createFakeClock();
  const state = { idle, closes: 0, documentExists: true };
  const closer = createOffscreenIdleCloser({
    isIdle: () => state.idle,
    closeDocument: async () => {
      if (!state.documentExists) return;
      state.closes += 1;
      state.documentExists = false;
    },
    delayMs,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
  return { closer, clock, state };
}

test('idle-close #16: a close is scheduled only when the backend is fully idle', () => {
  const busy = makeCloser({ idle: false });
  assert.equal(busy.closer.schedule(), false, 'a busy backend never arms the timer');
  assert.equal(busy.closer.isScheduled(), false);

  const idle = makeCloser({ idle: true });
  assert.equal(idle.closer.schedule(), true);
  assert.equal(idle.closer.isScheduled(), true);
});

test('idle-close #19: the document closes once the debounce elapses', async () => {
  const { closer, clock, state } = makeCloser({ delayMs: 10000 });
  closer.schedule();

  await clock.advance(9999);
  assert.equal(state.closes, 0, 'not closed before the debounce elapses');

  await clock.advance(1);
  assert.equal(state.closes, 1, 'closed exactly once');
});

test('idle-close #17: a new start cancels a pending close', async () => {
  const { closer, clock, state } = makeCloser();
  closer.schedule();
  assert.equal(closer.isScheduled(), true);

  closer.cancel(); // a compatibility start came in
  assert.equal(closer.isScheduled(), false);

  await clock.advance(60000);
  assert.equal(state.closes, 0, 'the cancelled close never ran');
});

test('idle-close #18: a stale timer cannot close a document that became busy again', async () => {
  const { closer, clock, state } = makeCloser({ delayMs: 10000 });
  closer.schedule();

  await clock.advance(5000);
  // Work resumes: the service worker cancels, then the work finishes and it
  // schedules again. The FIRST timer must not close anything.
  closer.cancel();
  state.idle = false;

  await clock.advance(20000);
  assert.equal(state.closes, 0, 'the superseded timer did not fire a close');
});

test('idle-close: state is re-checked at FIRING time, not only at scheduling time', async () => {
  const { closer, clock, state } = makeCloser({ delayMs: 10000 });
  closer.schedule(); // idle when scheduled

  // A session starts without going through cancel() (defensive: the check must
  // not rely solely on cancellation).
  state.idle = false;

  await clock.advance(20000);
  assert.equal(state.closes, 0, 'the last-moment authoritative re-check prevented the close');
});

test('idle-close: repeated scheduling debounces instead of stacking timers', async () => {
  const { closer, clock, state } = makeCloser({ delayMs: 10000 });
  closer.schedule();
  await clock.advance(5000);
  closer.schedule(); // restarts the debounce
  await clock.advance(5000);
  assert.equal(state.closes, 0, 'the restarted debounce has not elapsed yet');
  assert.equal(clock.pendingCount(), 1, 'exactly one timer is ever pending');

  await clock.advance(5000);
  assert.equal(state.closes, 1);
});

test('idle-close: an already-closed document is tolerated', async () => {
  const { closer, clock, state } = makeCloser({ delayMs: 1000 });
  state.documentExists = false; // Chrome closed it for its own reasons
  closer.schedule();
  await clock.advance(1000);
  assert.equal(state.closes, 0, 'no error, and nothing to close');
});

test('idle-close: a close that throws never wedges the scheduler', async () => {
  const clock = createFakeClock();
  let attempts = 0;
  const closer = createOffscreenIdleCloser({
    isIdle: () => true,
    closeDocument: async () => {
      attempts += 1;
      throw new Error('closeDocument failed');
    },
    delayMs: 1000,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  closer.schedule();
  await clock.advance(1000);
  assert.equal(attempts, 1);

  // The scheduler still works afterwards.
  closer.schedule();
  await clock.advance(1000);
  assert.equal(attempts, 2, 'a failed close did not leave the scheduler stuck');
});

test('idle-close: a close approved before its async gap re-checks validity before acting', async () => {
  // The real closeDocument has to await Chrome before it can act. If a
  // compatibility start creates and uses a document during that gap, the
  // in-flight close must abandon rather than tear it down.
  const clock = createFakeClock();
  let idle = true;
  let closes = 0;
  let releaseLookup;
  const lookupGate = new Promise((resolve) => {
    releaseLookup = resolve;
  });

  const closer = createOffscreenIdleCloser({
    isIdle: () => idle,
    closeDocument: async (stillIdle) => {
      await lookupGate; // stands in for the awaited Chrome lookup
      if (!stillIdle()) return;
      closes += 1;
    },
    delayMs: 100,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  closer.schedule();
  const fired = clock.advance(100); // the callback runs and blocks on the gate

  // A new compatibility start lands while the close is mid-flight.
  idle = false;
  closer.cancel();

  releaseLookup();
  await fired;

  assert.equal(closes, 0, 'the in-flight close abandoned instead of closing a newly-busy document');
});

test('idle-close: an in-flight close still completes when nothing changed during the gap', async () => {
  const clock = createFakeClock();
  let closes = 0;
  let releaseLookup;
  const lookupGate = new Promise((resolve) => {
    releaseLookup = resolve;
  });

  const closer = createOffscreenIdleCloser({
    isIdle: () => true,
    closeDocument: async (stillIdle) => {
      await lookupGate;
      if (!stillIdle()) return;
      closes += 1;
    },
    delayMs: 100,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });

  closer.schedule();
  const fired = clock.advance(100);
  releaseLookup();
  await fired;

  assert.equal(closes, 1, 'a genuinely idle backend still gets its document closed');
});
