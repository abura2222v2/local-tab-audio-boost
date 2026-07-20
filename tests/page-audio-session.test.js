// Tests for the service worker's page-audio frame registry.
// See shared/page-audio-session.js.
//
// Two properties matter here and are easy to get wrong:
//  - the registry stays BOUNDED (nothing accumulates across cycles), and
//  - a reply from an old document generation can never mutate a newer record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageAudioRegistry } from '../shared/page-audio-session.js';
import { PAGE_AUDIO_STATES } from '../shared/page-audio-policy.js';

const TAB = 101;
const OTHER_TAB = 202;
const OP = 'op-1';

function seed(registry, { tabId = TAB, frameId = 0, operationToken = OP, documentId = 'doc-1', state = PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA } = {}) {
  registry.setFrame(tabId, frameId, { operationToken, documentId, state, gainPercent: 100 });
}

test('registry: a frame can be recorded, read back, and listed', () => {
  const registry = createPageAudioRegistry();
  seed(registry);
  const frame = registry.getFrame(TAB, 0);
  assert.equal(frame.frameId, 0);
  assert.equal(frame.operationToken, OP);
  assert.deepEqual(registry.listFrames(TAB).map((f) => f.frameId), [0]);
  assert.deepEqual(registry.size(), { tabs: 1, frames: 1 });
});

test('registry: frames are listed per operation generation', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { frameId: 0, operationToken: OP });
  seed(registry, { frameId: 1, operationToken: 'op-2' });
  assert.deepEqual(registry.listFramesForOperation(TAB, OP).map((f) => f.frameId), [0]);
  assert.deepEqual(registry.listFramesForOperation(TAB, 'op-2').map((f) => f.frameId), [1]);
});

test('registry #6: removing a frame drops it, and the tab entry disappears when empty', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { frameId: 0 });
  seed(registry, { frameId: 3 });
  assert.deepEqual(registry.size(), { tabs: 1, frames: 2 });

  registry.removeFrame(TAB, 3);
  assert.deepEqual(registry.size(), { tabs: 1, frames: 1 });

  registry.removeFrame(TAB, 0);
  // The empty per-tab Map must not linger - that is how a bounded structure
  // quietly becomes unbounded across many tabs.
  assert.deepEqual(registry.size(), { tabs: 0, frames: 0 });
});

test('registry #7: a top-level navigation invalidates every frame of that tab only', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { tabId: TAB, frameId: 0 });
  seed(registry, { tabId: TAB, frameId: 1 });
  seed(registry, { tabId: OTHER_TAB, frameId: 0 });

  registry.invalidateTab(TAB);
  assert.deepEqual(registry.listFrames(TAB), [], 'the navigated tab is emptied');
  assert.equal(registry.listFrames(OTHER_TAB).length, 1, 'an unrelated tab is untouched');
  assert.deepEqual(registry.size(), { tabs: 1, frames: 1 });
});

test('registry: a subframe navigation invalidates only that frame', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { frameId: 0 });
  seed(registry, { frameId: 5 });

  registry.invalidateFrame(TAB, 5);
  assert.deepEqual(registry.listFrames(TAB).map((f) => f.frameId), [0], 'the top frame survives');
});

test('registry: a removed tab leaves no record behind', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { frameId: 0 });
  seed(registry, { frameId: 1 });
  registry.removeTab(TAB);
  assert.deepEqual(registry.size(), { tabs: 0, frames: 0 });
});

test('registry #28: a documentId change drops the stale record', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { documentId: 'doc-old' });

  assert.equal(registry.reconcileDocument(TAB, 0, 'doc-old'), false, 'same document - nothing to do');
  assert.equal(registry.reconcileDocument(TAB, 0, 'doc-new'), true, 'a new document invalidates the old record');
  assert.equal(registry.getFrame(TAB, 0), null);
});

test('registry #27: a state update from a SUPERSEDED operation is rejected', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { operationToken: OP, state: PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA });

  const rejected = registry.updateFrameState(TAB, 0, 'stale-op', { gainPercent: 40 });
  assert.equal(rejected, false, 'a stale generation cannot mutate the record');
  assert.equal(registry.getFrame(TAB, 0).gainPercent, 100, 'the value is untouched');

  const accepted = registry.updateFrameState(TAB, 0, OP, { gainPercent: 220 });
  assert.equal(accepted, true);
  assert.equal(registry.getFrame(TAB, 0).gainPercent, 220);
});

test('registry: updating a frame that no longer exists is a safe no-op', () => {
  const registry = createPageAudioRegistry();
  assert.equal(registry.updateFrameState(TAB, 0, OP, { gainPercent: 200 }), false);
});

test('registry: hasRunningFrames reflects only the given operation generation', () => {
  const registry = createPageAudioRegistry();
  seed(registry, { frameId: 0, state: PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA });
  assert.equal(registry.hasRunningFrames(TAB, OP), true, 'armed counts as running');

  registry.updateFrameState(TAB, 0, OP, { state: PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA });
  assert.equal(registry.hasRunningFrames(TAB, OP), false);
  assert.equal(registry.hasRunningFrames(TAB, 'other-op'), false, 'a different generation never counts');
});

test('registry #8: many enable/disable cycles leave the registry empty and bounded', () => {
  const registry = createPageAudioRegistry();
  for (let cycle = 0; cycle < 10; cycle += 1) {
    const token = `op-${cycle}`;
    seed(registry, { frameId: 0, operationToken: token, documentId: `doc-${cycle}` });
    seed(registry, { frameId: 1, operationToken: token, documentId: `doc-${cycle}` });
    assert.deepEqual(registry.size(), { tabs: 1, frames: 2 }, `cycle ${cycle} holds only its own frames`);
    registry.removeTab(TAB);
    assert.deepEqual(registry.size(), { tabs: 0, frames: 0 }, `cycle ${cycle} released everything`);
  }
});

test('registry: many navigations across many tabs never accumulate records', () => {
  const registry = createPageAudioRegistry();
  for (let tabId = 1; tabId <= 25; tabId += 1) {
    seed(registry, { tabId, frameId: 0, documentId: `d-${tabId}` });
    registry.invalidateTab(tabId);
  }
  assert.deepEqual(registry.size(), { tabs: 0, frames: 0 });
});
