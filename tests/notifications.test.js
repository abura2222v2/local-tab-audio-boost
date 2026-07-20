// Deterministic tests for the Saved-pages status line. See
// shared/notifications.js.
//
// The scheduler is injected, so timing is driven by a fake clock rather than
// real sleeps: transient messages expire exactly when the configured delay
// elapses, and never a moment earlier.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotificationController, DEFAULT_NOTIFICATION_TIMEOUT_MS } from '../shared/notifications.js';

/** A minimal controllable clock: run pending callbacks whose deadline has passed. */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map(); // id -> {at, fn}
  return {
    setTimeoutFn(fn, delay) {
      const id = nextId++;
      pending.set(id, { at: now + delay, fn });
      return id;
    },
    clearTimeoutFn(id) {
      pending.delete(id);
    },
    advance(ms) {
      now += ms;
      for (const [id, entry] of [...pending.entries()]) {
        if (entry.at <= now) {
          pending.delete(id);
          entry.fn();
        }
      }
    },
    pendingCount: () => pending.size,
  };
}

function makeController({ timeoutMs = 4000 } = {}) {
  const clock = createFakeClock();
  const rendered = [];
  const controller = createNotificationController({
    render: (message, kind) => rendered.push({ message, kind }),
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    timeoutMs,
  });
  return { controller, clock, rendered, last: () => rendered[rendered.length - 1] };
}

test('notifications: the default auto-hide delay is about four seconds', () => {
  assert.equal(DEFAULT_NOTIFICATION_TIMEOUT_MS, 4000);
});

test('notifications #15: a success message is shown immediately', () => {
  const { controller, last } = makeController();
  controller.success('Reset 3 pages to 100%.');
  assert.deepEqual(last(), { message: 'Reset 3 pages to 100%.', kind: 'success' });
  assert.equal(controller.current().message, 'Reset 3 pages to 100%.');
});

test('notifications #16: a success message disappears after the configured delay', () => {
  const { controller, clock, last } = makeController({ timeoutMs: 4000 });
  controller.success('Deleted 2 saved pages.');

  clock.advance(3999);
  assert.equal(controller.current().message, 'Deleted 2 saved pages.', 'still visible just before the deadline');

  clock.advance(1);
  assert.equal(controller.current().message, '', 'cleared once the delay elapses');
  assert.deepEqual(last(), { message: '', kind: null });
});

test('notifications: an info message also auto-hides', () => {
  const { controller, clock } = makeController();
  controller.info('Selection cleared.');
  assert.equal(controller.current().kind, 'info');
  clock.advance(4000);
  assert.equal(controller.current().message, '');
});

test('notifications #17: a stale timer cannot erase a newer message', () => {
  const { controller, clock } = makeController({ timeoutMs: 4000 });
  controller.success('First message.');
  clock.advance(3000); // the first message's timer is still armed

  controller.success('Second message.');
  clock.advance(1000); // the FIRST message's original deadline passes here

  assert.equal(controller.current().message, 'Second message.', 'the newer message survives the older timer');

  clock.advance(3000); // the second message's own deadline
  assert.equal(controller.current().message, '', 'the newer message expires on its own schedule');
});

test('notifications #17b: an error replacing a success cancels the pending auto-hide', () => {
  const { controller, clock } = makeController({ timeoutMs: 4000 });
  controller.success('Reset 1 page to 100%.');
  clock.advance(3000);
  controller.error('Could not stop active boosting.');

  clock.advance(10000);
  assert.equal(
    controller.current().message,
    'Could not stop active boosting.',
    'the success timer must not clear the error that replaced it'
  );
});

test('notifications #18: an error never auto-hides', () => {
  const { controller, clock } = makeController({ timeoutMs: 4000 });
  controller.error('Failed to save changes.');
  assert.equal(controller.current().kind, 'error');

  clock.advance(60000);
  assert.deepEqual(controller.current(), { message: 'Failed to save changes.', kind: 'error' });
  assert.equal(clock.pendingCount(), 0, 'an error schedules no timer at all');
});

test('notifications: an error stays until another action replaces it', () => {
  const { controller, clock } = makeController();
  controller.error('Storage operation failed.');
  clock.advance(30000);
  assert.equal(controller.current().message, 'Storage operation failed.');

  controller.success('Deleted saved page.');
  assert.equal(controller.current().kind, 'success', 'a later action replaces the error');
});

test('notifications: clear() empties the line and cancels a pending timer', () => {
  const { controller, clock } = makeController();
  controller.success('Renamed page.');
  controller.clear();
  assert.equal(controller.current().message, '');
  assert.equal(clock.pendingCount(), 0);
});

test('notifications: a fresh controller starts empty (a reload shows no stale message)', () => {
  const { controller, rendered } = makeController();
  assert.deepEqual(controller.current(), { message: '', kind: null });
  assert.equal(rendered.length, 0, 'nothing is rendered until something is shown');
});
