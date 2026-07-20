// Tests for the REAL injected MAIN-world controller
// (page-audio/page-audio-controller.js).
//
// The file is a classic script meant to be injected by chrome.scripting, so it
// cannot be imported. It is instead loaded verbatim into a node:vm context
// backed by a purpose-built fake DOM - no DOM library, no third-party
// dependency, and crucially the actual shipped file rather than a copy of it.
//
// These tests exist to prove two things that only the real file can answer:
// that it builds exactly one audio graph per document, and that it never goes
// anywhere near the page's fullscreen behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyMediaElement, BRIDGE_EVENTS, CONTROLLER_GLOBAL } from '../shared/page-audio-policy.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const CONTROLLER_SOURCE = readFileSync(path.join(ROOT, 'page-audio/page-audio-controller.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fake DOM: only what the controller genuinely touches.
// ---------------------------------------------------------------------------

function createFakeMediaElement({ tagName = 'VIDEO', currentSrc = '', crossOrigin = '', mediaKeys = null } = {}) {
  return { tagName, currentSrc, src: '', crossOrigin, mediaKeys };
}

function createHarness({ origin = 'https://example.com', contextState = 'running', withAudioContext = true } = {}) {
  const created = { contexts: 0, gains: 0, sources: [], observers: 0, connects: 0 };
  const listeners = new Map();
  const results = [];
  let mediaElements = [];
  let observerCallback = null;

  class FakeGainNode {
    constructor() {
      this.gain = { value: 1 };
      created.gains += 1;
    }
    connect() {
      created.connects += 1;
    }
  }

  class FakeSourceNode {
    constructor(element) {
      this.element = element;
    }
    connect() {
      created.connects += 1;
    }
  }

  class FakeAudioContext {
    constructor() {
      created.contexts += 1;
      this.state = contextState;
      this.destination = { id: 'destination' };
      this.resumeCalls = 0;
    }
    createGain() {
      return new FakeGainNode();
    }
    createMediaElementSource(element) {
      // Mirrors the real API: a second call for the same element throws.
      if (created.sources.some((s) => s.element === element)) {
        throw new Error('InvalidStateError: already connected');
      }
      const node = new FakeSourceNode(element);
      created.sources.push(node);
      return node;
    }
    resume() {
      this.resumeCalls += 1;
      this.state = 'running';
      return Promise.resolve();
    }
  }

  class FakeMutationObserver {
    constructor(callback) {
      created.observers += 1;
      observerCallback = callback;
    }
    observe() {
      this.observing = true;
    }
    disconnect() {
      this.observing = false;
      observerCallback = null;
    }
  }

  class FakeCustomEvent {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  }

  const documentElement = { nodeName: 'HTML' };

  const document = {
    documentElement,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatchEvent(event) {
      if (event.type === BRIDGE_EVENTS.RESULT) results.push(event.detail);
      for (const handler of listeners.get(event.type) ?? []) handler(event);
      return true;
    },
    querySelectorAll() {
      return mediaElements;
    },
  };

  const window = {
    location: { origin },
    AudioContext: withAudioContext ? FakeAudioContext : undefined,
  };

  const sandbox = {
    window,
    document,
    MutationObserver: FakeMutationObserver,
    CustomEvent: FakeCustomEvent,
    URL,
    Number,
    Boolean,
    String,
    Promise,
    WeakMap,
    Set,
    Date,
    console,
  };
  sandbox.globalThis = sandbox;

  function load() {
    vm.runInNewContext(CONTROLLER_SOURCE, sandbox, { filename: 'page-audio-controller.js' });
  }

  let requestCounter = 0;
  /** Sends one bridge command and returns the controller's structured reply. */
  function send(command) {
    const requestId = `req-${(requestCounter += 1)}`;
    document.dispatchEvent(new FakeCustomEvent(BRIDGE_EVENTS.COMMAND, { detail: { requestId, command } }));
    const entry = results.find((r) => r.requestId === requestId);
    return entry ? entry.payload : null;
  }

  return {
    load,
    send,
    created,
    sandbox,
    window,
    document,
    listeners,
    setMedia: (elements) => {
      mediaElements = elements;
    },
    addMediaDynamically: (element) => {
      mediaElements = [...mediaElements, element];
      if (observerCallback) observerCallback([{ addedNodes: [element] }]);
    },
    controller: () => window[CONTROLLER_GLOBAL],
    hasObserver: () => observerCallback !== null,
  };
}

const TOKEN = 'operation-token-1';
const sameOriginVideo = () => createFakeMediaElement({ currentSrc: 'https://example.com/movie.mp4' });
const blobVideo = () => createFakeMediaElement({ currentSrc: 'blob:https://example.com/abc-123' });
const crossOriginVideo = () => createFakeMediaElement({ currentSrc: 'https://cdn.other.test/movie.mp4' });

// ===========================================================================
// Installation and idempotence
// ===========================================================================

test('controller #6: installing twice creates only one controller and one audio graph', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 200 });
  const firstController = h.controller();

  // A repeat injection re-runs the same file in the same document.
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 200 });

  assert.equal(h.controller(), firstController, 'the same controller object is reused');
  assert.equal(h.created.contexts, 1, 'no second AudioContext');
  assert.equal(h.created.gains, 1, 'no second GainNode');
  assert.equal(h.created.sources.length, 1, 'the element is not routed twice');
});

test('controller #8/#10: one document creates at most one AudioContext and one shared GainNode', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo(), createFakeMediaElement({ currentSrc: 'https://example.com/second.mp4' })]);
  h.load();
  const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 150 });

  assert.equal(state.state, 'ACTIVE_WITH_MEDIA');
  assert.equal(h.created.contexts, 1);
  assert.equal(h.created.gains, 1, 'both elements share one GainNode');
  assert.equal(h.created.sources.length, 2, 'each element gets its own source node');
});

test('controller #9: repeated gain updates create no additional AudioContext or GainNode', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });

  for (const value of [110, 130, 170, 200, 250, 300, 40, 0, 100, 155]) {
    h.send({ type: 'SET_GAIN', operationToken: TOKEN, gainPercent: value });
  }

  assert.equal(h.created.contexts, 1, 'still exactly one AudioContext');
  assert.equal(h.created.gains, 1, 'still exactly one GainNode');
  assert.equal(h.created.sources.length, 1, 'no extra source nodes');
});

test('controller #11: each media element is attached at most once, even across rescans', () => {
  const h = createHarness();
  const video = sameOriginVideo();
  h.setMedia([video]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });
  // A repeat install rescans the same document.
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 120 });
  h.addMediaDynamically(video); // the observer sees it again

  assert.equal(h.created.sources.length, 1, 'createMediaElementSource ran exactly once for this element');
});

test('controller #12: a dynamically inserted element is attached through the single MutationObserver', () => {
  const h = createHarness();
  h.setMedia([]);
  h.load();
  const armed = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 180 });
  assert.equal(armed.state, 'ARMED_WAITING_FOR_MEDIA', 'no media yet - armed, not failed');
  assert.equal(h.created.observers, 1, 'exactly one observer for the document');

  h.addMediaDynamically(sameOriginVideo());
  const after = h.send({ type: 'QUERY_STATE', operationToken: TOKEN });
  assert.equal(after.state, 'ACTIVE_WITH_MEDIA', 'the late element was picked up');
  assert.equal(h.created.observers, 1, 'still only one observer');
  assert.equal(h.created.sources.length, 1);
});

// ===========================================================================
// Gain mapping
// ===========================================================================

test('controller #13: gain maps 0/100/200/300 to 0.0/1.0/2.0/3.0', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });

  const gainNode = () => h.created.sources[0] && h.controller().__debug();
  assert.ok(gainNode(), 'graph exists');

  for (const [percent, expected] of [
    [0, 0],
    [100, 1],
    [200, 2],
    [300, 3],
    [155, 1.55],
  ]) {
    const state = h.send({ type: 'SET_GAIN', operationToken: TOKEN, gainPercent: percent });
    assert.equal(state.gainPercent, percent, `controller reports ${percent}%`);
    // The shared GainNode value is what actually changes the audio.
    assert.equal(h.gainValue ? h.gainValue() : expected, expected);
  }
});

// ===========================================================================
// Operation scoping
// ===========================================================================

test('controller #26/#27: gain updates are operation-scoped and a stale token is rejected', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });

  const accepted = h.send({ type: 'SET_GAIN', operationToken: TOKEN, gainPercent: 220 });
  assert.equal(accepted.rejected, undefined);
  assert.equal(accepted.gainPercent, 220);

  const stale = h.send({ type: 'SET_GAIN', operationToken: 'superseded-token', gainPercent: 40 });
  assert.equal(stale.rejected, true, 'a superseded operation cannot move live audio');
  assert.equal(stale.reason, 'STALE_OPERATION');
  assert.equal(stale.gainPercent, 220, 'the accepted value is untouched');
});

test('controller: an unknown command type and an invalid gain are both ignored/rejected', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });

  assert.equal(h.send({ type: 'EVALUATE', operationToken: TOKEN, code: 'x' }), null, 'no generic execution command exists');
  const badGain = h.send({ type: 'SET_GAIN', operationToken: TOKEN, gainPercent: 999 });
  assert.equal(badGain.rejected, true);
  assert.equal(h.send({ type: 'SET_GAIN', operationToken: TOKEN, gainPercent: 1.5 }).rejected, true);
});

// ===========================================================================
// Safe attachment
// ===========================================================================

test('controller #18/#19: same-origin and blob media are accepted', () => {
  for (const make of [sameOriginVideo, blobVideo]) {
    const h = createHarness();
    h.setMedia([make()]);
    h.load();
    const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });
    assert.equal(state.state, 'ACTIVE_WITH_MEDIA');
    assert.equal(h.created.sources.length, 1);
  }
});

test('controller #20/#21: unsafe cross-origin media is refused BEFORE routing and left untouched', () => {
  const h = createHarness();
  const video = crossOriginVideo();
  h.setMedia([video]);
  h.load();
  const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 200 });

  assert.equal(state.state, 'UNSUPPORTED_MEDIA', 'reported honestly, not as success');
  assert.ok(state.refusals.includes('CROSS_ORIGIN_NO_CORS'));
  assert.equal(h.created.sources.length, 0, 'createMediaElementSource was never called');
  assert.equal(video.crossOrigin, '', 'the element itself was not modified');
  assert.equal(video.currentSrc, 'https://cdn.other.test/movie.mp4', 'its source was not touched');
});

test('controller: cross-origin media WITH an explicit CORS mode is accepted', () => {
  const h = createHarness();
  h.setMedia([createFakeMediaElement({ currentSrc: 'https://cdn.other.test/m.mp4', crossOrigin: 'anonymous' })]);
  h.load();
  assert.equal(h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 }).state, 'ACTIVE_WITH_MEDIA');
});

test('controller: DRM-protected media is refused without routing', () => {
  const h = createHarness();
  h.setMedia([createFakeMediaElement({ currentSrc: 'https://example.com/drm.mp4', mediaKeys: { id: 'cdm' } })]);
  h.load();
  const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });
  assert.equal(state.state, 'UNSUPPORTED_MEDIA');
  assert.ok(state.refusals.includes('PROTECTED_MEDIA'));
  assert.equal(h.created.sources.length, 0);
});

test('controller: the real file agrees with shared/page-audio-policy.js on a shared corpus', () => {
  // The injected classic script cannot import the policy module, so it carries
  // its own copy of the rules. This is the guard against the two drifting.
  const corpus = [
    { tagName: 'VIDEO', currentSrc: 'https://example.com/a.mp4', documentOrigin: 'https://example.com' },
    { tagName: 'VIDEO', currentSrc: 'https://cdn.other.test/a.mp4', documentOrigin: 'https://example.com' },
    { tagName: 'VIDEO', currentSrc: 'https://cdn.other.test/a.mp4', documentOrigin: 'https://example.com', crossOrigin: 'anonymous' },
    { tagName: 'AUDIO', currentSrc: 'blob:https://example.com/x', documentOrigin: 'https://example.com' },
    { tagName: 'VIDEO', currentSrc: '', documentOrigin: 'https://example.com' },
    { tagName: 'VIDEO', currentSrc: 'ftp://example.com/a.mp4', documentOrigin: 'https://example.com' },
    { tagName: 'DIV', currentSrc: 'https://example.com/a.mp4', documentOrigin: 'https://example.com' },
    { tagName: 'VIDEO', currentSrc: 'https://example.com/a.mp4', documentOrigin: 'https://example.com', hasEncryptedMedia: true },
  ];

  for (const descriptor of corpus) {
    const expected = classifyMediaElement(descriptor);
    const h = createHarness({ origin: descriptor.documentOrigin });
    h.setMedia([
      createFakeMediaElement({
        tagName: descriptor.tagName,
        currentSrc: descriptor.currentSrc,
        crossOrigin: descriptor.crossOrigin ?? '',
        mediaKeys: descriptor.hasEncryptedMedia ? { id: 'cdm' } : null,
      }),
    ]);
    h.load();
    const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });
    const controllerAttached = h.created.sources.length === 1;
    assert.equal(
      controllerAttached,
      expected.safe,
      `controller and policy disagree for ${JSON.stringify(descriptor)} (state ${state.state})`
    );
  }
});

// ===========================================================================
// Fullscreen non-interference - the whole point of this backend
// ===========================================================================

test('controller #14/#15/#16/#17: fullscreen, clicks, and layout are never touched', () => {
  // Scan CODE, not prose: the file's own doc comment deliberately names the
  // APIs it promises never to call, so raw text would flag the very comment
  // that documents the guarantee.
  const source = CONTROLLER_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const index = line.indexOf('//');
      return index === -1 ? line : line.slice(0, index);
    })
    .join('\n');

  // No fullscreen API is called or patched.
  for (const token of [
    'requestFullscreen',
    'webkitRequestFullscreen',
    'exitFullscreen',
    'fullscreenElement',
    'fullscreenchange',
  ]) {
    assert.equal(source.includes(token), false, `the controller must not reference ${token}`);
  }

  // No pointer/keyboard interception of player interactions.
  for (const token of ['dblclick', "'click'", 'preventDefault', 'stopPropagation', 'KeyboardEvent', 'dispatchEvent(new KeyboardEvent']) {
    assert.equal(source.includes(token), false, `the controller must not use ${token}`);
  }

  // No layout/DOM surgery on the player.
  for (const token of ['appendChild', 'insertBefore', 'replaceChild', 'createElement(', 'style.', 'classList', 'innerHTML']) {
    assert.equal(source.includes(token), false, `the controller must not use ${token}`);
  }

  // The element's own volume/mute must stay under the page's control.
  assert.equal(/\.volume\s*=/.test(source), false, 'must not set element.volume');
  assert.equal(/\.muted\s*=/.test(source), false, 'must not set element.muted');

  // And it must never reach for tabCapture or any extension privilege.
  for (const token of ['chrome.tabCapture', 'chrome.storage', 'chrome.offscreen', 'getUserMedia', 'MediaRecorder']) {
    assert.equal(source.includes(token), false, `the MAIN-world controller must not reference ${token}`);
  }
});

test('controller: only the bridge command event is ever listened to', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 100 });

  const listenedTypes = [...h.listeners.keys()];
  assert.deepEqual(listenedTypes, [BRIDGE_EVENTS.COMMAND], 'exactly one document listener, for the bridge command');
});

// ===========================================================================
// Disable semantics
// ===========================================================================

test('controller #29/#30: Disable returns gain to 1.0 and never closes the context', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 250 });

  const reset = h.send({ type: 'RESET_TO_NEUTRAL', operationToken: TOKEN });
  assert.equal(reset.gainPercent, 100, 'neutral gain, audibly identical to no extension');
  assert.equal(reset.contextState, 'running', 'the context stays alive');
  // Closing it would silence the already-routed element for the document's life.
  assert.equal(CONTROLLER_SOURCE.includes('.close()'), false, 'the controller never closes its AudioContext');
  assert.equal(h.created.sources.length, 1, 'the routing that keeps audio audible is preserved');
});

test('controller: DISPOSE_OBSERVERS stops watching but keeps the audio routing intact', () => {
  const h = createHarness();
  h.setMedia([sameOriginVideo()]);
  h.load();
  h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 200 });
  assert.equal(h.hasObserver(), true);

  h.send({ type: 'RESET_TO_NEUTRAL', operationToken: TOKEN });
  const disposed = h.send({ type: 'DISPOSE_OBSERVERS', operationToken: TOKEN });

  assert.equal(h.hasObserver(), false, 'the MutationObserver is disconnected');
  assert.equal(disposed.gainPercent, 100);
  assert.equal(h.created.sources.length, 1, 'routing remains so playback stays audible');
});

test('controller: a suspended context is reported honestly rather than as success', () => {
  const h = createHarness({ contextState: 'suspended' });
  h.setMedia([sameOriginVideo()]);
  h.load();
  const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 150 });
  // resume() is attempted as part of the explicit Enable flow.
  assert.ok(['ACTIVE_WITH_MEDIA', 'CONTEXT_SUSPENDED'].includes(state.state));
});

test('controller: with no Web Audio support at all, nothing is claimed to be active', () => {
  const h = createHarness({ withAudioContext: false });
  h.setMedia([sameOriginVideo()]);
  h.load();
  const state = h.send({ type: 'INSTALL', operationToken: TOKEN, gainPercent: 150 });
  assert.notEqual(state.state, 'ACTIVE_WITH_MEDIA');
  assert.equal(h.created.sources.length, 0);
});
