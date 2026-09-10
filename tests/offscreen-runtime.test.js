import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TARGETS, MESSAGE_TYPES, ERROR_CODES } from '../shared/constants.js';

let runtimeListener = null;
const outgoingMessages = [];

globalThis.chrome = {
  runtime: {
    id: 'offscreen-runtime-test',
    getURL: (path) => `chrome-extension://offscreen-runtime-test/${path}`,
    onMessage: {
      addListener(listener) {
        runtimeListener = listener;
      },
    },
    async sendMessage(message) {
      outgoingMessages.push(message);
      return { ok: true, data: {} };
    },
  },
};

class FakeTrack {
  constructor() {
    this.stopCount = 0;
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    this.listeners.set(type, listener);
  }

  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }

  stop() {
    this.stopCount += 1;
  }

  end() {
    this.listeners.get('ended')?.();
  }
}

class FakeStream {
  constructor(tracks = [new FakeTrack()]) {
    this.tracks = tracks;
  }

  getTracks() {
    return this.tracks;
  }
}

class FakeAudioNode {
  constructor() {
    this.connections = [];
    this.disconnectCount = 0;
  }

  connect(target) {
    this.connections.push(target);
  }

  disconnect() {
    this.disconnectCount += 1;
  }
}

class FakeGainNode extends FakeAudioNode {
  constructor() {
    super();
    this.ramps = [];
    this.gain = {
      value: 1,
      setTargetAtTime: (value, currentTime, timeConstant) => {
        this.ramps.push({ value, currentTime, timeConstant });
      },
    };
  }
}

const audioContexts = [];

class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.currentTime = 12;
    this.destination = {};
    this.sources = [];
    this.gains = [];
    this.resumeCount = 0;
    this.suspendCount = 0;
    audioContexts.push(this);
  }

  createMediaStreamSource(stream) {
    const node = new FakeAudioNode();
    node.stream = stream;
    this.sources.push(node);
    return node;
  }

  createGain() {
    const node = new FakeGainNode();
    this.gains.push(node);
    return node;
  }

  async resume() {
    this.resumeCount += 1;
    this.state = 'running';
  }

  async suspend() {
    this.suspendCount += 1;
    this.state = 'suspended';
  }
}

globalThis.AudioContext = FakeAudioContext;

let getUserMediaImpl = async () => new FakeStream();
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: {
    mediaDevices: {
      getUserMedia: (constraints) => getUserMediaImpl(constraints),
    },
  },
});

await import('../offscreen/offscreen.js');
assert.equal(typeof runtimeListener, 'function', 'the real offscreen module registered its message listener');

let requestSequence = 0;

function dispatch(type, payload, sender = { id: chrome.runtime.id }) {
  requestSequence += 1;
  const message = {
    target: TARGETS.OFFSCREEN,
    type,
    requestId: `offscreen-runtime-${requestSequence}`,
    payload,
  };

  return new Promise((resolve) => {
    const keepChannelOpen = runtimeListener(message, sender, resolve);
    assert.equal(keepChannelOpen, true);
  });
}

function startPayload(tabId, operationId, gainPercent = 100) {
  return {
    tabId,
    streamId: `stream-${tabId}`,
    operationId,
    pageKey: `https://example.com/player/${tabId}`,
    gainPercent,
  };
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('offscreen runtime: real message lifecycle builds, updates, enumerates, and tears down one audio graph', async () => {
  let capturedConstraints = null;
  const track = new FakeTrack();
  const stream = new FakeStream([track]);
  getUserMediaImpl = async (constraints) => {
    capturedConstraints = constraints;
    return stream;
  };

  const started = await dispatch(MESSAGE_TYPES.START_CAPTURE, startPayload(7, 'op-7', 175));
  assert.deepEqual(started, { ok: true, data: { tabId: 7, operationId: 'op-7' } });
  assert.deepEqual(capturedConstraints, {
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: 'stream-7' } },
    video: false,
  });

  const context = audioContexts.at(-1);
  assert.equal(context.gains.length, 1);
  assert.equal(context.gains[0].gain.value, 1.75);
  assert.equal(track.listeners.has('ended'), true);

  const active = await dispatch(MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {});
  assert.deepEqual(active.data, {
    sessions: [{ tabId: 7, operationId: 'op-7', pageKey: 'https://example.com/player/7', gainPercent: 175 }],
    pending: [],
  });

  const changed = await dispatch(MESSAGE_TYPES.SET_TAB_GAIN, { tabId: 7, operationId: 'op-7', gainPercent: 240 });
  assert.deepEqual(changed, { ok: true, data: { tabId: 7, gainPercent: 240 } });
  assert.deepEqual(context.gains[0].ramps, [{ value: 2.4, currentTime: 12, timeConstant: 0.01 }]);

  const stopped = await dispatch(MESSAGE_TYPES.STOP_CAPTURE, {
    tabId: 7,
    operationId: 'op-7',
    force: false,
    reason: 'user_disabled',
  });
  assert.equal(stopped.data.status, 'stopped');
  assert.equal(track.stopCount, 1);
  assert.equal(track.listeners.has('ended'), false);
  assert.equal(context.sources[0].disconnectCount, 1);
  assert.equal(context.gains[0].disconnectCount, 1);
  assert.equal(context.state, 'suspended');

  const idle = await dispatch(MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {});
  assert.deepEqual(idle.data, { sessions: [], pending: [] });
  assert.ok(
    outgoingMessages.some(
      (message) => message.target === TARGETS.SERVICE_WORKER && message.type === MESSAGE_TYPES.SESSION_STOPPED,
    ),
  );
});

test('offscreen runtime: STOP cancels a pending getUserMedia operation and abandons its eventual stream', async () => {
  let resolveStream;
  const abandonedTrack = new FakeTrack();
  getUserMediaImpl = () =>
    new Promise((resolve) => {
      resolveStream = resolve;
    });

  const starting = dispatch(MESSAGE_TYPES.START_CAPTURE, startPayload(8, 'op-8'));
  await nextTurn();

  const whilePending = await dispatch(MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {});
  assert.deepEqual(whilePending.data, { sessions: [], pending: [{ tabId: 8, operationId: 'op-8' }] });

  const stopped = await dispatch(MESSAGE_TYPES.STOP_CAPTURE, {
    tabId: 8,
    operationId: 'op-8',
    force: false,
    reason: 'user_disabled',
  });
  assert.equal(stopped.data.status, 'pending_cancelled');

  resolveStream(new FakeStream([abandonedTrack]));
  const cancelled = await starting;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.error.code, ERROR_CODES.ALREADY_IN_PROGRESS);
  assert.equal(abandonedTrack.stopCount, 1);

  const idle = await dispatch(MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {});
  assert.deepEqual(idle.data, { sessions: [], pending: [] });
});

test('offscreen runtime: an ended track tears down the graph and reports a capture failure', async () => {
  const track = new FakeTrack();
  getUserMediaImpl = async () => new FakeStream([track]);
  const outgoingBefore = outgoingMessages.length;

  const started = await dispatch(MESSAGE_TYPES.START_CAPTURE, startPayload(9, 'op-9', 130));
  assert.equal(started.ok, true);
  track.end();
  await nextTurn();
  await nextTurn();

  const idle = await dispatch(MESSAGE_TYPES.GET_ACTIVE_SESSIONS, {});
  assert.deepEqual(idle.data, { sessions: [], pending: [] });
  assert.equal(track.stopCount, 1);

  const newOutgoing = outgoingMessages.slice(outgoingBefore);
  const errorMessage = newOutgoing.find((message) => message.type === MESSAGE_TYPES.SESSION_ERROR);
  assert.equal(errorMessage?.target, TARGETS.SERVICE_WORKER);
  assert.deepEqual(errorMessage?.payload, {
    tabId: 9,
    operationId: 'op-9',
    code: ERROR_CODES.CAPTURE_FAILED,
    message: 'Audio capture stopped unexpectedly.',
  });
});

test('offscreen runtime: invalid and stale commands return structured errors without changing audio', async () => {
  getUserMediaImpl = async () => new FakeStream();

  const invalid = await dispatch(MESSAGE_TYPES.START_CAPTURE, { tabId: 10 });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error.code, ERROR_CODES.INVALID_MESSAGE);

  const started = await dispatch(MESSAGE_TYPES.START_CAPTURE, startPayload(10, 'op-10'));
  assert.equal(started.ok, true);

  const duplicate = await dispatch(MESSAGE_TYPES.START_CAPTURE, startPayload(10, 'op-duplicate'));
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.error.code, ERROR_CODES.ALREADY_IN_PROGRESS);

  const staleGain = await dispatch(MESSAGE_TYPES.SET_TAB_GAIN, { tabId: 10, operationId: 'op-stale', gainPercent: 200 });
  assert.equal(staleGain.ok, false);
  assert.equal(staleGain.error.code, ERROR_CODES.NOT_ACTIVE);

  const staleStop = await dispatch(MESSAGE_TYPES.STOP_CAPTURE, {
    tabId: 10,
    operationId: 'op-stale',
    force: false,
    reason: 'user_disabled',
  });
  assert.equal(staleStop.data.status, 'operation_mismatch');

  const forcedStop = await dispatch(MESSAGE_TYPES.STOP_CAPTURE, {
    tabId: 10,
    force: true,
    reason: 'emergency_fail_closed',
  });
  assert.equal(forcedStop.data.status, 'stopped');
});
