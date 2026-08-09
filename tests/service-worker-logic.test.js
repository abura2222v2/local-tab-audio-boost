// Deterministic integration tests for service-worker.js's own coordination
// logic (message routing, operation cancellation, race safety, emergency
// cleanup, sender validation) driven directly under Node against a small,
// hand-rolled fake `chrome` environment and a configurable fake offscreen
// responder - no real Chrome, no real Web Audio, no third-party test
// libraries. The fake offscreen responder implements the same
// PendingStart/Session, operationId/force teardown, and structured
// STOP_CAPTURE status contract as the real offscreen/offscreen.js, which
// is what lets these tests exercise service-worker.js's real
// cancellation/timeout/cleanup code paths deterministically.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TARGETS,
  MESSAGE_TYPES,
  ERROR_CODES,
  OFFSCREEN_DOCUMENT_PATH,
  DEFAULT_VOLUME_PERCENT,
  MAX_TITLE_SNAPSHOT_LENGTH,
  MAX_CUSTOM_NAME_LENGTH,
  MAX_BULK_PAGE_KEYS,
} from '../shared/constants.js';
import { getDisplayName } from '../shared/saved-page-metadata.js';
import { filterSavedPageKeys } from '../shared/saved-pages-search.js';
import { registerMessageHandler, validateServiceWorkerOriginatedSender } from '../shared/messages.js';
import { canonicalizePageKey } from '../shared/urls.js';
import { createPopupController } from '../shared/popup-controller.js';
import {
  registerPendingStart,
  isStillPending,
  finalizePendingStart,
  decideAndApplyStopCapture,
  listSessionsForEnumeration,
  listPendingForEnumeration,
} from '../shared/offscreen-state.js';

const FAKE_EXTENSION_ID = 'fake-extension-id';
const ROOT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Fake offscreen responder: mirrors real offscreen.js's message contract -
// a PendingStart registered before the first await, operationId-scoped
// teardown unless force:true, "no double session/pending per tabId"
// rejection, and STOP_CAPTURE's structured
// {status: 'stopped'|'pending_cancelled'|'absent'|'operation_mismatch'}
// response - with hooks tests can use to inject delays, malformed
// responses, or dropped responses. `defaultStartCapture`/`defaultStopCapture`
// are exposed directly so a custom override can selectively intercept one
// tabId and pass everything else through to the real default logic.
// ---------------------------------------------------------------------------

function createOffscreenResponder() {
  const sessions = new Map(); // tabId -> {operationId, pageKey, gainPercent}
  const pending = new Map(); // tabId -> {tabId, operationId, cancelled}
  const startCapturePauses = new Map(); // operationId -> Promise

  let startCaptureOverride = null; // async (payload) => response
  let getActiveSessionsOverride = null; // async () => response
  let stopCaptureOverride = null; // async (payload) => response
  let setTabGainOverride = null; // async (payload) => response

  function pauseStartCapture(operationId) {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    startCapturePauses.set(operationId, gate);
    return () => {
      release();
      startCapturePauses.delete(operationId);
    };
  }

  // sessions here stores {operationId, pageKey, gainPercent} keyed by tabId
  // (no `tabId` field on the value itself) - listSessionsForEnumeration
  // (shared/offscreen-state.js) expects a Session-shaped object with its
  // own `tabId` field, exactly like the real offscreen.js's Map does, so a
  // thin per-call projection is used at the GET_ACTIVE_SESSIONS boundary
  // below rather than changing this Map's own storage shape everywhere.
  async function defaultStartCapture(payload) {
    const { tabId, operationId, pageKey, gainPercent } = payload;
    if (sessions.has(tabId) || pending.has(tabId)) {
      return { ok: false, error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'A session already exists for this tab.' } };
    }
    const pendingEntry = registerPendingStart(pending, tabId, operationId);
    try {
      if (startCapturePauses.has(operationId)) {
        await startCapturePauses.get(operationId);
      }
      if (!isStillPending(pending, tabId, pendingEntry)) {
        return {
          ok: false,
          error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'This operation was cancelled before capture completed.' },
        };
      }
      if (sessions.has(tabId)) {
        return { ok: false, error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'A session already exists for this tab.' } };
      }
      sessions.set(tabId, { operationId, pageKey, gainPercent });
      return { ok: true, data: { tabId, operationId } };
    } finally {
      finalizePendingStart(pending, tabId, pendingEntry);
    }
  }

  // Mirrors real offscreen.js's own handleStopCapture exactly - both call
  // the SAME shared decideAndApplyStopCapture (shared/offscreen-state.js),
  // so the STOP_CAPTURE status contract and PendingStart cancellation
  // semantics (including immediate removal on cancellation - review round
  // 4, fix #5) can never silently diverge between the fake and the real
  // implementation. Only the Session-teardown side effect itself (deleting
  // from `sessions`) is fake-specific, since the real one also has to tear
  // down an actual Web Audio graph.
  function defaultStopCapture(payload) {
    const { tabId, operationId, force, reason } = payload;
    void reason;
    const forced = force === true;
    const decision = decideAndApplyStopCapture({ tabId, operationId, force: forced, sessions, pendingStarts: pending });
    if (decision.status === 'stopped' && decision.matchedSession) {
      sessions.delete(tabId);
    }
    const { matchedSession, ...responseData } = decision;
    return { ok: true, data: responseData };
  }

  function defaultGetActiveSessions() {
    return {
      ok: true,
      data: {
        sessions: listSessionsForEnumeration(
          new Map([...sessions.entries()].map(([tabId, s]) => [tabId, { tabId, ...s }]))
        ),
        pending: listPendingForEnumeration(pending),
      },
    };
  }

  async function handle(message) {
    const { type, payload } = message;
    switch (type) {
      case MESSAGE_TYPES.START_CAPTURE:
        return startCaptureOverride ? startCaptureOverride(payload) : defaultStartCapture(payload);
      case MESSAGE_TYPES.STOP_CAPTURE:
        return stopCaptureOverride ? stopCaptureOverride(payload) : defaultStopCapture(payload);
      case MESSAGE_TYPES.SET_TAB_GAIN: {
        if (setTabGainOverride) return setTabGainOverride(payload);
        const session = sessions.get(payload.tabId);
        // Mirrors the real offscreen.js: a gain command whose operationId
        // does not match the session currently occupying this tabId is
        // rejected, exactly like STOP_CAPTURE's own operationId scoping.
        if (!session || session.operationId !== payload.operationId) {
          return { ok: false, error: { code: ERROR_CODES.NOT_ACTIVE, message: 'No active session for this tab.' } };
        }
        session.gainPercent = payload.gainPercent;
        return { ok: true, data: { tabId: payload.tabId, gainPercent: payload.gainPercent } };
      }
      case MESSAGE_TYPES.GET_ACTIVE_SESSIONS:
        return getActiveSessionsOverride ? getActiveSessionsOverride() : defaultGetActiveSessions();
      default:
        return { ok: false, error: { code: ERROR_CODES.INVALID_MESSAGE, message: 'unknown type' } };
    }
  }

  return {
    handle,
    sessions,
    pending,
    defaultStartCapture,
    defaultStopCapture,
    pauseStartCapture,
    setStartCaptureOverride: (fn) => {
      startCaptureOverride = fn;
    },
    setGetActiveSessionsOverride: (fn) => {
      getActiveSessionsOverride = fn;
    },
    setStopCaptureOverride: (fn) => {
      stopCaptureOverride = fn;
    },
    setSetTabGainOverride: (fn) => {
      setTabGainOverride = fn;
    },
    reset() {
      sessions.clear();
      pending.clear();
      startCapturePauses.clear();
      startCaptureOverride = null;
      getActiveSessionsOverride = null;
      stopCaptureOverride = null;
      setTabGainOverride = null;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake chrome environment.
// ---------------------------------------------------------------------------

const listeners = []; // { target-agnostic fn(message, sender, sendResponse) }
const webNavigationListeners = { onCommitted: [], onHistoryStateUpdated: [], onReferenceFragmentUpdated: [] };
const tabsListeners = { onRemoved: [], onReplaced: [] };
const tabCaptureListeners = { onStatusChanged: [] };

let tabsData = new Map(); // tabId -> {id, url}
let capturedTabsData = []; // [{tabId, status}]
let offscreenDocumentCreated = false;
let closeDocumentCallCount = 0;
let createDocumentCallCount = 0;
let getMediaStreamIdImpl = async ({ targetTabId }) => `stream-for-${targetTabId}`;
let tabsGetGates = new Map(); // tabId -> Promise, paused chrome.tabs.get calls

// --- page-audio backend fakes -------------------------------------------
// tabCaptureCalls counts EVERY chrome.tabCapture entry point, so a test can
// prove the fullscreen-compatible path never touches capture at all.
let tabCaptureCalls = 0;
let executeScriptCalls = []; // {tabId, frameIds, world, files}
let injectableFrames = new Map(); // tabId -> [{frameId, documentId}]
let inaccessibleFrames = new Set(); // `${tabId}:${frameId}` that executeScript rejects
// One fake page controller per injected frame, mirroring the real MAIN-world
// controller's contract closely enough to drive the service worker.
let pageControllers = new Map(); // `${tabId}:${frameId}` -> {installed, gainPercent, state, operationToken}
let pageMediaState = new Map(); // tabId -> state the controller reports on INSTALL

function frameKey(tabId, frameId) {
  return `${tabId}:${frameId}`;
}

function setInjectableFrames(tabId, frames) {
  injectableFrames.set(tabId, frames);
}

function setPageMediaState(tabId, state) {
  pageMediaState.set(tabId, state);
}

const offscreenResponder = createOffscreenResponder();

async function dispatch(message, senderOverride) {
  const sender = senderOverride ?? { id: FAKE_EXTENSION_ID };
  for (const fn of listeners) {
    let resolveResponse;
    const responsePromise = new Promise((resolve) => {
      resolveResponse = resolve;
    });
    let sendResponseCalled = false;
    const sendResponse = (resp) => {
      sendResponseCalled = true;
      resolveResponse(resp);
    };
    const returnValue = fn(message, sender, sendResponse);
    if (returnValue === true) {
      return await responsePromise;
    }
    if (sendResponseCalled) {
      return await responsePromise;
    }
  }
  return undefined;
}

let storageBackingStore = {};
let storageSetGate = null; // Promise|null - when set, every storage.local.set() call awaits it once

/**
 * Pauses every chrome.storage.local.set() call until the returned function
 * is called. Used to prove that a precondition becoming false while a
 * queued settings.js mutation's own writeSavedPages() call is still in
 * flight must be re-checked AFTER that write resolves too, and
 * compensated for - not only checked before the write began.
 */
function pauseStorageSet() {
  let release;
  storageSetGate = new Promise((resolve) => {
    release = resolve;
  });
  return () => {
    release();
    storageSetGate = null;
  };
}

function installStorageStub() {
  return {
    async get(key) {
      if (typeof key === 'string') {
        return Object.prototype.hasOwnProperty.call(storageBackingStore, key) ? { [key]: storageBackingStore[key] } : {};
      }
      return { ...storageBackingStore };
    },
    async set(obj) {
      if (storageSetGate) await storageSetGate;
      storageBackingStore = { ...storageBackingStore, ...obj };
    },
    async setAccessLevel() {
      return undefined;
    },
  };
}

globalThis.chrome = {
  runtime: {
    id: FAKE_EXTENSION_ID,
    onMessage: {
      addListener(fn) {
        listeners.push(fn);
      },
    },
    async sendMessage(message) {
      return dispatch(message);
    },
    getURL(path) {
      return `fake-extension://${FAKE_EXTENSION_ID}/${path}`;
    },
    async getContexts({ contextTypes }) {
      if (contextTypes.includes('OFFSCREEN_DOCUMENT') && offscreenDocumentCreated) {
        return [{ contextType: 'OFFSCREEN_DOCUMENT', documentUrl: `fake-extension://${FAKE_EXTENSION_ID}/${OFFSCREEN_DOCUMENT_PATH}` }];
      }
      return [];
    },
  },
  tabs: {
    /**
     * Drives the fake page-audio bridge/controller for one frame. Mirrors the
     * real contract: an uninstalled frame never answers, a stale operation
     * token is rejected, and RESET_TO_NEUTRAL returns gain to exactly 100.
     */
    async sendMessage(tabId, message, options) {
      const frameId = options?.frameId ?? 0;
      const controller = pageControllers.get(frameKey(tabId, frameId));
      if (!controller) throw new Error('Could not establish connection');
      const command = message?.command;
      if (!command) return { ok: false, reason: 'INVALID_COMMAND' };

      if (command.type === 'INSTALL') {
        controller.operationToken = command.operationToken;
        controller.gainPercent = command.gainPercent;
        controller.state = pageMediaState.get(tabId) ?? 'ACTIVE_WITH_MEDIA';
        return { ok: true, data: { state: controller.state, gainPercent: command.gainPercent, refusals: controller.state === 'UNSUPPORTED_MEDIA' ? ['CROSS_ORIGIN_NO_CORS'] : [] } };
      }
      if (controller.operationToken !== command.operationToken) {
        return { ok: false, rejected: true, reason: 'STALE_OPERATION' };
      }
      if (command.type === 'SET_GAIN') {
        controller.gainPercent = command.gainPercent;
        return { ok: true, data: { state: controller.state, gainPercent: command.gainPercent } };
      }
      if (command.type === 'RESET_TO_NEUTRAL') {
        controller.gainPercent = 100;
        return { ok: true, data: { state: controller.state, gainPercent: 100 } };
      }
      if (command.type === 'DISPOSE_OBSERVERS') {
        controller.observersDisposed = true;
        return { ok: true, data: { state: controller.state, gainPercent: controller.gainPercent } };
      }
      return { ok: true, data: { state: controller.state, gainPercent: controller.gainPercent } };
    },
    async get(tabId) {
      if (tabsGetGates.has(tabId)) {
        await tabsGetGates.get(tabId);
      }
      const tab = tabsData.get(tabId);
      if (!tab) throw new Error('No such tab');
      return tab;
    },
    onRemoved: {
      addListener(fn) {
        tabsListeners.onRemoved.push(fn);
      },
    },
    onReplaced: {
      addListener(fn) {
        tabsListeners.onReplaced.push(fn);
      },
    },
  },
  tabCapture: {
    async getMediaStreamId(opts) {
      tabCaptureCalls += 1;
      return getMediaStreamIdImpl(opts);
    },
    async getCapturedTabs() {
      tabCaptureCalls += 1;
      return capturedTabsData;
    },
    onStatusChanged: {
      addListener(fn) {
        tabCaptureListeners.onStatusChanged.push(fn);
      },
    },
  },
  webNavigation: {
    onCommitted: {
      addListener(fn) {
        webNavigationListeners.onCommitted.push(fn);
      },
    },
    onHistoryStateUpdated: {
      addListener(fn) {
        webNavigationListeners.onHistoryStateUpdated.push(fn);
      },
    },
    onReferenceFragmentUpdated: {
      addListener(fn) {
        webNavigationListeners.onReferenceFragmentUpdated.push(fn);
      },
    },
    async getFrame({ tabId }) {
      const tab = tabsData.get(tabId);
      if (!tab) return undefined;
      return { url: tab.url };
    },
    async getAllFrames({ tabId }) {
      if (injectableFrames.has(tabId)) {
        return injectableFrames.get(tabId).map((f) => ({ ...f, url: tabsData.get(tabId)?.url ?? 'https://frame.example/' }));
      }
      const tab = tabsData.get(tabId);
      return tab ? [{ frameId: 0, documentId: `doc-${tabId}`, url: tab.url }] : [];
    },
  },
  scripting: {
    async executeScript({ target, world, files }) {
      const frameIds = target.frameIds ?? [0];
      for (const frameId of frameIds) {
        if (inaccessibleFrames.has(frameKey(target.tabId, frameId))) {
          throw new Error('Cannot access contents of the page');
        }
      }
      executeScriptCalls.push({ tabId: target.tabId, frameIds, world: world ?? 'ISOLATED', files });
      // The MAIN-world file installs the page controller; installation is
      // idempotent exactly like the real one.
      if (world === 'MAIN') {
        for (const frameId of frameIds) {
          const key = frameKey(target.tabId, frameId);
          if (!pageControllers.has(key)) {
            pageControllers.set(key, { installed: 0, gainPercent: 100, state: null, operationToken: null });
          }
          pageControllers.get(key).installed += 1;
        }
      }
      return frameIds.map((frameId) => ({ frameId, result: null }));
    },
  },
  offscreen: {
    async createDocument() {
      createDocumentCallCount += 1;
      offscreenDocumentCreated = true;
    },
    async closeDocument() {
      closeDocumentCallCount += 1;
      offscreenDocumentCreated = false;
      offscreenResponder.sessions.clear();
    },
  },
  storage: {
    local: installStorageStub(),
  },
};

// Canonical implementations of the two chrome methods that individual tests
// sometimes temporarily override on the global (getCapturedTabs, closeDocument).
// resetEverything() restores these, so a test whose own restore was skipped
// (e.g. an assertion threw before it ran) can never leak a broken global into
// the next test - the whole file stays order-independent.
const CANONICAL_GET_CAPTURED_TABS = globalThis.chrome.tabCapture.getCapturedTabs;
const CANONICAL_CLOSE_DOCUMENT = globalThis.chrome.offscreen.closeDocument;

// Register the fake offscreen document's own message listener through the
// REAL shared/messages.js registerMessageHandler - exactly the call real
// offscreen/offscreen.js makes at its own bottom - rather than a hand-rolled
// stand-in. This is what makes every SW -> offscreen message in every test
// below actually pass through the real validateMessage()/target-aware
// payload-shape checks (review round 4, fix #1/#6): a mismatched payload
// shape (e.g. the popup's expectedOperationId-carrying SET_TAB_GAIN shape
// sent to the offscreen target) is now genuinely rejected here, not merely
// in a separate, disconnected unit test.
registerMessageHandler(TARGETS.OFFSCREEN, (message) => offscreenResponder.handle(message), {
  validateSender: validateServiceWorkerOriginatedSender,
});

// Captures every service-worker -> POPUP / OPTIONS broadcast (TAB_STATE_CHANGED,
// SAVED_PAGES_CHANGED, SAVED_PAGE_CHANGED) so the two-way-sync tests can assert
// exactly what the service worker broadcast and to which exact target/pageKey.
// A real popup/options context would validate the sender via
// registerMessageHandler; here we only need to record the outgoing broadcast.
const capturedBroadcasts = []; // { target, type, payload }
listeners.push((message, sender, sendResponse) => {
  if (message && (message.target === TARGETS.POPUP || message.target === TARGETS.OPTIONS)) {
    capturedBroadcasts.push({ target: message.target, type: message.type, payload: message.payload });
    sendResponse({ ok: true, data: {} });
    return true;
  }
  return undefined;
});

const settings = await import('../shared/settings.js');
const sw = await import('../service-worker.js');

/**
 * Schema 6 stores each saved page as a record ({volumePercent, titleSnapshot,
 * customName}). Most assertions in this file only care about the VOLUME, so
 * this projects the authoritative record map down to the {pageKey: percent}
 * shape those assertions were written against. Tests that specifically care
 * about metadata call settings.getSavedPages() directly and assert on the
 * record fields.
 */
async function savedVolumes() {
  const pages = await settings.getSavedPages();
  return Object.fromEntries(Object.entries(pages).map(([key, record]) => [key, record.volumePercent]));
}


// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

let nextTabId = 1000;
function freshTabId() {
  nextTabId += 1;
  return nextTabId;
}

function setTab(tabId, url, title = '') {
  tabsData.set(tabId, { id: tabId, url, title });
}

function removeTabData(tabId) {
  tabsData.delete(tabId);
}

// Represents a realistic popup/options page sender - a real document
// context, where Chrome's MessageSender.url is reliably present. Used as
// send()'s default so every existing test that doesn't care about sender
// validation still exercises the real (now strict, no-bypass-on-absence)
// service-worker sender matrix on its happy path. Genuine SW-originated
// messages (service-worker.js's own sendMessage calls to the fake
// offscreen responder) go through dispatch() directly with no override,
// which keeps its own default of `{id: FAKE_EXTENSION_ID}` (no url) -
// exactly mirroring Chrome's documented service-worker-sender exception.
const DEFAULT_TEST_SENDER = { id: FAKE_EXTENSION_ID, url: `fake-extension://${FAKE_EXTENSION_ID}/popup/popup.html` };
// The service worker's sender matrix is message-type-specific -
// GET_SAVED_PAGES/REMOVE_SAVED_PAGE/CLEAR_SAVED_PAGES/UPDATE_SAVED_PAGE_VOLUME
// are options-only; GET_TAB_STATE/ADD_CURRENT_PAGE/ADD_PAGE_MANUAL/
// START_CAPTURE/STOP_CAPTURE/SET_TAB_GAIN/PERSIST_PAGE_VOLUME are popup-only
// (ADD_PAGE_MANUAL lives in the popup's own "Add URL manually" modal in the
// real product model, not the saved-pages view) - each is rejected if sent
// with the wrong sender.
const OPTIONS_TEST_SENDER = { id: FAKE_EXTENSION_ID, url: `fake-extension://${FAKE_EXTENSION_ID}/options/options.html` };

async function send(type, payload, senderOverride) {
  return dispatch(
    { target: TARGETS.SERVICE_WORKER, type, requestId: `req-${Math.random()}`, payload },
    senderOverride ?? DEFAULT_TEST_SENDER
  );
}

/**
 * Builds the r5 popup->service-worker START_CAPTURE payload: the tab's
 * current server-derived expectedPageKey (canonicalized from the fake tab's
 * URL, exactly as the popup's last observed GET_TAB_STATE would carry) plus
 * an initialGainPercent (the value the popup's slider currently shows). A
 * missing tab URL yields expectedPageKey `undefined`, which the START_CAPTURE
 * validator rejects - callers that need a deliberate mismatch pass an
 * explicit payload instead.
 */
function startPayload(tabId, initialGainPercent = DEFAULT_VOLUME_PERCENT) {
  const tab = tabsData.get(tabId);
  const canonical = tab && tab.url ? canonicalizePageKey(tab.url) : { ok: false };
  return { tabId, expectedPageKey: canonical.ok ? canonical.pageKey : tab?.url, initialGainPercent };
}

function pauseTabsGet(tabId) {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  tabsGetGates.set(tabId, gate);
  return () => {
    release();
    tabsGetGates.delete(tabId);
  };
}

/**
 * A START_CAPTURE override that mirrors defaultStartCapture's own real
 * PendingStart bookkeeping (registered synchronously before any await,
 * cancellable, deleted in a finally block) exactly, but pauses on an
 * externally-controlled gate instead of the internal operationId-keyed
 * one - lets a test control precisely when the simulated getUserMedia()
 * call resolves, while a real, cancellable PendingStart entry is genuinely
 * registered in offscreenResponder.pending the entire time it is paused.
 * Used by review-round-3 fix #2/#3's regression tests, which specifically
 * need STOP_CAPTURE to find and cancel a PendingStart, not merely see
 * nothing at all.
 */
function createControllablePendingStart() {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const override = async (payload) => {
    const { tabId, operationId, pageKey, gainPercent } = payload;
    if (offscreenResponder.sessions.has(tabId) || offscreenResponder.pending.has(tabId)) {
      return { ok: false, error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'A session already exists for this tab.' } };
    }
    const pendingEntry = registerPendingStart(offscreenResponder.pending, tabId, operationId);
    try {
      await gate;
      if (!isStillPending(offscreenResponder.pending, tabId, pendingEntry)) {
        return { ok: false, error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'This operation was cancelled before capture completed.' } };
      }
      offscreenResponder.sessions.set(tabId, { operationId, pageKey, gainPercent });
      return { ok: true, data: { tabId, operationId } };
    } finally {
      finalizePendingStart(offscreenResponder.pending, tabId, pendingEntry);
    }
  };
  return { override, release: () => release() };
}

async function fireCommitted(tabId, url, frameId = 0) {
  for (const fn of webNavigationListeners.onCommitted) {
    await fn({ tabId, url, frameId });
  }
}

async function fireHistoryStateUpdated(tabId, url, frameId = 0) {
  for (const fn of webNavigationListeners.onHistoryStateUpdated) {
    await fn({ tabId, url, frameId });
  }
}

async function fireTabRemoved(tabId) {
  for (const fn of tabsListeners.onRemoved) {
    await fn(tabId);
  }
}

async function fireCaptureStatusChanged(tabId, status) {
  for (const fn of tabCaptureListeners.onStatusChanged) {
    await fn({ tabId, status });
  }
}

/** Waits for pending microtasks/timers to settle a bit - used sparingly, where no better signal exists. */
function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Every offscreen round trip in the service worker is bounded by this value.
// Tests drive the real timeout code paths off a short, CONTROLLED timeout
// rather than the production 1500ms, so a timeout-path assertion needs a few
// hundred milliseconds instead of several seconds - and its margin is a large
// multiple of the timeout, which is what makes it deterministic rather than
// dependent on how loaded the machine happens to be.
const TEST_OFFSCREEN_TIMEOUT_MS = 60;

function resetEverything() {
  storageBackingStore = {};
  storageSetGate = null;
  settings.__resetForTests();
  sw.__resetForTests();
  sw.__setOffscreenResponseTimeoutForTests(TEST_OFFSCREEN_TIMEOUT_MS);
  offscreenResponder.reset();
  tabsData = new Map();
  capturedTabsData = [];
  offscreenDocumentCreated = false;
  closeDocumentCallCount = 0;
  createDocumentCallCount = 0;
  getMediaStreamIdImpl = async ({ targetTabId }) => `stream-for-${targetTabId}`;
  tabsGetGates = new Map();
  globalThis.chrome.tabCapture.getCapturedTabs = CANONICAL_GET_CAPTURED_TABS;
  globalThis.chrome.offscreen.closeDocument = CANONICAL_CLOSE_DOCUMENT;
  capturedBroadcasts.length = 0;
  tabCaptureCalls = 0;
  executeScriptCalls = [];
  injectableFrames = new Map();
  inaccessibleFrames = new Set();
  pageControllers = new Map();
  pageMediaState = new Map();
}

/**
 * Enables the fullscreen-compatible page-audio backend end to end and asserts
 * it became active. Returns the response so callers can use its operationId.
 */
async function enablePageAudio(tabId, initialGainPercent = DEFAULT_VOLUME_PERCENT) {
  const response = await send(MESSAGE_TYPES.START_PAGE_AUDIO, startPayload(tabId, initialGainPercent));
  assert.equal(response.ok, true, `expected page-audio to start: ${JSON.stringify(response)}`);
  return response;
}

function pageGainFor(tabId, frameId = 0) {
  return pageControllers.get(frameKey(tabId, frameId))?.gainPercent ?? null;
}

function broadcastsTo(target, type) {
  return capturedBroadcasts.filter((b) => b.target === target && b.type === type);
}

async function addAndAssertSaved(pageKey, volumePercent = DEFAULT_VOLUME_PERCENT) {
  await settings.addSavedPage(pageKey, volumePercent);
}

/**
 * Enables a tab end to end and returns once it is confirmed 'active'. Fails
 * the test loudly if not. Returns the operationId the session was started
 * with, alongside the raw response, so callers can build expectedOperationId
 * payloads for SET_TAB_GAIN/PERSIST_PAGE_VOLUME.
 */
async function enableTab(tabId, initialGainPercent = DEFAULT_VOLUME_PERCENT) {
  const response = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, initialGainPercent));
  assert.equal(response.ok, true, `expected START_CAPTURE to succeed: ${JSON.stringify(response)}`);
  assert.equal(response.data.state, 'active');
  assert.ok(response.data.operationId, 'expected START_CAPTURE to echo back an operationId');
  return response;
}

/**
 * A REAL popup-controller (shared/popup-controller.js) wired end-to-end to the
 * service worker exactly as popup.js wires it: startCapture/setLiveGain/
 * persistVolume go through the real send() path (registerMessageHandler ->
 * validateMessage -> the SW handler), and refresh() re-fetches GET_TAB_STATE
 * and feeds `response.data` STRAIGHT into setServerState - identical to
 * popup.js's `applyState(response.data)`. This is precisely the integration
 * path that the previous per-module tests never exercised together, and it is
 * what surfaces whether GET_TAB_STATE carries a usable tabId (the fix). No
 * `tabId` is ever injected by hand here - the controller must derive it from
 * the server state, just like the real popup.
 */
function makePopupClient(tabId) {
  let lastDisplay = null;
  const sliderDisplays = [];
  let controller;
  const refresh = async () => {
    const resp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
    controller.setServerState(resp.data);
  };
  controller = createPopupController({
    startCapture: (payload) => send(MESSAGE_TYPES.START_CAPTURE, payload),
    setLiveGain: ({ tabId: t, gainPercent, operationId }) =>
      send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId: t, gainPercent, expectedOperationId: operationId }),
    persistVolume: ({ tabId: t, gainPercent, operationId }) =>
      send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId: t, gainPercent, expectedOperationId: operationId }),
    refresh,
    setSliderDisplay: (v) => {
      lastDisplay = v;
      sliderDisplays.push(v);
    },
    liveThrottleMs: 5,
  });
  return {
    controller,
    prime: refresh, // popup.js's init() calls refresh() before any user action
    getDisplay: () => lastDisplay,
    sliderDisplays,
    state: () => controller.__getState(),
  };
}

/** Waits out the popup-controller's live-gain trailing throttle (5ms) plus margin. */
function settlePopup() {
  return tick(30);
}

// ===========================================================================
// Sanity: the harness itself works end to end.
// ===========================================================================

test('harness sanity: add, enable, disable a page end to end', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://sanity.example/page');
  await addAndAssertSaved('https://sanity.example/page');

  const state1 = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state1.ok, true);
  assert.equal(state1.data.saved, true);
  assert.equal(state1.data.state, 'inactive');

  await enableTab(tabId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);

  const stopResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopResponse.ok, true);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

// ===========================================================================
// v0.1.2 fix: temporary boosting on unsaved pages via the REAL popup
// controller wired end-to-end to the service worker.
//
// Root cause of the regression: GET_TAB_STATE's response body omitted
// `tabId`, so the popup controller (whose only server-authoritative source of
// tabId IS this state) kept its internal tabId `null` and issued
// START_CAPTURE with `tabId: null`, which the target-aware validator rejected
// with INVALID_MESSAGE. These tests drive the real popup controller through
// the real GET_TAB_STATE / validation / SW path, so the bug cannot return.
// ===========================================================================

test('unsaved boost #1: Enable at 100% on an unsaved inactive page becomes active at gain 1.0', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://unsaved-enable-100.example/';
  setTab(tabId, pageKey);

  const popup = makePopupClient(tabId);
  await popup.prime(); // popup opens: GET_TAB_STATE -> setServerState
  assert.equal(popup.state().tabId, tabId, 'the controller derived a real tabId from GET_TAB_STATE');
  assert.equal(popup.getDisplay(), 100);

  const response = await popup.controller.onEnableClick();
  await settlePopup();

  assert.equal(response.ok, true, `Enable must succeed on an unsaved page: ${JSON.stringify(response)}`);
  assert.equal(offscreenResponder.sessions.has(tabId), true, 'a session started');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 100, 'GainNode gain 1.0 (100%)');
  assert.equal(popup.state().captureState, 'active', 'popup changed to active only after confirmed success');
  assert.deepEqual(await savedVolumes(), {}, 'no savedPages entry created');
});

test('unsaved boost #2: first slider input 155% on an unsaved inactive page becomes active at gain 1.55', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://unsaved-slider-155.example/';
  setTab(tabId, pageKey);

  const popup = makePopupClient(tabId);
  await popup.prime();

  popup.controller.onSliderInput(155);
  await settlePopup();

  assert.equal(offscreenResponder.sessions.has(tabId), true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 155, 'offscreen GainNode at 155% (1.55)');
  assert.equal(popup.getDisplay(), 155, 'final slider position equals the live gain');
  assert.deepEqual(await savedVolumes(), {}, 'no savedPages entry created');
});

test('unsaved boost #3: first slider input BELOW 100% (50%) also starts capture, at gain 0.5', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://unsaved-slider-50.example/';
  setTab(tabId, pageKey);

  const popup = makePopupClient(tabId);
  await popup.prime();

  popup.controller.onSliderInput(50); // below 100 must NOT be treated as a no-op
  await settlePopup();

  assert.equal(offscreenResponder.sessions.has(tabId), true, 'moving below 100% still starts capture');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 50, 'offscreen GainNode at 50% (0.5)');
  assert.equal(popup.getDisplay(), 50);
});

test('unsaved boost #4: inputs 120,170,230 during ONE in-flight start -> a single START_CAPTURE, finishing at 230% (2.3)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://unsaved-multi-input.example/';
  setTab(tabId, pageKey);

  // Count how many START_CAPTURE messages actually reach the offscreen layer.
  let startCount = 0;
  const originalStart = offscreenResponder.defaultStartCapture;
  offscreenResponder.setStartCaptureOverride((payload) => {
    startCount += 1;
    return originalStart(payload);
  });

  const popup = makePopupClient(tabId);
  await popup.prime();

  // Three inputs fired back-to-back before the start settles.
  popup.controller.onSliderInput(120);
  popup.controller.onSliderInput(170);
  popup.controller.onSliderInput(230);
  await settlePopup();

  assert.equal(startCount, 1, 'exactly one START_CAPTURE was issued for the burst of inputs');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 230, 'the LATEST value (230%) is applied to the resulting operation');
  assert.equal(popup.getDisplay(), 230);

  offscreenResponder.setStartCaptureOverride(null);
});

test('unsaved boost #5: slider movement in EITHER direction triggers the same startup path', async () => {
  // Up: 100 -> 220
  resetEverything();
  const up = freshTabId();
  setTab(up, 'https://unsaved-dir-up.example/');
  const popupUp = makePopupClient(up);
  await popupUp.prime();
  popupUp.controller.onSliderInput(220);
  await settlePopup();
  assert.equal(offscreenResponder.sessions.get(up).gainPercent, 220);

  // Down: 100 -> 40
  resetEverything();
  const down = freshTabId();
  setTab(down, 'https://unsaved-dir-down.example/');
  const popupDown = makePopupClient(down);
  await popupDown.prime();
  popupDown.controller.onSliderInput(40);
  await settlePopup();
  assert.equal(offscreenResponder.sessions.get(down).gainPercent, 40);
});

test('unsaved boost #6/#7: neither slider-start nor Enable creates a savedPages key', async () => {
  resetEverything();
  const sliderTab = freshTabId();
  setTab(sliderTab, 'https://unsaved-no-save-slider.example/');
  const p1 = makePopupClient(sliderTab);
  await p1.prime();
  p1.controller.onSliderInput(180);
  await settlePopup();
  assert.deepEqual(await savedVolumes(), {}, 'slider start creates no savedPages key');

  resetEverything();
  const enableTabId = freshTabId();
  setTab(enableTabId, 'https://unsaved-no-save-enable.example/');
  const p2 = makePopupClient(enableTabId);
  await p2.prime();
  await p2.controller.onEnableClick();
  await settlePopup();
  assert.deepEqual(await savedVolumes(), {}, 'Enable creates no savedPages key');
});

test('unsaved boost #8: change / pagehide on an unsaved active session writes nothing to storage', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://unsaved-no-persist.example/');
  const popup = makePopupClient(tabId);
  await popup.prime();

  popup.controller.onSliderInput(150); // starts the session
  await settlePopup();
  assert.equal(popup.state().captureState, 'active');

  popup.controller.onSliderChange(175); // committing a value (release)
  await settlePopup();
  popup.controller.flushFallback(); // pagehide
  await settlePopup();

  assert.deepEqual(await savedVolumes(), {}, 'no persistent write for an unsaved page');
  // But the live gain did follow the committed value.
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 175);
});

test('unsaved boost #9: reopening the popup during the live unsaved session shows the actual gain', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://unsaved-reopen.example/');
  const first = makePopupClient(tabId);
  await first.prime();
  first.controller.onSliderInput(210);
  await settlePopup();
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 210);

  // A freshly opened popup (new controller) primes from GET_TAB_STATE.
  const reopened = makePopupClient(tabId);
  await reopened.prime();
  assert.equal(reopened.state().captureState, 'active');
  assert.equal(reopened.getDisplay(), 210, 'the reopened popup shows the real live gain, not 100');
});

test('unsaved boost #11: Enable uses the currently displayed value as initialGainPercent (saved default shown while inactive)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://unsaved-enable-displayed.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 175); // saved default 175 is what the popup displays while inactive

  const popup = makePopupClient(tabId);
  await popup.prime();
  assert.equal(popup.getDisplay(), 175, 'inactive popup displays the saved default');

  await popup.controller.onEnableClick();
  await settlePopup();
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 175, 'Enable started at the displayed 175, not a hardcoded 100');
});

test('unsaved boost #12: START_CAPTURE built by the real controller passes real target-aware validation (never tabId:null)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://unsaved-valid-payload.example/';
  setTab(tabId, pageKey);

  // Intercept the exact START_CAPTURE payload the controller builds and prove
  // it validates against the REAL target-aware validator.
  let captured = null;
  const originalStart = offscreenResponder.defaultStartCapture;
  offscreenResponder.setStartCaptureOverride((payload) => originalStart(payload));

  // Wrap send at the popup layer to snapshot the SW-directed payload.
  const popup = makePopupClient(tabId);
  await popup.prime();
  const realState = popup.state();
  assert.equal(realState.tabId, tabId);
  const startResp = await popup.controller.onEnableClick();
  await settlePopup();
  captured = { tabId: realState.tabId, expectedPageKey: realState.pageKey, initialGainPercent: 100 };

  // The response came back ok (validation + SW succeeded), and the exact
  // payload shape the controller uses validates.
  assert.equal(startResp.ok, true);
  const { validateMessage } = await import('../shared/validation.js');
  const validation = validateMessage({
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.START_CAPTURE,
    requestId: 'r',
    payload: captured,
  });
  assert.equal(validation.ok, true, 'the controller-built START_CAPTURE payload passes target-aware validation');

  offscreenResponder.setStartCaptureOverride(null);
});

test('unsaved boost #13: the offscreen layer receives the expected initial gain AND an operationId', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://unsaved-offscreen-args.example/');

  let seen = null;
  offscreenResponder.setStartCaptureOverride((payload) => {
    seen = { gainPercent: payload.gainPercent, operationId: payload.operationId, pageKey: payload.pageKey };
    return offscreenResponder.defaultStartCapture(payload);
  });

  const popup = makePopupClient(tabId);
  await popup.prime();
  popup.controller.onSliderInput(140);
  await settlePopup();

  assert.ok(seen, 'the offscreen START_CAPTURE was reached');
  assert.equal(seen.gainPercent, 140, 'offscreen received the expected initial gain');
  assert.ok(seen.operationId && seen.operationId.length > 0, 'offscreen received a non-empty operationId');
  assert.equal(seen.pageKey, 'https://unsaved-offscreen-args.example/');

  offscreenResponder.setStartCaptureOverride(null);
});

test('unsaved boost #14: the popup goes active ONLY after confirmed capture success (not on a failed start)', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://unsaved-fail-inactive.example/');

  // Make the offscreen START_CAPTURE fail with a structured error.
  offscreenResponder.setStartCaptureOverride(() => ({ ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated' } }));

  const popup = makePopupClient(tabId);
  await popup.prime();
  const response = await popup.controller.onEnableClick();
  await settlePopup();

  assert.equal(response.ok, false, 'a failed start returns the structured error, not a fake success');
  assert.equal(response.error.code, ERROR_CODES.CAPTURE_FAILED);
  assert.notEqual(popup.state().captureState, 'active', 'popup restored to a non-active state');
  assert.equal(offscreenResponder.sessions.has(tabId), false, 'no Session was left behind');

  offscreenResponder.setStartCaptureOverride(null);
});

test('unsaved boost #16: PAGE_CHANGED during startup creates no Session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://unsaved-pagechanged-a.example/';
  const pageB = 'https://unsaved-pagechanged-b.example/';
  setTab(tabId, pageA);

  const popup = makePopupClient(tabId);
  await popup.prime(); // controller observes page A

  // The tab navigates to B before the start's chrome.tabs.get resolves. The
  // controller still holds expectedPageKey = A, so the SW returns PAGE_CHANGED.
  setTab(tabId, pageB);
  const response = await popup.controller.onEnableClick();
  await settlePopup();

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_CHANGED);
  assert.equal(offscreenResponder.sessions.has(tabId), false, 'no Session created on a page the user did not act on');
});

test('unsaved boost #17: repeated Enable clicks during startup create exactly one operation', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://unsaved-repeat-enable.example/');

  let startCount = 0;
  const originalStart = offscreenResponder.defaultStartCapture;
  offscreenResponder.setStartCaptureOverride((payload) => {
    startCount += 1;
    return originalStart(payload);
  });

  const popup = makePopupClient(tabId);
  await popup.prime();

  // Three rapid Enable clicks before the first settles.
  const p1 = popup.controller.onEnableClick();
  const p2 = popup.controller.onEnableClick();
  const p3 = popup.controller.onEnableClick();
  await Promise.all([p1, p2, p3]);
  await settlePopup();

  assert.equal(startCount, 1, 'exactly one START_CAPTURE despite three Enable clicks');
  assert.equal(offscreenResponder.sessions.has(tabId), true);

  offscreenResponder.setStartCaptureOverride(null);
});

test('unsaved boost #18: after Enable at 100%, moving to 155% updates the real offscreen session live', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://unsaved-then-move.example/');

  const popup = makePopupClient(tabId);
  await popup.prime();
  await popup.controller.onEnableClick();
  await settlePopup();
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 100);

  // Now active - a slider input drives live gain through the throttle.
  popup.controller.onSliderInput(155);
  await settlePopup();
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 155, 'the live offscreen session followed the slider');
  assert.deepEqual(await savedVolumes(), {}, 'still nothing persisted for the unsaved page');
});

// ===========================================================================
// Product-model correction: any supported current http/https page can be
// temporarily boosted after an explicit user action, saved or not. Saving
// is a stored preference, never a capture permission - none of these
// tests ever call addAndAssertSaved for the tab under test.
// ===========================================================================

test('required#1: an unsaved page can start a temporary session from Enable (plain START_CAPTURE)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://temp-enable.example/';
  setTab(tabId, pageKey);

  const stateBefore = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(stateBefore.data.saved, false);

  const { data } = await enableTab(tabId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, DEFAULT_VOLUME_PERCENT);

  const stateAfter = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(stateAfter.data.state, 'active');
  assert.equal(stateAfter.data.saved, false);
  assert.equal(stateAfter.data.operationId, data.operationId);
});

test('required#2: an unsaved page can start temporary capture from its first slider interaction (START_CAPTURE, then SET_TAB_GAIN once active)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://temp-first-slider.example/';
  setTab(tabId, pageKey);

  // Mirrors exactly what popup.js's slider `input` handler sends on an
  // inactive page: an ensureCaptureStarted() (START_CAPTURE), and once
  // that resolves, a live SET_TAB_GAIN reflecting the dragged value.
  const startResponse = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  assert.equal(startResponse.ok, true);
  assert.equal(startResponse.data.state, 'active');

  const gainResponse = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 137,
    expectedOperationId: startResponse.data.operationId,
  });
  assert.equal(gainResponse.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 137);
  assert.deepEqual(await savedVolumes(), {}, 'never saved merely by starting a temporary session from the slider');
});

test('required#3: unsaved slider input (SET_TAB_GAIN) never writes storage, and an unsaved PERSIST_PAGE_VOLUME never creates an entry', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://temp-slider-no-write.example/';
  setTab(tabId, pageKey);
  const { data } = await enableTab(tabId);

  for (const value of [120, 80, 160, 100]) {
    const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: value, expectedOperationId: data.operationId });
    assert.equal(response.ok, true);
    assert.deepEqual(await savedVolumes(), {}, `storage must stay empty after live gain ${value}`);
  }

  // Defense in depth: even if the popup mistakenly sent PERSIST_PAGE_VOLUME
  // for an unsaved page (it must not, per the product model), the service
  // worker still refuses to create an entry.
  const persistResponse = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId, gainPercent: 150, expectedOperationId: data.operationId });
  assert.equal(persistResponse.ok, false);
  assert.equal(persistResponse.error.code, ERROR_CODES.PAGE_NOT_SAVED);
  assert.deepEqual(await savedVolumes(), {});
});

test('required#4: an unsaved session survives "popup closure" (no message sent) and reopening shows the actual live gain', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://temp-survives-popup-close.example/';
  setTab(tabId, pageKey);
  const { data } = await enableTab(tabId);

  await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 175, expectedOperationId: data.operationId });

  // "Closing the popup" sends no message at all - simulated here simply by
  // not sending STOP_CAPTURE and later querying state again, as a freshly
  // reopened popup's own GET_TAB_STATE call would.
  const reopened = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(reopened.data.state, 'active');
  assert.equal(reopened.data.gainPercent, 175, 'the actual current live gain, not a stale/default value');
  assert.equal(reopened.data.operationId, data.operationId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);
});

test('required#5: an unsaved session stops on exact-page (full-document) navigation', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://temp-nav-stops.example/';
  const destinationPageKey = 'https://temp-nav-stops-destination.example/';
  setTab(tabId, pageKey);
  await enableTab(tabId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);

  setTab(tabId, destinationPageKey);
  await fireCommitted(tabId, destinationPageKey);
  await tick(20);

  assert.equal(offscreenResponder.sessions.has(tabId), false);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
});

test('required#6/#7: an unsaved (temporary) session is reconstructed safely after a service-worker restart - saved-pages membership is not required for reconciliation', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://temp-reconciled.example/';
  setTab(tabId, pageKey);
  await enableTab(tabId);
  assert.deepEqual(await savedVolumes(), {}, 'genuinely never saved');

  // Simulates a real service-worker restart: the in-memory cache is wiped,
  // but the offscreen document's own real state (and Chrome's tabCapture
  // status) survives untouched.
  sw.__resetForTests();
  offscreenDocumentCreated = true;
  capturedTabsData = [{ tabId, status: 'active' }];

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.ok, true);
  assert.equal(state.data.state, 'active', 'reconstructed as active purely from offscreen enumeration + tabCapture + URL match - never gated on savedPages');
  assert.equal(state.data.saved, false, 'still correctly reported as unsaved');
  assert.equal(offscreenResponder.sessions.has(tabId), true, 'never torn down merely for being unsaved');
});

// ===========================================================================
// Fix #1 (service-worker side): PERSIST_PAGE_VOLUME must never add an
// unallowed page, and must reject when there is no active session.
// ===========================================================================

test('fix1: PERSIST_PAGE_VOLUME is rejected when the tab has no active session at all', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://never-enabled.example/');
  const response = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId, gainPercent: 150, expectedOperationId: 'irrelevant' });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.NOT_ACTIVE);
  assert.deepEqual(await savedVolumes(), {});
});

test('fix1: a delayed PERSIST_PAGE_VOLUME after Disable is a harmless no-op, never re-adding the page', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://disabled-then-persist.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });

  const persistResponse = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId,
    gainPercent: 170,
    expectedOperationId: data.operationId,
  });
  assert.equal(persistResponse.ok, false);
  assert.equal(persistResponse.error.code, ERROR_CODES.NOT_ACTIVE);

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 100); // untouched default, never bumped to 170
});

test('fix1: a delayed PERSIST_PAGE_VOLUME after the page was removed does not re-add it', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://removed-then-persist.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  // Remove the page (from the saved-pages view) while the session (from
  // the SW's point of view) is still cached as active - simulates the
  // message ordering where a Delete and a delayed persist race.
  await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);

  const persistResponse = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId,
    gainPercent: 170,
    expectedOperationId: data.operationId,
  });
  assert.equal(persistResponse.ok, false);
  assert.deepEqual(await savedVolumes(), {});
});

test('fix1: a delayed PERSIST_PAGE_VOLUME after navigation to a different page does not persist against the new page', async () => {
  resetEverything();
  const tabId = freshTabId();
  const oldPageKey = 'https://nav-old.example/';
  const newPageKey = 'https://nav-new.example/';
  setTab(tabId, oldPageKey);
  await addAndAssertSaved(oldPageKey);
  await addAndAssertSaved(newPageKey);
  const { data } = await enableTab(tabId);

  setTab(tabId, newPageKey);
  await fireCommitted(tabId, newPageKey);
  await tick(20); // let the (now confirmed-teardown-based) navigation handler actually finish

  const persistResponse = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId,
    gainPercent: 170,
    expectedOperationId: data.operationId,
  });
  assert.equal(persistResponse.ok, false);
  assert.equal(persistResponse.error.code, ERROR_CODES.NOT_ACTIVE);

  const pages = await savedVolumes();
  assert.equal(pages[oldPageKey], 100);
  assert.equal(pages[newPageKey], 100);
});

test('fix1: a valid persist on a genuinely active session still updates every session sharing the exact pageKey', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageKey = 'https://shared.example/';
  setTab(tabA, pageKey);
  setTab(tabB, pageKey);
  await addAndAssertSaved(pageKey);
  const { data: dataA } = await enableTab(tabA);
  await enableTab(tabB);

  const persistResponse = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId: tabA,
    gainPercent: 165,
    expectedOperationId: dataA.operationId,
  });
  assert.equal(persistResponse.ok, true);

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 165);
  assert.equal(offscreenResponder.sessions.get(tabA).gainPercent, 165);
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 165);
});

// ===========================================================================
// Fix #2: the Start operation must be registered ('resolving') before the
// tab URL is resolved, so a navigation/Stop/close during that await can
// still cancel it.
// ===========================================================================

test('fix2: a tab close during chrome.tabs.get prevents capture from starting once it resolves', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://resolving-close.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const releaseTabsGet = pauseTabsGet(tabId);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));

  await tick(20); // let handleStartCapture register the 'resolving' entry and reach the paused chrome.tabs.get
  await fireTabRemoved(tabId); // must find and cancel the 'resolving' entry
  removeTabData(tabId);
  releaseTabsGet();

  const response = await startPromise;
  assert.equal(response.ok, false);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

test('fix2: a navigation during chrome.tabs.get prevents capture from starting once it resolves', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://resolving-nav.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const releaseTabsGet = pauseTabsGet(tabId);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));

  await tick(20);
  await fireCommitted(tabId, pageKey); // navigation while still 'resolving' must cancel it
  releaseTabsGet();

  const response = await startPromise;
  assert.equal(response.ok, false);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  // Confirm the tab genuinely ends up inactive, not stuck.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
});

test('fix2: an explicit Stop during chrome.tabs.get prevents capture from starting once it resolves', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://resolving-stop.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const releaseTabsGet = pauseTabsGet(tabId);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));

  await tick(20);
  const stopResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopResponse.ok, true);
  releaseTabsGet();

  const response = await startPromise;
  assert.equal(response.ok, false);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

test('fix2: GET_TAB_STATE reports "resolving" as a distinct, non-active in-progress state', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://resolving-state.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const releaseTabsGet = pauseTabsGet(tabId);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);

  const stateResponse = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(stateResponse.data.state, 'resolving');
  assert.notEqual(stateResponse.data.state, 'active');

  releaseTabsGet();
  await startPromise;
});

// ===========================================================================
// Fix #3: a stale/failed capture-start teardown must never use force:true -
// it must never destroy a newer session for the same tabId.
// ===========================================================================

test('fix3: a delayed old-operation START_CAPTURE response arriving after a newer session started does not tear it down', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://race-force.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  // Start the old operation and pause its offscreen START_CAPTURE
  // indefinitely by pre-registering a pause keyed to whatever operationId
  // it ends up using. Since we cannot see the operationId from the
  // outside, use a START_CAPTURE override that pauses the *first* call
  // only, then reverts to default behavior for the second (newer) call.
  let firstCallSeen = false;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  offscreenResponder.setStartCaptureOverride(async (payload) => {
    if (!firstCallSeen) {
      firstCallSeen = true;
      await firstGate;
      // By the time this resolves, a newer operation may have already
      // taken the tabId slot at the offscreen layer.
      if (offscreenResponder.sessions.has(payload.tabId)) {
        return { ok: false, error: { code: ERROR_CODES.ALREADY_IN_PROGRESS, message: 'exists' } };
      }
      offscreenResponder.sessions.set(payload.tabId, {
        operationId: payload.operationId,
        pageKey: payload.pageKey,
        gainPercent: payload.gainPercent,
      });
      return { ok: true, data: { tabId: payload.tabId, operationId: payload.operationId } };
    }
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    return { ok: true, data: { tabId: payload.tabId, operationId: payload.operationId } };
  });

  const oldStartPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20); // old operation is now stuck inside its paused START_CAPTURE

  // Cancel the old (still-starting) operation locally and start a new one.
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  await enableTab(tabId);
  const newSessionOperationId = offscreenResponder.sessions.get(tabId)?.operationId;
  assert.ok(newSessionOperationId);

  // Now release the old operation's paused response - it discovers the
  // tabId already occupied and returns ALREADY_IN_PROGRESS, which the
  // service worker must treat as an ambiguous/failed start and attempt a
  // *scoped*, force:false cleanup - never disturbing the newer session.
  releaseFirst();
  const oldResult = await oldStartPromise;
  assert.equal(oldResult.ok, false);

  await tick(20);
  assert.equal(offscreenResponder.sessions.has(tabId), true);
  assert.equal(offscreenResponder.sessions.get(tabId).operationId, newSessionOperationId);

  offscreenResponder.setStartCaptureOverride(null);
});

// ===========================================================================
// Fix #4: emergencyFailClosed must have hard timeouts and always reach
// closeDocument()/clear the cache, even when offscreen never responds.
// ===========================================================================

test('fix4: GET_ACTIVE_SESSIONS that never resolves still reaches closeDocument and clears the cache', async () => {
  resetEverything();
  offscreenDocumentCreated = true;

  // The *ordinary* reconcileState() call to GET_ACTIVE_SESSIONS must
  // resolve normally (it is not the thing under test and is not
  // timeout-wrapped) - reconciliation is instead driven to fail via
  // getCapturedTabs throwing below. Only the *second* call - the one made
  // from inside emergencyFailClosed() itself - hangs forever.
  let getActiveSessionsCallCount = 0;
  offscreenResponder.setGetActiveSessionsOverride(() => {
    getActiveSessionsCallCount += 1;
    if (getActiveSessionsCallCount === 1) {
      return { ok: true, data: { sessions: [] } };
    }
    return new Promise(() => {}); // the emergency query itself never resolves
  });

  const tabId = freshTabId();
  setTab(tabId, 'https://hang.example/');
  await addAndAssertSaved('https://hang.example/');

  // Force a total reconciliation failure by making getCapturedTabs throw,
  // which drives ensureReconciled() into its emergency path.
  const originalGetCapturedTabs = globalThis.chrome.tabCapture.getCapturedTabs;
  globalThis.chrome.tabCapture.getCapturedTabs = async () => {
    throw new Error('simulated tabCapture failure');
  };

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);

  globalThis.chrome.tabCapture.getCapturedTabs = originalGetCapturedTabs;
  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('fix4: a single hung STOP_CAPTURE during emergency cleanup still reaches closeDocument', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  offscreenResponder.sessions.set(9001, { operationId: 'op-hang', pageKey: 'https://irrelevant.example/', gainPercent: 100 });
  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {})); // never resolves

  const originalGetCapturedTabs = globalThis.chrome.tabCapture.getCapturedTabs;
  globalThis.chrome.tabCapture.getCapturedTabs = async () => {
    throw new Error('simulated tabCapture failure');
  };

  const tabId = freshTabId();
  setTab(tabId, 'https://trigger.example/');
  await addAndAssertSaved('https://trigger.example/');

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1);

  globalThis.chrome.tabCapture.getCapturedTabs = originalGetCapturedTabs;
  offscreenResponder.setStopCaptureOverride(null);
});

test('fix4: a malformed GET_ACTIVE_SESSIONS enumeration response reaches closeDocument', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  offscreenResponder.setGetActiveSessionsOverride(() => ({ ok: true, data: { sessions: 'not-an-array' } }));

  const originalGetCapturedTabs = globalThis.chrome.tabCapture.getCapturedTabs;
  globalThis.chrome.tabCapture.getCapturedTabs = async () => {
    throw new Error('simulated tabCapture failure');
  };

  const tabId = freshTabId();
  setTab(tabId, 'https://malformed.example/');
  await addAndAssertSaved('https://malformed.example/');

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1);

  globalThis.chrome.tabCapture.getCapturedTabs = originalGetCapturedTabs;
  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('fix4: the cache is cleared even when closeDocument itself rejects', async () => {
  resetEverything();
  offscreenDocumentCreated = true;

  // Same reasoning as the first fix4 test: only the *emergency* query
  // (the second call) should hang - the ordinary reconciliation call must
  // resolve normally so reconciliation actually reaches (and fails via)
  // getCapturedTabs below.
  let getActiveSessionsCallCount = 0;
  offscreenResponder.setGetActiveSessionsOverride(() => {
    getActiveSessionsCallCount += 1;
    if (getActiveSessionsCallCount === 1) {
      return { ok: true, data: { sessions: [] } };
    }
    return new Promise(() => {});
  });

  const originalCloseDocument = globalThis.chrome.offscreen.closeDocument;
  globalThis.chrome.offscreen.closeDocument = async () => {
    closeDocumentCallCount += 1;
    throw new Error('simulated closeDocument failure');
  };
  const originalGetCapturedTabs = globalThis.chrome.tabCapture.getCapturedTabs;
  globalThis.chrome.tabCapture.getCapturedTabs = async () => {
    throw new Error('simulated tabCapture failure');
  };

  const tabId = freshTabId();
  setTab(tabId, 'https://close-fails.example/');
  await addAndAssertSaved('https://close-fails.example/');

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1);

  // A later, ordinary call must be able to proceed (proves the cache was
  // cleared and reconciliation is retryable, not permanently wedged).
  globalThis.chrome.offscreen.closeDocument = originalCloseDocument;
  globalThis.chrome.tabCapture.getCapturedTabs = originalGetCapturedTabs;
  offscreenResponder.setGetActiveSessionsOverride(null);
  offscreenDocumentCreated = false;

  const secondResponse = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(secondResponse.ok, true);
});

// ===========================================================================
// Fix #6: every ambiguous post-getMediaStreamId failure must attempt
// operation-scoped offscreen cleanup, never merely delete the local cache.
// ===========================================================================

test('fix6: offscreen creates a session but the START_CAPTURE response is lost - cleanup still runs', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://lost-response.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  offscreenResponder.setStartCaptureOverride(async (payload) => {
    // The offscreen document really does create the session...
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    // ...but its response back to the service worker is lost/malformed.
    return undefined;
  });

  const response = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  assert.equal(response.ok, false);

  // The service worker must have asked the offscreen document to tear
  // down the orphaned session it actually created.
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  offscreenResponder.setStartCaptureOverride(null);
});

test('fix6: START_CAPTURE returns malformed data (ok:true but no operationId echoed) - treated as ambiguous, cleaned up', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://malformed-start.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  offscreenResponder.setStartCaptureOverride(async (payload) => {
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    return { ok: true, data: {} }; // missing operationId - not a confirmed match
  });

  const response = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  assert.equal(response.ok, false);
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  offscreenResponder.setStartCaptureOverride(null);
});

test('fix6: cleanup itself is lost - escalates to emergency fail-closed rather than leaving the graph alive', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://cleanup-lost.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  offscreenResponder.setStartCaptureOverride(async (payload) => {
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    return undefined; // ambiguous
  });
  // The follow-up cleanup STOP_CAPTURE also hangs forever.
  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {}));

  const response = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  assert.equal(response.ok, false);
  // Escalation must have reached closeDocument, since the scoped cleanup
  // could not be confirmed within the timeout.
  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setStartCaptureOverride(null);
  offscreenResponder.setStopCaptureOverride(null);
});

test('fix6: a stale cleanup request cannot affect a newer, unrelated operation for the same tab', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://stale-cleanup.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  let firstCallSeen = false;
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  offscreenResponder.setStartCaptureOverride(async (payload) => {
    if (!firstCallSeen) {
      firstCallSeen = true;
      await firstGate;
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure' } };
    }
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    return { ok: true, data: { tabId: payload.tabId, operationId: payload.operationId } };
  });

  const firstPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  await enableTab(tabId);
  const newOperationId = offscreenResponder.sessions.get(tabId)?.operationId;

  releaseFirst();
  await firstPromise;
  await tick(20);

  assert.equal(offscreenResponder.sessions.has(tabId), true);
  assert.equal(offscreenResponder.sessions.get(tabId).operationId, newOperationId);

  offscreenResponder.setStartCaptureOverride(null);
});

// ===========================================================================
// Review round 2, fix #1: normal teardown (navigation, Remove, Clear all,
// tab closure, capture-status cleanup, explicit Disable) must never delete
// the local cache entry before the offscreen document has *confirmed* the
// session actually stopped. A failed/lost/malformed STOP_CAPTURE response
// must escalate to the emergency fail-closed sweep and return a structured
// failure - never silently claim the tab is inactive.
// ===========================================================================

test('r2fix1: explicit Disable where STOP_CAPTURE returns ok:false does not claim inactive, and escalates to emergency cleanup', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://disable-ok-false.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride(() => ({
    ok: false,
    error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated offscreen failure' },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false); // never claims {state:'inactive'} on an unconfirmed outcome

  // Escalation must have force-swept everything, including closing the
  // offscreen document, since even the emergency force:true retry hits the
  // same override.
  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r2fix1: navigation where STOP_CAPTURE never resolves still reaches closeDocument and clears the cache', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://nav-stop-hangs.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {})); // never resolves, ever

  await fireCommitted(tabId, pageKey); // unconditional full-document-navigation teardown, per spec
  // Navigation listeners are fire-and-forget - wait out both the confirm
  // timeout (1500ms) and emergency's own per-session force:true timeout
  // (another 1500ms) with real wall-clock time, plus a generous margin
  // beyond the 3000ms theoretical minimum (real setTimeout-based waits
  // need headroom beyond the exact sum, not just enough for the ideal
  // case - see the identically-shaped r3fix4 "navigation listener" test
  // below, which budgets 4200ms for the same two-chained-timeout shape).
  await tick(500); // two chained offscreen timeouts (60ms each) + a wide margin

  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.size, 0);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');

  offscreenResponder.setStopCaptureOverride(null);
});

// ===========================================================================
// r5 issue #4: a saved preference must NEVER be deleted/cleared while a live
// session for it could still be running. REMOVE/CLEAR stop matching sessions
// FIRST, and abort the storage mutation entirely (returning a structured
// failure) if any required teardown cannot be positively confirmed.
// ===========================================================================

test('r5-4 #1: REMOVE where the stop returns malformed success leaves the saved entry intact and returns failure', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://remove-malformed.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 133);
  await enableTab(tabId);

  // ok:true but missing the tabId this call was actually about - never a
  // positive confirmation, per confirmedStopCapture's own contract.
  offscreenResponder.setStopCaptureOverride(() => ({ ok: true, data: {} }));

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, false, 'an unconfirmed teardown must not report success');
  // The saved preference is completely intact - the storage mutation never ran.
  assert.equal((await savedVolumes())[pageKey], 133);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #4: CLEAR where one of two stops fails leaves savedPages entirely intact and returns failure', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageA = 'https://clear-fail-a.example/';
  const pageB = 'https://clear-fail-b.example/';
  setTab(tabA, pageA);
  setTab(tabB, pageB);
  await addAndAssertSaved(pageA, 110);
  await addAndAssertSaved(pageB, 120);
  await enableTab(tabA);
  await enableTab(tabB);

  offscreenResponder.setStopCaptureOverride((payload) => {
    if (payload.tabId === tabA) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure for tabA only' } };
    }
    return offscreenResponder.defaultStopCapture(payload);
  });

  const response = await send(MESSAGE_TYPES.CLEAR_SAVED_PAGES, {}, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, false, 'CLEAR must not report success when a required stop failed');
  // savedPages is NEVER cleared - both entries survive intact.
  const pages = await savedVolumes();
  assert.equal(pages[pageA], 110);
  assert.equal(pages[pageB], 120);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #2: REMOVE where the stop times out (never resolves) leaves the saved entry intact and returns failure', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://remove-timeout.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 155);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {})); // never resolves

  const responsePromise = send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  await tick(500); // confirm timeout + emergency force:true timeout + a wide margin
  const response = await responsePromise;

  assert.equal(response.ok, false);
  assert.equal((await savedVolumes())[pageKey], 155, 'the saved entry survives a timed-out teardown');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #3: REMOVE where the stop reports operation_mismatch returns failure and leaves storage intact', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://remove-mismatch.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 145);
  await enableTab(tabId);
  capturedTabsData = [{ tabId, status: 'active' }];

  // A genuine, internally-consistent operation_mismatch - a DIFFERENT
  // operation now owns this tabId at the offscreen layer. Never treated as
  // a confirmed stop, so REMOVE must not delete the saved entry.
  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: payload.operationId ?? null,
      status: 'operation_mismatch',
      stoppedOperationId: null,
      currentOperationId: 'some-other-live-operation-id',
    },
  }));

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, false);
  assert.equal((await savedVolumes())[pageKey], 145, 'storage intact after an operation_mismatch');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #5: a successful REMOVE stops the matching session BEFORE the saved entry is deleted (never a window where the entry is gone but the session lives)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://remove-order.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 130);
  await enableTab(tabId);

  // Observe the ordering directly: at the moment the offscreen STOP_CAPTURE
  // is processed, the saved entry must still be present (storage is only
  // mutated AFTER a confirmed stop).
  let savedPresentAtStopTime = null;
  offscreenResponder.setStopCaptureOverride(async (payload) => {
    savedPresentAtStopTime = pageKey in (await savedVolumes());
    return offscreenResponder.defaultStopCapture(payload);
  });

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(savedPresentAtStopTime, true, 'the saved entry was still present while the session was being stopped');
  assert.equal(offscreenResponder.sessions.has(tabId), false, 'the session was stopped');
  assert.equal(pageKey in (await savedVolumes()), false, 'the saved entry is gone only after the confirmed stop');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #6: a successful CLEAR stops all snapshot sessions before committing {}', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageA = 'https://clear-order-a.example/';
  const pageB = 'https://clear-order-b.example/';
  setTab(tabA, pageA);
  setTab(tabB, pageB);
  await addAndAssertSaved(pageA);
  await addAndAssertSaved(pageB);
  await enableTab(tabA);
  await enableTab(tabB);

  let savedCountAtFirstStop = null;
  offscreenResponder.setStopCaptureOverride(async (payload) => {
    if (savedCountAtFirstStop === null) {
      savedCountAtFirstStop = Object.keys(await savedVolumes()).length;
    }
    return offscreenResponder.defaultStopCapture(payload);
  });

  const response = await send(MESSAGE_TYPES.CLEAR_SAVED_PAGES, {}, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(savedCountAtFirstStop, 2, 'both saved entries were still present while sessions were being stopped');
  assert.equal(offscreenResponder.sessions.size, 0, 'all snapshot sessions stopped');
  assert.deepEqual(await savedVolumes(), {}, 'storage committed to {} only after every stop');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #7: REMOVE never reports ok:true while a required teardown was unconfirmed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://no-false-ok-remove.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride(() => ({ ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'x' } }));
  const removeResp = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(removeResp.ok, false);
  offscreenResponder.setStopCaptureOverride(null);
});

test('r5-4 #7: CLEAR never reports ok:true while a required teardown was unconfirmed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://no-false-ok-clear.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride(() => ({ ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'x' } }));
  const clearResp = await send(MESSAGE_TYPES.CLEAR_SAVED_PAGES, {}, OPTIONS_TEST_SENDER);
  assert.equal(clearResp.ok, false);
  offscreenResponder.setStopCaptureOverride(null);
});

// ===========================================================================
// r5 issue #3: START_CAPTURE is scoped to the exact page the user acted on.
// The popup's server-derived expectedPageKey is compared against the tab's
// freshly re-derived current pageKey; a mismatch (the tab navigated between
// the popup's last observed state and the click/slider) aborts with
// PAGE_CHANGED and never reaches getMediaStreamId or the offscreen layer.
// ===========================================================================

test('r5-3: click/slider observed page A, but tabs.get returns page B - capture never starts (PAGE_CHANGED)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://start-race-a.example/';
  const pageB = 'https://start-race-b.example/';
  setTab(tabId, pageA);

  const releaseTabsGet = pauseTabsGet(tabId);
  // The popup observed page A, so it sends expectedPageKey = A.
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, { tabId, expectedPageKey: pageA, initialGainPercent: 150 });
  await tick(20);
  setTab(tabId, pageB); // the tab navigates before chrome.tabs.get resolves
  releaseTabsGet();

  const response = await startPromise;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_CHANGED);
  // Never reached the offscreen layer, and no getMediaStreamId was consumed.
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  assert.equal(offscreenResponder.pending.has(tabId), false);

  // The tab genuinely ends up inactive, not stuck 'resolving'/'starting'.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
  assert.notEqual(state.data.state, 'starting');
  assert.notEqual(state.data.state, 'resolving');
});

test('r5-3: a matching expectedPageKey starts normally', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://start-match.example/';
  setTab(tabId, pageKey);

  const response = await send(MESSAGE_TYPES.START_CAPTURE, { tabId, expectedPageKey: pageKey, initialGainPercent: 160 });
  assert.equal(response.ok, true);
  assert.equal(response.data.state, 'active');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 160);
});

test('r5-3: a navigation event during the resolving registration still cancels normally (same-page expectedPageKey, cancelled before capture)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://start-resolving-nav.example/';
  setTab(tabId, pageKey);

  const releaseTabsGet = pauseTabsGet(tabId);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, { tabId, expectedPageKey: pageKey, initialGainPercent: 140 });
  await tick(20);
  await fireCommitted(tabId, pageKey); // navigation while still 'resolving' cancels it
  releaseTabsGet();

  const response = await startPromise;
  assert.equal(response.ok, false);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

test('r5-3: one START_CAPTURE cannot use a stale pageKey from an earlier popup state (expectedPageKey B on a tab now showing A is refused)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageNow = 'https://start-stale-now.example/';
  const pageStale = 'https://start-stale-old.example/';
  setTab(tabId, pageNow);

  // The popup's expectedPageKey is a stale value (the tab actually shows
  // pageNow). The service worker re-derives pageNow and refuses.
  const response = await send(MESSAGE_TYPES.START_CAPTURE, { tabId, expectedPageKey: pageStale, initialGainPercent: 130 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_CHANGED);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

// ===========================================================================
// r5 issue #7: emergency enumeration must fail closed on malformed pending.
// A response with a valid `sessions` array but a malformed/missing `pending`
// is an untrustworthy enumeration - it must reach closeDocument, never be
// swept with a silently-substituted empty pending list.
// ===========================================================================

async function drainEmergencyThroughReconciliation(triggerUrl) {
  // Forces reconcileState() to fail (getCapturedTabs throws) so
  // ensureReconciled() runs the emergency sweep, whose own GET_ACTIVE_SESSIONS
  // response is what the override under test shapes.
  const originalGetCapturedTabs = globalThis.chrome.tabCapture.getCapturedTabs;
  globalThis.chrome.tabCapture.getCapturedTabs = async () => {
    throw new Error('simulated tabCapture failure');
  };
  const triggerTabId = freshTabId();
  setTab(triggerTabId, triggerUrl);
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });
  globalThis.chrome.tabCapture.getCapturedTabs = originalGetCapturedTabs;
  return response;
}

test('r5-7: emergency enumeration with sessions:[] but pending:"bad" (not an array) reaches closeDocument', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  let call = 0;
  offscreenResponder.setGetActiveSessionsOverride(() => {
    call += 1;
    // First call (ordinary reconcile) resolves normally so reconciliation
    // proceeds to the failing getCapturedTabs; the emergency call returns
    // the malformed-pending shape under test.
    if (call === 1) return { ok: true, data: { sessions: [], pending: [] } };
    return { ok: true, data: { sessions: [], pending: 'bad' } };
  });

  const response = await drainEmergencyThroughReconciliation('https://emergency-bad-pending.example/');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1, 'a malformed pending array fails closed to closeDocument');

  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('r5-7: emergency enumeration with sessions:[] but pending missing entirely reaches closeDocument', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  let call = 0;
  offscreenResponder.setGetActiveSessionsOverride(() => {
    call += 1;
    if (call === 1) return { ok: true, data: { sessions: [], pending: [] } };
    return { ok: true, data: { sessions: [] } }; // pending missing entirely
  });

  const response = await drainEmergencyThroughReconciliation('https://emergency-missing-pending.example/');
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1, 'a missing pending array fails closed to closeDocument');

  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('r5-7: emergency enumeration with valid empty sessions AND pending arrays does NOT unnecessarily close the document', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  let call = 0;
  offscreenResponder.setGetActiveSessionsOverride(() => {
    call += 1;
    if (call === 1) return { ok: true, data: { sessions: [], pending: [] } };
    return { ok: true, data: { sessions: [], pending: [] } }; // genuinely nothing to sweep
  });

  const response = await drainEmergencyThroughReconciliation('https://emergency-clean-empty.example/');
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 0, 'a genuinely empty (well-formed) enumeration recovers without closing the document');

  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('r5-7: the SW cache is cleared even when closeDocument itself rejects during a malformed-pending emergency', async () => {
  resetEverything();
  offscreenDocumentCreated = true;

  let call = 0;
  offscreenResponder.setGetActiveSessionsOverride(() => {
    call += 1;
    if (call === 1) return { ok: true, data: { sessions: [], pending: [] } };
    return { ok: true, data: { sessions: [], pending: undefined } }; // malformed pending
  });
  globalThis.chrome.offscreen.closeDocument = async () => {
    closeDocumentCallCount += 1;
    throw new Error('simulated closeDocument failure');
  };

  const response = await drainEmergencyThroughReconciliation('https://emergency-close-rejects-trigger.example/');
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1, 'closeDocument was still attempted despite the malformed pending array');

  // A later, ordinary request must proceed (proves the cache was cleared and
  // reconciliation is retryable, not permanently wedged). resetEverything's
  // canonical-global restore in the NEXT test undoes the closeDocument
  // override even though this test never restores it itself.
  offscreenResponder.setGetActiveSessionsOverride(null);
  globalThis.chrome.offscreen.closeDocument = CANONICAL_CLOSE_DOCUMENT;
  offscreenDocumentCreated = false;
  const followUp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: freshTabId() });
  assert.equal(followUp.ok, true);
});

test('r2fix1: the cache entry is not deleted until teardown is actually confirmed - a mid-flight snapshot still shows the session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://mid-flight.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  offscreenResponder.setStopCaptureOverride(async (payload) => {
    await stopGate;
    const session = offscreenResponder.sessions.get(payload.tabId);
    offscreenResponder.sessions.delete(payload.tabId);
    return {
      ok: true,
      data: {
        tabId: payload.tabId,
        requestedOperationId: payload.operationId ?? null,
        status: 'stopped',
        stoppedOperationId: session?.operationId ?? null,
        currentOperationId: null,
      },
    };
  });

  const stopPromise = send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  await tick(20); // let it reach and block inside the paused offscreen STOP_CAPTURE

  // Snapshot while teardown is still unconfirmed: the service worker must
  // not have silently forgotten this session yet.
  const midFlightState = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(midFlightState.data.state, 'active');

  releaseStop();
  const stopResponse = await stopPromise;
  assert.equal(stopResponse.ok, true);

  const finalState = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(finalState.data.state, 'active');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r2fix1: duplicate teardown calls for the same tab are idempotent and never disturb a newer session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://idempotent-teardown.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  const first = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(first.ok, true);
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  // A second, superseded Disable-style teardown for the *same*, now-stale
  // operationId must remain a harmless no-op even after a brand new
  // session has since started on this tabId.
  await enableTab(tabId);
  const secondTeardownForStaleOp = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId }); // this one targets the CURRENT session, which is fine
  assert.equal(secondTeardownForStaleOp.ok, true);
  assert.notEqual(data.operationId, undefined);
});

// ===========================================================================
// Product-model correction: ADD_CURRENT_PAGE saves the exact current URL
// plus the popup's current slider value, atomically. It never starts,
// stops, or restarts capture - if a temporary session is already active,
// it simply becomes associated with the newly saved preference - and it
// never saves the wrong page if navigation races the click.
// ===========================================================================

test('ADD_CURRENT_PAGE saves the current slider value alongside the URL', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://add-current-saves-value.example/';
  setTab(tabId, pageKey);

  const response = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 165 });
  assert.equal(response.ok, true, `expected ADD_CURRENT_PAGE to succeed: ${JSON.stringify(response)}`);
  assert.equal(response.data.volumePercent, 165);
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 165);
});

test('ADD_CURRENT_PAGE upgrades an already-active temporary (unsaved) session without restarting or recapturing it', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://add-current-upgrades-temp.example/';
  setTab(tabId, pageKey);

  // No addAndAssertSaved here - this page starts genuinely unsaved, and
  // enableTab still works, per the new product model.
  const { data } = await enableTab(tabId);
  const operationIdBeforeSave = offscreenResponder.sessions.get(tabId)?.operationId;
  assert.ok(operationIdBeforeSave);

  const response = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 140 });
  assert.equal(response.ok, true);

  // The exact same live session, completely undisturbed - no new
  // START_CAPTURE round trip, no new operationId.
  assert.equal(offscreenResponder.sessions.get(tabId)?.operationId, operationIdBeforeSave);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.operationId, data.operationId);
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.saved, true, 'now associated with a saved preference');

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 140);
});

test('navigation racing ADD_CURRENT_PAGE saves neither the old nor the destination page', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://add-current-race-a.example/';
  const pageB = 'https://add-current-race-b.example/';
  setTab(tabId, pageA);

  const releaseTabsGet = pauseTabsGet(tabId);
  const addPromise = send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageA, gainPercent: 120 });
  await tick(20);
  setTab(tabId, pageB); // the tab navigates before chrome.tabs.get actually resolves
  releaseTabsGet();

  const response = await addPromise;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_CHANGED);

  const pages = await savedVolumes();
  assert.equal(pageA in pages, false);
  assert.equal(pageB in pages, false);
});

test('a matching expectedPageKey (no race) still succeeds normally for ADD_CURRENT_PAGE', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://add-current-happy-path.example/';
  setTab(tabId, pageKey);

  const addResponse = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 100 });
  assert.equal(addResponse.ok, true);
  assert.deepEqual(await savedVolumes(), { [pageKey]: 100 });
});

test('Add this page is idempotent - saving an already-saved page preserves its existing value, never creating a duplicate or silent overwrite', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://add-current-idempotent.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 155);

  const response = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 30 });
  assert.equal(response.ok, true);
  assert.equal(response.data.volumePercent, 155);
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 155);
});

// ===========================================================================
// Review round 2, fix #3: the offscreen START_CAPTURE round trip itself
// must be time-bounded - a hung response must never leave an operation
// stuck 'starting' forever, or the tab's native output muted indefinitely.
// ===========================================================================

test('r2fix3: offscreen START_CAPTURE never resolves - the operation times out and cleanup succeeds', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://start-hangs.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  let releaseStart;
  const startGate = new Promise((resolve) => {
    releaseStart = resolve;
  });
  offscreenResponder.setStartCaptureOverride(async (payload) => {
    // The offscreen document really does create the session before its
    // response back to the service worker gets stuck.
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    await startGate;
    return { ok: true, data: { tabId: payload.tabId, operationId: payload.operationId } };
  });

  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(300); // past the START_CAPTURE confirm timeout

  const response = await startPromise;
  assert.equal(response.ok, false);
  // Cleanup (force:false, operation-scoped) must have succeeded, since the
  // session really did exist - never left in 'starting' state indefinitely.
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
  assert.notEqual(state.data.state, 'starting');

  releaseStart(); // let the abandoned promise settle so it doesn't leak into later tests
  offscreenResponder.setStartCaptureOverride(null);
});

test('r2fix3: offscreen START_CAPTURE never resolves AND its own cleanup also hangs - escalates all the way to closeDocument', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://start-and-cleanup-hang.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  offscreenResponder.setStartCaptureOverride(async (payload) => {
    offscreenResponder.sessions.set(payload.tabId, {
      operationId: payload.operationId,
      pageKey: payload.pageKey,
      gainPercent: payload.gainPercent,
    });
    return new Promise(() => {}); // never resolves
  });
  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {})); // cleanup also never resolves

  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  // START_CAPTURE timeout (1500) + cleanup timeout (1500) + emergency's own
  // per-session force:true STOP_CAPTURE timeout (1500), all real wall-clock.
  await tick(600);

  const response = await startPromise;
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStartCaptureOverride(null);
  offscreenResponder.setStopCaptureOverride(null);
});

test('r2fix3: a late START_CAPTURE response arriving after the timeout cannot reactivate a cancelled operation', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://late-start-response.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  // Uses the real PendingStart bookkeeping (via createControllablePendingStart)
  // rather than a naive override, so the SW's timeout-triggered cleanup
  // STOP_CAPTURE has a genuine PendingStart to find and cancel - and so a
  // late "getUserMedia() resolved" completion, arriving after that
  // cancellation, is provably refused rather than merely never observed.
  const { override, release: releaseStart } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);

  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20); // let the PendingStart actually register at the offscreen layer
  assert.equal(offscreenResponder.pending.has(tabId), true);

  await tick(300); // past the timeout - cleanup has cancelled the PendingStart by now
  const response = await startPromise;
  assert.equal(response.ok, false);

  const stateAfterTimeout = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(stateAfterTimeout.data.state, 'active');
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  // Now the abandoned original request finally resolves - it must be
  // completely inert, since nothing in beginCaptureForPage is still
  // listening to it (Promise.race already settled long ago), AND the
  // offscreen document's own PendingStart-cancellation check must refuse
  // to create a Session for an operation it already marked cancelled.
  releaseStart();
  await tick(30);

  const stateAfterLateResponse = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(stateAfterLateResponse.data.state, 'active');
  assert.equal(offscreenResponder.sessions.has(tabId), false, 'no late MediaStream/graph was ever created');
  assert.equal(offscreenResponder.pending.has(tabId), false, 'the PendingStart entry was cleaned up, not left dangling');

  offscreenResponder.setStartCaptureOverride(null);
});

// ===========================================================================
// Review round 2, fix #5: a normal Disable uses force:false with the
// tab's exact current operationId - never force:true - so a stale Disable
// teardown that finally resolves after a newer operation has since started
// on the same tab can never stop that newer session.
// ===========================================================================

test('r2fix5: a stale Disable teardown confirmed after a newer operation has started never stops the newer session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://disable-race.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data: oldData } = await enableTab(tabId);

  let releaseStop;
  const stopGate = new Promise((resolve) => {
    releaseStop = resolve;
  });
  offscreenResponder.setStopCaptureOverride(async (payload) => {
    // The offscreen document genuinely tears the old session down right
    // away, but its response back to the service worker is delayed -
    // simulating a service-worker restart racing an in-flight Disable.
    const session = offscreenResponder.sessions.get(payload.tabId);
    offscreenResponder.sessions.delete(payload.tabId);
    await stopGate;
    return {
      ok: true,
      data: {
        tabId: payload.tabId,
        requestedOperationId: payload.operationId ?? null,
        status: 'stopped',
        stoppedOperationId: session?.operationId ?? null,
        currentOperationId: null,
      },
    };
  });

  const disablePromise = send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  await tick(20); // let it reach and block inside the paused offscreen STOP_CAPTURE

  // Simulate the service worker's own in-memory cache having been reset
  // (a real MV3 worker restart) while the old Disable's continuation is
  // still suspended - the *offscreen document* is untouched by this.
  sw.__resetForTests();

  // A brand new operation starts cleanly for the same tab, since the
  // offscreen document genuinely has no session for it anymore.
  const { data: newData } = await enableTab(tabId);
  assert.notEqual(newData.operationId, oldData.operationId);

  // Only now does the old Disable's delayed-but-confirmed response arrive.
  releaseStop();
  const disableResult = await disablePromise;
  assert.equal(disableResult.ok, true);

  // The newer session must be completely undisturbed - requestOffscreenTeardown's
  // own "operationId still current" recheck must have refused to delete it.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.operationId, newData.operationId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);
  assert.equal(offscreenResponder.sessions.get(tabId).operationId, newData.operationId);

  offscreenResponder.setStopCaptureOverride(null);
});

// ===========================================================================
// Review round 2, fix #6: SET_TAB_GAIN/PERSIST_PAGE_VOLUME must be scoped
// to the exact session generation (operationId) the caller last observed -
// a message tagged with a superseded operationId must never affect
// whichever session is current now, at either the service-worker or the
// offscreen layer.
// ===========================================================================

test('r2fix6: a stale expectedOperationId on SET_TAB_GAIN is rejected and never changes the live gain', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://gain-stale-op.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data: oldData } = await enableTab(tabId);
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  const { data: newData } = await enableTab(tabId);
  assert.notEqual(newData.operationId, oldData.operationId);

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 175,
    expectedOperationId: oldData.operationId, // stale
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.NOT_ACTIVE);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 100); // untouched
});

test('r2fix6: a stale expectedOperationId on PERSIST_PAGE_VOLUME is rejected and never changes the saved volume', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://persist-stale-op.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data: oldData } = await enableTab(tabId);
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId,
    gainPercent: 175,
    expectedOperationId: oldData.operationId, // stale
  });
  assert.equal(response.ok, false);
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 100);
});

test('r2fix6: SET_TAB_GAIN/PERSIST_PAGE_VOLUME with the current operationId still work normally', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://gain-current-op.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  const gainResponse = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 140,
    expectedOperationId: data.operationId,
  });
  assert.equal(gainResponse.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 140);

  const persistResponse = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId,
    gainPercent: 145,
    expectedOperationId: data.operationId,
  });
  assert.equal(persistResponse.ok, true);
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 145);
});

test('r2fix6: the offscreen document itself rejects a SET_TAB_GAIN whose operationId does not match the live session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://offscreen-gain-mismatch.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  const response = await dispatch({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.SET_TAB_GAIN,
    requestId: 'direct-test',
    payload: { tabId, gainPercent: 190, operationId: 'not-the-real-operation-id' },
  });
  assert.equal(response.ok, false);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 100); // untouched
});

// ===========================================================================
// Product-model correction: REMOVE_SAVED_PAGE is a direct, pageKey-scoped
// removal from the saved-pages view - it has no navigation-race concept at
// all (no expectedPageKey, no dependency on any particular tab's current
// URL), unlike ADD_CURRENT_PAGE above, and never removes or affects a
// different URL on the same hostname.
// ===========================================================================

test('REMOVE_SAVED_PAGE removes only the exact pageKey given, regardless of what any open tab currently shows', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://remove-saved-a.example/';
  const pageB = 'https://remove-saved-b.example/';
  setTab(tabId, pageB); // the open tab shows a COMPLETELY different page
  await addAndAssertSaved(pageA);
  await addAndAssertSaved(pageB);

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey: pageA }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);

  const pages = await savedVolumes();
  assert.equal(pageA in pages, false);
  assert.equal(pageB in pages, true);
});

test('REMOVE_SAVED_PAGE never removes or affects a different exact URL on the identical hostname', async () => {
  resetEverything();
  await addAndAssertSaved('https://same-host.example/page-a');
  await addAndAssertSaved('https://same-host.example/page-b');

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey: 'https://same-host.example/page-a' }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);

  const pages = await savedVolumes();
  assert.equal('https://same-host.example/page-a' in pages, false);
  assert.equal('https://same-host.example/page-b' in pages, true);
});

test('required#16: deleting a saved page stops its matching active session safely (confirmed teardown, no error injection)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://delete-stops-session.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
  assert.equal(state.data.saved, false);
});

test('required#17: Clear all stops every active session safely (confirmed teardown, no error injection)', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageA = 'https://clear-stops-a.example/';
  const pageB = 'https://clear-stops-b.example/';
  setTab(tabA, pageA);
  setTab(tabB, pageB);
  await addAndAssertSaved(pageA);
  await addAndAssertSaved(pageB);
  await enableTab(tabA);
  await enableTab(tabB);

  const response = await send(MESSAGE_TYPES.CLEAR_SAVED_PAGES, {}, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.size, 0);
  assert.deepEqual(await savedVolumes(), {});

  const stateA = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabA });
  const stateB = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabB });
  assert.notEqual(stateA.data.state, 'active');
  assert.notEqual(stateB.data.state, 'active');
});

test('required#18: opening a saved page does not auto-start capture', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://opening-no-autostart.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 140);

  // "Opening the page" (or the popup on it) is simulated by a plain
  // GET_TAB_STATE query - the only thing a freshly opened popup ever does
  // before the user takes any explicit action.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.saved, true);
  assert.equal(state.data.state, 'inactive', 'never auto-started merely because the page is saved');
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

test('required#19: the main slider value (gainPercent) shows the saved percentage while inactive', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://slider-shows-saved.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 165);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'inactive');
  assert.equal(state.data.gainPercent, 165);
});

test('required#20: the main slider value (gainPercent) shows the actual live value while active, even after it diverges from the saved value', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://slider-shows-live.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  const { data } = await enableTab(tabId);

  // Live-only change (SET_TAB_GAIN, no PERSIST_PAGE_VOLUME) - the saved
  // value stays 100, but the live value the slider must show is 190.
  await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 190, expectedOperationId: data.operationId });

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.gainPercent, 190, 'the actual live value, not the still-100 saved value');
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 100, 'the saved value itself is untouched by a purely live change');
});

test('required#21: the obsolete ADD_PAGE_AND_ENABLE message type is rejected outright (it no longer exists in the protocol)', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://add-and-enable-gone.example/');
  const response = await send('ADD_PAGE_AND_ENABLE', { tabId });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('required#21b: popup.html no longer contains an "Add and enable" button', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const popupHtml = await fs.readFile(path.join(here, '..', 'popup', 'popup.html'), 'utf8');
  assert.equal(/add-enable-button/i.test(popupHtml), false);
  assert.equal(/add\s+and\s+enable/i.test(popupHtml), false);
});

test('max-gain #4: every popup/manual/options slider uses max 300 (constant-driven at runtime, 300 in static HTML)', async () => {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const root = path.join(here, '..');

  // Static HTML fallbacks: both popup range inputs carry max="300", none max="200".
  const popupHtml = await fs.readFile(path.join(root, 'popup', 'popup.html'), 'utf8');
  const rangeMaxes = [...popupHtml.matchAll(/type="range"[\s\S]*?max="(\d+)"/g)].map((m) => m[1]);
  assert.equal(rangeMaxes.length, 2, 'both the main slider and the manual-add slider are present');
  assert.deepEqual(rangeMaxes, ['300', '300']);
  assert.equal(/max="200"/.test(popupHtml), false, 'no leftover max="200" in popup.html');
  assert.ok(/300%/.test(popupHtml), 'the visible endpoint label includes 300%');
  assert.ok(/0 to 300 percent/.test(popupHtml), 'aria-labels say 0 to 300 percent');

  // Runtime, constant-driven: popup.js and options.js drive slider max from
  // MAX_GAIN_PERCENT rather than a separate hard-coded 300.
  const popupJs = await fs.readFile(path.join(root, 'popup', 'popup.js'), 'utf8');
  assert.ok(/els\.slider\.max\s*=\s*String\(MAX_GAIN_PERCENT\)/.test(popupJs));
  assert.ok(/els\.manualVolumeInput\.max\s*=\s*String\(MAX_GAIN_PERCENT\)/.test(popupJs));
  const optionsJs = await fs.readFile(path.join(root, 'options', 'options.js'), 'utf8');
  assert.ok(/slider\.max\s*=\s*String\(MAX_GAIN_PERCENT\)/.test(optionsJs));
});

// ===========================================================================
// UPDATE_SAVED_PAGE_VOLUME: the saved-pages view's own direct, pageKey-
// scoped update - never tab-scoped, never starts a new capture session,
// and propagates live only to sessions sharing the identical exact pageKey.
// ===========================================================================

test('required#11: manually adding a URL (ADD_PAGE_MANUAL) never captures a tab', async () => {
  resetEverything();
  const response = await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: 'https://manual-never-captures.example/', gainPercent: 120 });
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.size, 0);
  assert.equal(createDocumentCallCount, 0, 'the offscreen document itself was never even created');
});

test('required#12: every saved URL has its own independent stored percentage', async () => {
  resetEverything();
  await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: 'https://independent-a.example/', gainPercent: 60 });
  await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: 'https://independent-b.example/', gainPercent: 180 });
  const pages = await savedVolumes();
  assert.equal(pages['https://independent-a.example/'], 60);
  assert.equal(pages['https://independent-b.example/'], 180);
});

test('UPDATE_SAVED_PAGE_VOLUME updates only that exact URL, never starting a new capture session', async () => {
  resetEverything();
  await addAndAssertSaved('https://row-slider-no-capture.example/', 100);

  const response = await send(
    MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    { pageKey: 'https://row-slider-no-capture.example/', gainPercent: 55 },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  const pages = await savedVolumes();
  assert.equal(pages['https://row-slider-no-capture.example/'], 55);
  assert.equal(offscreenResponder.sessions.size, 0, 'never started a session merely from a saved-pages row update');
  assert.equal(createDocumentCallCount, 0);
});

test('required#13: UPDATE_SAVED_PAGE_VOLUME never changes a different URL on the identical hostname', async () => {
  resetEverything();
  await addAndAssertSaved('https://update-same-host.example/page-a', 100);
  await addAndAssertSaved('https://update-same-host.example/page-b', 100);

  await send(
    MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    { pageKey: 'https://update-same-host.example/page-a', gainPercent: 175 },
    OPTIONS_TEST_SENDER
  );

  const pages = await savedVolumes();
  assert.equal(pages['https://update-same-host.example/page-a'], 175);
  assert.equal(pages['https://update-same-host.example/page-b'], 100);
});

test('required#15: UPDATE_SAVED_PAGE_VOLUME propagates live only to active sessions sharing the identical exact pageKey', async () => {
  resetEverything();
  const tabSame1 = freshTabId();
  const tabSame2 = freshTabId();
  const tabDifferent = freshTabId();
  const sharedPageKey = 'https://update-propagate-shared.example/';
  const differentPageKey = 'https://update-propagate-different.example/';
  setTab(tabSame1, sharedPageKey);
  setTab(tabSame2, sharedPageKey);
  setTab(tabDifferent, differentPageKey);
  await addAndAssertSaved(sharedPageKey);
  await addAndAssertSaved(differentPageKey);
  await enableTab(tabSame1);
  await enableTab(tabSame2);
  await enableTab(tabDifferent);

  const response = await send(
    MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    { pageKey: sharedPageKey, gainPercent: 95 },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);

  assert.equal(offscreenResponder.sessions.get(tabSame1).gainPercent, 95);
  assert.equal(offscreenResponder.sessions.get(tabSame2).gainPercent, 95);
  assert.equal(offscreenResponder.sessions.get(tabDifferent).gainPercent, 100, 'a different exact pageKey must never receive the update');
});

test('UPDATE_SAVED_PAGE_VOLUME on a page that is not saved is rejected without creating an entry', async () => {
  resetEverything();
  const response = await send(
    MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    { pageKey: 'https://update-not-saved.example/', gainPercent: 80 },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_NOT_SAVED);
  assert.deepEqual(await savedVolumes(), {});
});

test("a failed live UPDATE_SAVED_PAGE_VOLUME propagation never corrupts the stored value or the other tab's local session state", async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageKey = 'https://update-propagation-partial-fail.example/';
  setTab(tabA, pageKey);
  setTab(tabB, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabA);
  await enableTab(tabB);

  offscreenResponder.setSetTabGainOverride((payload) => {
    if (payload.tabId === tabB) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure for tabB only' } };
    }
    const session = offscreenResponder.sessions.get(payload.tabId);
    session.gainPercent = payload.gainPercent;
    return { ok: true, data: { tabId: payload.tabId, gainPercent: payload.gainPercent } };
  });

  const response = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey, gainPercent: 145 }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true, 'the storage write itself is unconditional and still succeeds');

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 145);
  assert.equal(offscreenResponder.sessions.get(tabA).gainPercent, 145);
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 100, 'never silently marked updated without offscreen confirmation');

  offscreenResponder.setSetTabGainOverride(null);
});

// ===========================================================================
// Two-way synchronization between the popup and the Saved-pages view, scoped
// strictly to the identical exact pageKey. (Required tests 5-13.)
// ===========================================================================

test('sync #5: a popup PERSIST_PAGE_VOLUME commit on a saved page broadcasts the authoritative savedPages to the OPTIONS view', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sync-persist-broadcast.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  const { data } = await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId, gainPercent: 175, expectedOperationId: data.operationId });
  assert.equal(response.ok, true);
  assert.equal((await savedVolumes())[pageKey], 175);

  const optionsBroadcasts = broadcastsTo(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGES_CHANGED);
  assert.ok(optionsBroadcasts.length >= 1, 'SAVED_PAGES_CHANGED was broadcast to the options view');
  const last = optionsBroadcasts[optionsBroadcasts.length - 1];
  assert.equal(last.payload.savedPages[pageKey].volumePercent, 175, 'the broadcast carries the authoritative new saved value');
});

test('sync #6: a Saved-pages row commit (UPDATE_SAVED_PAGE_VOLUME) updates an active identical-page session\'s offscreen gain', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sync-row-updates-offscreen.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey, gainPercent: 250 }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 250, 'the live offscreen gain followed the saved-pages row');
});

test('sync #7: the same row commit broadcasts TAB_STATE_CHANGED for that active tab, so an open popup on it shows the new percentage', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sync-row-updates-popup-active.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey, gainPercent: 235 }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);

  const tabStateBroadcasts = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED).filter((b) => b.payload.tabId === tabId);
  assert.ok(tabStateBroadcasts.length >= 1, 'TAB_STATE_CHANGED was broadcast for the active tab');
  const last = tabStateBroadcasts[tabStateBroadcasts.length - 1];
  assert.equal(last.payload.gainPercent, 235, 'the popup would immediately display the new live percentage');
  assert.equal(last.payload.state, 'active');
});

test('sync #8: a row commit for an INACTIVE identical-page popup broadcasts SAVED_PAGE_CHANGED and never starts capture', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sync-row-inactive-popup.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100); // saved but NOT enabled - no active session

  const response = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey, gainPercent: 220 }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.size, 0, 'no capture session was started');
  assert.equal(createDocumentCallCount, 0, 'the offscreen document was never even created');

  const savedPageChanged = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.SAVED_PAGE_CHANGED).filter((b) => b.payload.pageKey === pageKey);
  assert.ok(savedPageChanged.length >= 1, 'a narrowly-scoped SAVED_PAGE_CHANGED was broadcast to the popup for this exact pageKey');

  // The popup, on receiving it, would refresh GET_TAB_STATE and see the new
  // saved default while still inactive.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'inactive');
  assert.equal(state.data.gainPercent, 220, 'the refreshed popup shows the new saved default');
});

test('sync #9: a row commit for one exact URL never changes a different URL on the identical hostname', async () => {
  resetEverything();
  await addAndAssertSaved('https://sync-host.example/a', 100);
  await addAndAssertSaved('https://sync-host.example/b', 100);

  const response = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey: 'https://sync-host.example/a', gainPercent: 260 }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);

  const pages = await savedVolumes();
  assert.equal(pages['https://sync-host.example/a'], 260);
  assert.equal(pages['https://sync-host.example/b'], 100, 'the sibling exact URL on the same hostname is untouched');
});

test('sync #10: a popup PERSIST commit on one site does not modify a saved row for a different exact pageKey', async () => {
  resetEverything();
  const rezka = 'https://rezka.example/films/movie-1';
  const otherSite = 'https://docs.example/c/abc';
  await addAndAssertSaved(rezka, 150);
  await addAndAssertSaved(otherSite, 100);

  const chatTab = freshTabId();
  setTab(chatTab, otherSite);
  const { data } = await enableTab(chatTab);

  const response = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId: chatTab, gainPercent: 175, expectedOperationId: data.operationId });
  assert.equal(response.ok, true);

  const pages = await savedVolumes();
  assert.equal(pages[otherSite], 175, 'the page that was committed updated');
  assert.equal(pages[rezka], 150, 'the saved Rezka row was NOT modified');

  // The SAVED_PAGES_CHANGED broadcast reflects the authoritative map: Rezka
  // unchanged, the committed page updated.
  const last = broadcastsTo(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGES_CHANGED).slice(-1)[0];
  assert.equal(last.payload.savedPages[rezka].volumePercent, 150);
  assert.equal(last.payload.savedPages[otherSite].volumePercent, 175);
});

test('sync #11: an unsaved page can be temporarily boosted to 155% - live gain works, no savedPages entry is created, and PERSIST is a rejected no-op', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sync-unsaved-155.example/';
  setTab(tabId, pageKey);

  // Slider-triggered start at 155 on an unsaved page.
  const startResp = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 155));
  assert.equal(startResp.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 155, 'live gain is 155%');
  assert.deepEqual(await savedVolumes(), {}, 'no savedPages entry was created');

  // input/change must not persist for an unsaved page: PERSIST is rejected
  // and creates nothing.
  const persistResp = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId,
    gainPercent: 155,
    expectedOperationId: startResp.data.operationId,
  });
  assert.equal(persistResp.ok, false);
  assert.equal(persistResp.error.code, ERROR_CODES.PAGE_NOT_SAVED);
  assert.deepEqual(await savedVolumes(), {}, 'still no savedPages entry');

  // Reopening the popup during the same active session shows the actual live value.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.gainPercent, 155);
  assert.equal(state.data.saved, false);
});

test('sync #12: Add this page during an active unsaved 155% session saves that exact page at 155% without restarting capture', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sync-add-during-155.example/';
  setTab(tabId, pageKey);

  const startResp = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 155));
  assert.equal(startResp.ok, true);
  const operationIdBefore = offscreenResponder.sessions.get(tabId).operationId;

  // The popup's slider currently shows 155, so Add this page sends 155.
  const addResp = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 155 });
  assert.equal(addResp.ok, true);
  assert.equal((await savedVolumes())[pageKey], 155, 'saved at exactly the live 155%');

  // The existing session is untouched - no recapture, same operationId.
  assert.equal(offscreenResponder.sessions.get(tabId).operationId, operationIdBefore, 'capture was not restarted');
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.saved, true);
  assert.equal(state.data.gainPercent, 155);
});

test('sync #13: a failed offscreen live propagation does not falsely update the popup display or the session cache', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageKey = 'https://sync-failed-propagation.example/';
  setTab(tabA, pageKey);
  setTab(tabB, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabA);
  await enableTab(tabB);

  offscreenResponder.setSetTabGainOverride((payload) => {
    if (payload.tabId === tabB) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure for tabB only' } };
    }
    const session = offscreenResponder.sessions.get(payload.tabId);
    session.gainPercent = payload.gainPercent;
    return { ok: true, data: { tabId: payload.tabId, gainPercent: payload.gainPercent } };
  });

  const response = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey, gainPercent: 240 }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true, 'the storage write itself still succeeds');
  assert.equal((await savedVolumes())[pageKey], 240);

  // tabA (confirmed) updated + broadcast; tabB (failed) neither.
  assert.equal(offscreenResponder.sessions.get(tabA).gainPercent, 240);
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 100, 'tabB offscreen gain unchanged');

  const stateB = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabB });
  assert.equal(stateB.data.gainPercent, 100, "tabB's cache/popup display was never falsely updated to 240");

  const falseB = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED).filter(
    (b) => b.payload.tabId === tabB && b.payload.gainPercent === 240
  );
  assert.equal(falseB.length, 0, 'no TAB_STATE_CHANGED claiming 240 was broadcast for the failed tab');

  const trueA = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED).filter(
    (b) => b.payload.tabId === tabA && b.payload.gainPercent === 240
  );
  assert.ok(trueA.length >= 1, 'the confirmed tab did get its TAB_STATE_CHANGED');

  offscreenResponder.setSetTabGainOverride(null);
});

// ===========================================================================
// Review round 2, fix #8: local gain state must never be updated before
// the offscreen document has confirmed a SET_TAB_GAIN actually applied -
// a failed, malformed, or stale response must leave the cache unchanged.
// ===========================================================================

test('r2fix8: a genuine offscreen SET_TAB_GAIN failure (correct operationId, offscreen still rejects) leaves the local cache unchanged', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://gain-fails.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  offscreenResponder.setSetTabGainOverride(() => ({
    ok: false,
    error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated offscreen SET_TAB_GAIN failure' },
  }));

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 199,
    expectedOperationId: data.operationId, // correct - the failure is purely on the offscreen side
  });
  assert.equal(response.ok, false);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 100); // untouched, never bumped to 199

  offscreenResponder.setSetTabGainOverride(null);
});

test('r2fix8: SET_TAB_GAIN with a malformed offscreen response (ok:true, but a different echoed gainPercent) leaves the local cache unchanged', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://gain-malformed.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  // The offscreen document claims success but echoes back a gainPercent
  // that does not match what was actually requested - never a positive
  // confirmation that the requested value was the one actually applied.
  offscreenResponder.setSetTabGainOverride((payload) => ({
    ok: true,
    data: { tabId: payload.tabId, gainPercent: payload.gainPercent + 1 },
  }));

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 120,
    expectedOperationId: offscreenResponder.sessions.get(tabId).operationId,
  });
  assert.equal(response.ok, false);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 100); // untouched, never bumped to 120

  offscreenResponder.setSetTabGainOverride(null);
});

test('r2fix8: a genuinely confirmed SET_TAB_GAIN response does update the local cache (positive/negative symmetry)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://gain-confirmed.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 120,
    expectedOperationId: data.operationId,
  });
  assert.equal(response.ok, true);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 120);
});

test('r2fix8: PERSIST_PAGE_VOLUME propagation to a second tab that fails to confirm leaves that tab\'s local cache unchanged, even though storage was already updated', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageKey = 'https://propagation-partial-fail.example/';
  setTab(tabA, pageKey);
  setTab(tabB, pageKey);
  await addAndAssertSaved(pageKey);
  const { data: dataA } = await enableTab(tabA);
  const { data: dataB } = await enableTab(tabB);

  offscreenResponder.setSetTabGainOverride((payload) => {
    if (payload.tabId === tabB) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure for tabB only' } };
    }
    const session = offscreenResponder.sessions.get(payload.tabId);
    session.gainPercent = payload.gainPercent;
    return { ok: true, data: { tabId: payload.tabId, gainPercent: payload.gainPercent } };
  });

  const response = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
    tabId: tabA,
    gainPercent: 155,
    expectedOperationId: dataA.operationId,
  });
  assert.equal(response.ok, true); // storage write itself succeeded regardless

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 155);
  assert.equal(offscreenResponder.sessions.get(tabA).gainPercent, 155); // confirmed, propagated
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 100); // NOT silently marked updated

  const stateB = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabB });
  assert.equal(stateB.data.gainPercent, 100);
  assert.ok(dataB.operationId);

  offscreenResponder.setSetTabGainOverride(null);
});

// ===========================================================================
// Fix #8 / review-round-2 fix #4: internal message-origin validation.
// Round 2 tightened this from "fail open on an absent sender.id/url" to
// genuinely fail-closed: sender.id is now always required (a missing one
// is rejected, not accepted), and every message type addressed to the
// service worker requires a *matching* sender.url too, since popup/options/
// offscreen are all real page/frame contexts where Chrome reliably
// supplies one - see validatePageContextSender's doc comment in
// shared/messages.js.
// ===========================================================================

test('fix8: a message whose sender.id does not match this extension is rejected', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://sender-check.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId }, { id: 'some-other-extension-id' });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('fix8/r2fix4: a message with no sender.id at all is now rejected (round 2 tightened this from fail-open to fail-closed)', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://no-sender-id.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId }, {});
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('r2fix4: a regular command with a valid sender.id but NO sender.url is rejected (no universal missing-url bypass)', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://no-sender-url.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId }, { id: FAKE_EXTENSION_ID });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('r2fix4: SESSION_STOPPED with a valid sender.id but NO sender.url is rejected', async () => {
  resetEverything();
  const response = await send(
    MESSAGE_TYPES.SESSION_STOPPED,
    { tabId: freshTabId(), operationId: 'op-x', reason: 'cleanup' },
    { id: FAKE_EXTENSION_ID }
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('fix8: SESSION_STOPPED claiming to come from a non-offscreen sender.url is rejected', async () => {
  resetEverything();
  const tabId = freshTabId();
  const response = await send(
    MESSAGE_TYPES.SESSION_STOPPED,
    { tabId, operationId: 'op-x', reason: 'cleanup' },
    { id: FAKE_EXTENSION_ID, url: `fake-extension://${FAKE_EXTENSION_ID}/popup/popup.html` }
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('fix8: SESSION_STOPPED from the genuine offscreen document sender.url is accepted', async () => {
  resetEverything();
  const tabId = freshTabId();
  const response = await send(
    MESSAGE_TYPES.SESSION_STOPPED,
    { tabId, operationId: 'op-x', reason: 'cleanup' },
    { id: FAKE_EXTENSION_ID, url: `fake-extension://${FAKE_EXTENSION_ID}/${OFFSCREEN_DOCUMENT_PATH}` }
  );
  assert.equal(response.ok, true);
});

test('fix8: a regular command claiming to come from the offscreen document sender.url is rejected', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://wrong-origin-command.example/');
  const response = await send(
    MESSAGE_TYPES.START_CAPTURE,
    startPayload(tabId),
    { id: FAKE_EXTENSION_ID, url: `fake-extension://${FAKE_EXTENSION_ID}/${OFFSCREEN_DOCUMENT_PATH}` }
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('fix8: a regular command from the popup sender.url is accepted', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://right-origin-command.example/');
  const response = await send(
    MESSAGE_TYPES.GET_TAB_STATE,
    { tabId },
    { id: FAKE_EXTENSION_ID, url: `fake-extension://${FAKE_EXTENSION_ID}/popup/popup.html` }
  );
  assert.equal(response.ok, true);
});

// ===========================================================================
// Review round 3, fix #1: ordinary reconciliation must escalate to the
// emergency fail-closed sweep whenever a required candidate teardown
// cannot be positively confirmed - never publish a partially-built cache
// while a candidate's offscreen graph might still be live.
// ===========================================================================

test('r3fix1: an orphaned candidate (no tab data, not reported as captured) whose STOP_CAPTURE returns ok:false fails the whole reconciliation and reaches closeDocument', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const staleTabId = freshTabId();
  const stalePageKey = 'https://orphaned-candidate.example/';
  // Simulates a session that existed before this service-worker instance's
  // cold start (from the offscreen document's own point of view), for a
  // tabId Chrome no longer reports as captured (no setTab, no
  // capturedTabsData entry) - reconciliation must tear it down. Note this
  // is deliberately NOT about whether the pageKey is saved - a session's
  // pageKey never needs to be saved to be a legitimate, reconstructable
  // temporary session (see the "temporary session reconciliation" tests
  // below); what makes this candidate orphaned is that Chrome's own
  // tabCapture status no longer confirms it.
  offscreenResponder.sessions.set(staleTabId, { operationId: 'stale-op', pageKey: stalePageKey, gainPercent: 100 });
  offscreenResponder.setStopCaptureOverride(() => ({
    ok: false,
    error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure' },
  }));

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://unrelated-trigger.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r3fix1: an orphaned candidate whose STOP_CAPTURE never resolves fails the whole reconciliation and reaches closeDocument', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const staleTabId = freshTabId();
  offscreenResponder.sessions.set(staleTabId, {
    operationId: 'stale-op',
    pageKey: 'https://orphaned-candidate-hang.example/',
    gainPercent: 100,
  });
  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {})); // never resolves

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://unrelated-trigger-2.example/');
  const responsePromise = send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });
  // reconcileState()'s own confirmedStopCapture attempt (1500ms) + the
  // emergency sweep's own per-candidate force:true attempt (another
  // 1500ms), both real wall-clock timeouts.
  await tick(500);

  const response = await responsePromise;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r3fix1: a malformed candidate (gainPercent out of the 0-300 range) is never scoped for a stop - the whole reconciliation fails immediately', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const malformedTabId = freshTabId();
  offscreenResponder.setGetActiveSessionsOverride(() => ({
    ok: true,
    data: {
      sessions: [{ tabId: malformedTabId, operationId: 'op-malformed', pageKey: 'https://malformed-gain.example/', gainPercent: 400 }],
      pending: [],
    },
  }));

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://unrelated-trigger-3.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);

  // The malformed candidate's tabId must never surface as active in a
  // later, successfully-reconciled state.
  offscreenResponder.setGetActiveSessionsOverride(null);
  offscreenDocumentCreated = false;
  const followUp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: malformedTabId });
  assert.equal(followUp.ok, true);
  assert.notEqual(followUp.data.state, 'active');
});

test('r3fix1: a URL-mismatched candidate whose STOP response is malformed fails the whole reconciliation', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const mismatchTabId = freshTabId();
  const pageKey = 'https://url-mismatch.example/';
  const destinationPageKey = 'https://url-mismatch-destination.example/';
  await addAndAssertSaved(pageKey);
  // The tab's CURRENT url (what getFrame/verifyTabMatchesPageKey observes)
  // differs from the session's recorded pageKey - reconciliation must
  // treat this as a mismatch requiring teardown.
  setTab(mismatchTabId, destinationPageKey);
  capturedTabsData = [{ tabId: mismatchTabId, status: 'active' }];
  offscreenResponder.sessions.set(mismatchTabId, { operationId: 'op-url-mismatch', pageKey, gainPercent: 100 });
  offscreenResponder.setStopCaptureOverride(() => ({ ok: true, data: {} })); // malformed - no tabId, no status

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://unrelated-trigger-4.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r3fix1: no partial reconciled cache is published - a genuinely valid candidate is not kept "active" when a sibling candidate fails to confirm', async () => {
  resetEverything();
  const tabGood = freshTabId();
  const tabBad = freshTabId();
  const pageGood = 'https://reconcile-good.example/';
  const pageBad = 'https://reconcile-bad.example/';
  setTab(tabGood, pageGood);
  // tabBad deliberately has no setTab/capturedTabsData entry - Chrome no
  // longer reports it as captured, so it is orphaned regardless of
  // whether pageBad happens to be saved (it deliberately is not, to also
  // prove savedPages membership plays no role in this decision either way).
  await addAndAssertSaved(pageGood);

  offscreenDocumentCreated = true;
  offscreenResponder.sessions.set(tabGood, { operationId: 'op-good', pageKey: pageGood, gainPercent: 100 });
  offscreenResponder.sessions.set(tabBad, { operationId: 'op-bad', pageKey: pageBad, gainPercent: 100 });
  capturedTabsData = [{ tabId: tabGood, status: 'active' }];

  offscreenResponder.setStopCaptureOverride((payload) => {
    if (payload.tabId === tabBad) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure for tabBad only' } };
    }
    return offscreenResponder.defaultStopCapture(payload);
  });

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabGood });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);

  // tabGood was otherwise entirely legitimate (saved, url-matching,
  // capture-status agreeing) - but because the whole reconciliation
  // attempt aborted, it must never have been published as active. The
  // unconditional emergency sweep (force:true) is what actually resolves
  // this - correctly treating every candidate as suspect, per this
  // codebase's documented "blunt instrument" emergency tradeoff - rather
  // than reconcileState() silently keeping tabGood "active" while
  // dropping tabBad.
  offscreenResponder.setStopCaptureOverride(null);
  offscreenDocumentCreated = false;
  const followUp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabGood });
  assert.equal(followUp.ok, true);
  assert.notEqual(followUp.data.state, 'active');
  assert.equal(offscreenResponder.sessions.has(tabGood), false);
});

// ===========================================================================
// Review round 3, fix #2: offscreen.js must register a real, cancellable
// PendingStart before the first await in handleStartCapture, so an
// operation-scoped STOP_CAPTURE arriving while getUserMedia() is still in
// flight finds something concrete to cancel, and a later "getUserMedia
// completed" resolution never creates a Session for an operation that was
// already cancelled.
// ===========================================================================

test('r3fix2: explicit Stop while only a PendingStart exists positively cancels it, and a later getUserMedia completion creates no Session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://pending-stop.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);

  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20); // let the PendingStart register at the offscreen layer
  assert.equal(offscreenResponder.pending.has(tabId), true);
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  const stopResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopResponse.ok, true);
  // Review round 4, fix #5: the cancelled entry is removed from
  // pendingStarts IMMEDIATELY by decideAndApplyStopCapture, not left
  // dangling until the original handleStartCapture's own `finally` block
  // eventually runs - this is what lets a retry for the same tab proceed
  // right away instead of being blocked by ALREADY_IN_PROGRESS for as long
  // as a hung getUserMedia() call takes to settle, if it ever does.
  assert.equal(offscreenResponder.pending.has(tabId), false, 'the cancelled entry is immediately absent from pendingStarts');

  release(); // "getUserMedia" finally resolves
  const startResult = await startPromise;
  assert.equal(startResult.ok, false);

  assert.equal(offscreenResponder.sessions.has(tabId), false, 'no late Session was created for a cancelled operation');
  assert.equal(offscreenResponder.pending.has(tabId), false, 'still absent - the finally block\'s identity check made it a safe no-op');

  offscreenResponder.setStartCaptureOverride(null);
});

test('fix5: a second START_CAPTURE for the same tab succeeds before the first (paused) getUserMedia resolves', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://retry-before-first-resolves.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);

  const firstStartPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);
  assert.equal(offscreenResponder.pending.has(tabId), true);

  const stopResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopResponse.ok, true);
  assert.equal(offscreenResponder.pending.has(tabId), false);

  // A brand new START_CAPTURE for the same tab must succeed immediately -
  // never rejected with ALREADY_IN_PROGRESS - even though the FIRST
  // getUserMedia() call (paused on `release`) has not resolved yet.
  offscreenResponder.setStartCaptureOverride(null); // the second attempt uses ordinary, unpaused default behavior
  const { data: newData } = await enableTab(tabId);
  assert.equal(offscreenResponder.sessions.get(tabId).operationId, newData.operationId);

  // Now the FIRST (old, cancelled) getUserMedia() finally resolves - it
  // must remain completely inert: no old Session is created, and the
  // newer, genuinely active session is left completely undisturbed.
  release();
  const firstResult = await firstStartPromise;
  assert.equal(firstResult.ok, false);
  await tick(20);

  assert.equal(offscreenResponder.sessions.has(tabId), true, 'the newer session is intact');
  assert.equal(offscreenResponder.sessions.get(tabId).operationId, newData.operationId, 'never overwritten by the stale first attempt');
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.operationId, newData.operationId);
});

test('r3fix2: navigation during a PendingStart also prevents a later Session from being created', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://pending-nav.example/';
  const destinationPageKey = 'https://pending-nav-destination.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);

  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);
  assert.equal(offscreenResponder.pending.has(tabId), true);

  setTab(tabId, destinationPageKey);
  await fireCommitted(tabId, destinationPageKey);
  await tick(20); // let the (fire-and-forget) navigation handler's teardown actually reach the offscreen layer

  // Review round 4, fix #5: removed from pendingStarts immediately, not
  // left dangling until the original handler resumes.
  assert.equal(offscreenResponder.pending.has(tabId), false);

  release();
  await startPromise;
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  assert.equal(offscreenResponder.pending.has(tabId), false);

  offscreenResponder.setStartCaptureOverride(null);
});

test('r3fix2: deleting the saved page (from the saved-pages view) during a PendingStart also prevents a later Session from being created', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://pending-remove.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);

  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);
  assert.equal(offscreenResponder.pending.has(tabId), true);

  const removeResponse = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(removeResponse.ok, true);

  release();
  await startPromise;
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  assert.equal(offscreenResponder.pending.has(tabId), false);

  offscreenResponder.setStartCaptureOverride(null);
});

test('r3fix2: emergency fail-closed cancels both a live Session and an in-flight PendingStart, leaving the offscreen Map itself empty', async () => {
  resetEverything();
  const activeTabId = freshTabId();
  const pendingTabId = freshTabId();
  setTab(activeTabId, 'https://emergency-active.example/');
  setTab(pendingTabId, 'https://emergency-pending.example/');
  await addAndAssertSaved('https://emergency-active.example/');
  await addAndAssertSaved('https://emergency-pending.example/');

  await enableTab(activeTabId);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);
  const pendingStartPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(pendingTabId));
  await tick(20);
  assert.equal(offscreenResponder.pending.has(pendingTabId), true);

  // ensureReconciled() only re-runs reconcileState() when reconciliationComplete
  // is false - both enableTab() and the pending START_CAPTURE above already
  // completed it. Force a fresh reconciliation attempt (simulating, e.g., a
  // prior total-failure retry opportunity) so the broken getCapturedTabs
  // below is actually reached - the offscreen document's own real state
  // (the live Session and the in-flight PendingStart) is untouched by this.
  sw.__resetForTests();

  const originalGetCapturedTabs = globalThis.chrome.tabCapture.getCapturedTabs;
  globalThis.chrome.tabCapture.getCapturedTabs = async () => {
    throw new Error('simulated tabCapture failure');
  };

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: activeTabId });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);

  assert.equal(offscreenResponder.sessions.size, 0);
  // Review round 4, fix #5: the emergency sweep's force:true cancellation
  // has the same immediate-removal property as an ordinary cancellation -
  // the pending Map itself is already empty, before `release()` ever lets
  // the original handler resume.
  assert.equal(offscreenResponder.pending.size, 0, 'immediately removed by the emergency sweep, not left dangling');

  globalThis.chrome.tabCapture.getCapturedTabs = originalGetCapturedTabs;
  release();
  await pendingStartPromise;

  assert.equal(offscreenResponder.pending.size, 0, 'the offscreen Map itself is empty, not only the service worker cache');
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStartCaptureOverride(null);
});

// ===========================================================================
// Review round 3, fix #3: STOP_CAPTURE's response must explicitly prove
// what happened (status: 'stopped'|'pending_cancelled'|'absent'|
// 'operation_mismatch') - an operation_mismatch is never confirmation, and
// must never cause the service worker to believe a tab is inactive while a
// genuinely different, newer operation remains live on that tabId.
// ===========================================================================

test('r3fix3: the fake offscreen responder mirrors the real contract - stop-operationId mismatch reports operation_mismatch, not a positive stop', async () => {
  resetEverything();
  const tabId = freshTabId();
  offscreenResponder.sessions.set(tabId, { operationId: 'op-real', pageKey: 'https://mismatch-direct.example/', gainPercent: 100 });

  const response = await offscreenResponder.handle({
    type: MESSAGE_TYPES.STOP_CAPTURE,
    payload: { tabId, operationId: 'op-stale', force: false },
  });

  assert.equal(response.ok, true);
  assert.equal(response.data.status, 'operation_mismatch');
  assert.equal(response.data.currentOperationId, 'op-real');
  assert.equal(response.data.stoppedOperationId, null);
  assert.equal(offscreenResponder.sessions.has(tabId), true, 'untouched by the mismatched request');
});

test('r3fix3: exact active-operation stop reports status "stopped"', async () => {
  resetEverything();
  const tabId = freshTabId();
  offscreenResponder.sessions.set(tabId, { operationId: 'op-exact', pageKey: 'https://exact-stop.example/', gainPercent: 100 });

  const response = await offscreenResponder.handle({
    type: MESSAGE_TYPES.STOP_CAPTURE,
    payload: { tabId, operationId: 'op-exact', force: false },
  });

  assert.equal(response.data.status, 'stopped');
  assert.equal(response.data.stoppedOperationId, 'op-exact');
  assert.equal(offscreenResponder.sessions.has(tabId), false);
});

test('r3fix3: exact pending-operation stop reports status "pending_cancelled"', async () => {
  resetEverything();
  const tabId = freshTabId();
  offscreenResponder.pending.set(tabId, { tabId, operationId: 'op-pending', cancelled: false });

  const response = await offscreenResponder.handle({
    type: MESSAGE_TYPES.STOP_CAPTURE,
    payload: { tabId, operationId: 'op-pending', force: false },
  });

  assert.equal(response.data.status, 'pending_cancelled');
  assert.equal(response.data.stoppedOperationId, 'op-pending');
  // Review round 4, fix #5: cancellation removes the entry immediately -
  // it is not left behind with merely `.cancelled = true` set on it.
  assert.equal(offscreenResponder.pending.has(tabId), false);
});

test('r3fix3: stopping a tab with no active or pending operation reports status "absent"', async () => {
  resetEverything();
  const tabId = freshTabId();

  const response = await offscreenResponder.handle({
    type: MESSAGE_TYPES.STOP_CAPTURE,
    payload: { tabId, operationId: 'op-anything', force: false },
  });

  assert.equal(response.data.status, 'absent');
  assert.equal(response.data.stoppedOperationId, null);
});

test('r3fix3: an operation_mismatch never causes the service worker to report inactive while the different operation remains live', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://sw-mismatch-reconcile.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  // Directly inject a divergence between what the service worker's cache
  // believes (operationId from `data`) and what the offscreen document
  // actually holds for this tabId - representing a genuine, otherwise
  // undetected state mismatch, independent of how it arose.
  const realSession = offscreenResponder.sessions.get(tabId);
  realSession.operationId = 'op-divergent';
  capturedTabsData = [{ tabId, status: 'active' }];

  const disableResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  // The stale, mismatched Stop itself is reported as a failure...
  assert.equal(disableResponse.ok, false);

  // ...but the genuinely live session (now correctly re-adopted by
  // reconciliation under its real operationId) must never be reported
  // inactive, and the cache must never have simply been deleted outright.
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.operationId, 'op-divergent');
  assert.equal(offscreenResponder.sessions.has(tabId), true);
});

// ===========================================================================
// Review round 3, fix #4: reconcileState()'s initial GET_ACTIVE_SESSIONS
// request must itself be time-bounded - a listener that returns `true` but
// never calls sendResponse must not hang every state-sensitive
// command/listener forever.
// ===========================================================================

test('r3fix4: the very first (ordinary) GET_ACTIVE_SESSIONS call is time-bounded and reaches emergency cleanup if it never resolves', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  offscreenResponder.setGetActiveSessionsOverride(() => new Promise(() => {})); // hangs on every call, ordinary and emergency alike

  const tabId = freshTabId();
  setTab(tabId, 'https://initial-hang.example/');
  await addAndAssertSaved('https://initial-hang.example/');

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('r3fix4: a navigation listener does not remain pending forever when the initial GET_ACTIVE_SESSIONS never resolves', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  offscreenResponder.setGetActiveSessionsOverride(() => new Promise(() => {}));

  const tabId = freshTabId();
  const pageKey = 'https://nav-initial-hang.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  await fireCommitted(tabId, pageKey); // fire-and-forget - must still resolve internally within bounded time
  // Two chained 1500ms timeouts (ordinary reconcile's own GET_ACTIVE_SESSIONS,
  // then the emergency sweep's own) - a generous margin beyond the 3000ms
  // minimum, since this is a fire-and-forget listener with no direct
  // response promise to await instead.
  await tick(500); // two chained offscreen timeouts (60ms each) + a wide margin

  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setGetActiveSessionsOverride(null);
  offscreenDocumentCreated = false;
  const followUp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(followUp.ok, true, 'the service worker recovered and can serve a fresh request, not permanently wedged');
});

test('r3fix4: a late initial GET_ACTIVE_SESSIONS response, arriving after its own timeout, cannot publish a stale cache', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const tabId = freshTabId();
  const pageKey = 'https://late-initial-enum.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
  let callCount = 0;
  offscreenResponder.setGetActiveSessionsOverride(async () => {
    callCount += 1;
    if (callCount === 1) {
      await gate; // the FIRST (ordinary reconcile) call is delayed past its own timeout
      // Claims a live, matching session - if this were ever adopted, it
      // would wrongly mark the tab active.
      return { ok: true, data: { sessions: [{ tabId, operationId: 'late-op', pageKey, gainPercent: 100 }], pending: [] } };
    }
    return { ok: true, data: { sessions: [], pending: [] } }; // emergency's own call resolves cleanly
  });

  const responsePromise = send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  // Past the 1500ms timeout - reconcileState() has already thrown. A
  // generous margin beyond the theoretical minimum, since a real
  // setTimeout-based wait needs headroom under load, not just the exact
  // sum (matches the margin used by other single-chained-timeout tests).
  await tick(400);
  releaseGate();
  const response = await responsePromise;

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);

  offscreenResponder.setGetActiveSessionsOverride(null);
  offscreenDocumentCreated = false;
  const followUp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(followUp.ok, true);
  assert.notEqual(followUp.data.state, 'active', "the late response's claim was never adopted");
});

// ===========================================================================
// Review round 3, fix #6: message-type-specific sender matrix - a
// popup-only command must be rejected from the options sender and vice
// versa, not merely accepted from "either."
// ===========================================================================

test('r3fix6: a popup-only command (START_CAPTURE) sent with the options sender is rejected', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://popup-only-from-options.example/');
  const response = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId), OPTIONS_TEST_SENDER);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('r3fix6: an options-only command (GET_SAVED_PAGES) sent with the popup sender is rejected', async () => {
  resetEverything();
  const response = await send(MESSAGE_TYPES.GET_SAVED_PAGES, {}, DEFAULT_TEST_SENDER);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test("r3fix6: a popup-only command (ADD_PAGE_MANUAL, the 'Add URL manually' modal) sent with the options sender is rejected, but succeeds from the popup", async () => {
  resetEverything();
  const optionsAttempt = await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: 'https://manual-add.example/' }, OPTIONS_TEST_SENDER);
  assert.equal(optionsAttempt.ok, false);
  assert.equal(optionsAttempt.error.code, ERROR_CODES.INVALID_MESSAGE);

  const popupAttempt = await send(
    MESSAGE_TYPES.ADD_PAGE_MANUAL,
    { rawUrl: 'https://manual-add.example/' },
    DEFAULT_TEST_SENDER
  );
  assert.equal(popupAttempt.ok, true);
});

test('a popup-only command (UPDATE_SAVED_PAGE_VOLUME is options-only, not popup) sent with the popup sender is rejected, but succeeds from options', async () => {
  resetEverything();
  await addAndAssertSaved('https://update-volume-sender.example/');
  const popupAttempt = await send(
    MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    { pageKey: 'https://update-volume-sender.example/', gainPercent: 50 },
    DEFAULT_TEST_SENDER
  );
  assert.equal(popupAttempt.ok, false);
  assert.equal(popupAttempt.error.code, ERROR_CODES.INVALID_MESSAGE);

  const optionsAttempt = await send(
    MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME,
    { pageKey: 'https://update-volume-sender.example/', gainPercent: 50 },
    OPTIONS_TEST_SENDER
  );
  assert.equal(optionsAttempt.ok, true);
});

// ===========================================================================
// Review round 4, fix #1: payload validation must be target-aware. Every
// message dispatched to TARGETS.OFFSCREEN in this file now passes through
// the REAL registerMessageHandler/validateMessage path (see the offscreen
// listener registration near the top of this file) - these tests make that
// coverage explicit, and prove the exact bug described in the review: the
// real service-worker -> offscreen SET_TAB_GAIN payload (operationId) must
// be accepted, and the popup -> service-worker shape (expectedOperationId)
// must be rejected at the offscreen target, not silently tolerated.
// ===========================================================================

test('r4fix1: a real, fully routed SET_TAB_GAIN reaches the fake offscreen responder through registerMessageHandler and changes its live session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix1-routed-gain.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  // Dispatched through the real chrome.runtime.onMessage listener chain
  // (dispatch() -> the registerMessageHandler-registered offscreen listener
  // -> real validateMessage()) - not a direct call to offscreenResponder.handle().
  const response = await dispatch({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.SET_TAB_GAIN,
    requestId: 'r4fix1-direct',
    payload: { tabId, gainPercent: 133, operationId: data.operationId },
  });
  assert.equal(response.ok, true, `expected the real offscreen SET_TAB_GAIN payload to validate and apply: ${JSON.stringify(response)}`);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 133, "the fake offscreen responder's live session was genuinely mutated");
});

test('r4fix1: the popup-shaped SET_TAB_GAIN payload (expectedOperationId) is rejected by the real offscreen listener, not silently accepted', async () => {
  resetEverything();
  const tabId = freshTabId();
  const response = await dispatch({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.SET_TAB_GAIN,
    requestId: 'r4fix1-wrong-shape',
    payload: { tabId, gainPercent: 133, expectedOperationId: 'op-x' },
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('r4fix1: the offscreen-shaped SET_TAB_GAIN payload (operationId) is rejected when addressed to the service worker', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://r4fix1-sw-wrong-shape.example/');
  const response = await dispatch(
    { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.SET_TAB_GAIN, requestId: 'r4fix1-sw-wrong-shape', payload: { tabId, gainPercent: 133, operationId: 'op-x' } },
    DEFAULT_TEST_SENDER
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
});

test('r4fix1: live gain slider (SET_TAB_GAIN via the service worker) genuinely propagates to a live session end-to-end', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix1-e2e-slider.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 77, expectedOperationId: data.operationId });
  assert.equal(response.ok, true, `expected live gain slider to succeed end-to-end: ${JSON.stringify(response)}`);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 77);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 77);
});

test('r4fix1: Reset (SET_TAB_GAIN + PERSIST_PAGE_VOLUME back to 100) works end-to-end through the real target-aware validation path', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix1-reset.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 180, expectedOperationId: data.operationId });
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 180);

  const resetGain = await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 100, expectedOperationId: data.operationId });
  assert.equal(resetGain.ok, true);
  const resetPersist = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId, gainPercent: 100, expectedOperationId: data.operationId });
  assert.equal(resetPersist.ok, true);

  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 100);
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 100);
});

test('r5-3: START_CAPTURE binds the popup-supplied initialGainPercent as the session\'s starting gain (the popup sends the displayed saved value on Enable)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://start-capture-initial-gain.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 150);

  // The popup, having displayed the saved 150% while inactive, supplies 150
  // as initialGainPercent when the user clicks Enable. The service worker
  // no longer re-derives the starting gain from savedPages itself - it binds
  // exactly the value the popup sent.
  const result = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));
  assert.equal(result.ok, true, `expected START_CAPTURE to succeed: ${JSON.stringify(result)}`);
  assert.equal(result.data.state, 'active');
  assert.equal(
    offscreenResponder.sessions.get(tabId).gainPercent,
    150,
    'the popup-supplied 150% was bound as the starting gain, applied through the real START_CAPTURE path'
  );

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 150);
});

test('r5-3: START_CAPTURE binds an arbitrary popup-supplied initialGainPercent (a slider-triggered start on an unsaved page)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://start-capture-slider-value.example/';
  setTab(tabId, pageKey);

  // Unsaved page, slider dragged to 175 -> the popup sends 175 as the
  // initial gain, and the offscreen session must begin at exactly 175.
  const result = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 175));
  assert.equal(result.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 175, 'the offscreen START_CAPTURE payload received the correct initial gain');
});

test('r4fix1: same-page multi-tab propagation (PERSIST_PAGE_VOLUME) genuinely applies to every sharing tab through the real offscreen validation path', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageKey = 'https://r4fix1-multi-tab.example/';
  setTab(tabA, pageKey);
  setTab(tabB, pageKey);
  await addAndAssertSaved(pageKey);
  const { data: dataA } = await enableTab(tabA);
  await enableTab(tabB);

  const response = await send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId: tabA, gainPercent: 60, expectedOperationId: dataA.operationId });
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabA).gainPercent, 60);
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 60);
});

// ===========================================================================
// Review round 4, fix #2: ordinary (non-emergency) reconciliation must
// process data.pending, not just data.sessions - a PendingStart left over
// from a previous/unknown service-worker continuation must be positively
// cancelled before reconciliationComplete may become true, and must never
// be adopted as an active session.
// ===========================================================================

test('r4fix2: cold-start reconciliation with one PendingStart cancels it before completing, and a later getUserMedia resolution creates no Session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix2-cold-start-pending.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  // Registers a genuine, cancellable PendingStart directly at the offscreen
  // layer - representing an operation already in flight there from a
  // PREVIOUS service-worker instance, before this (freshly reset)
  // instance's own cold start. This service worker's own cache knows
  // nothing about it.
  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);
  const rawStartPromise = dispatch({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.START_CAPTURE,
    requestId: 'r4fix2-raw-start',
    payload: { tabId, streamId: `stream-for-${tabId}`, operationId: 'op-cold-start-pending', pageKey, gainPercent: 100 },
  });
  await tick(20);
  assert.equal(offscreenResponder.pending.has(tabId), true);
  offscreenDocumentCreated = true; // this SW instance cold-starts into an already-existing offscreen document

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://r4fix2-cold-start-trigger.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });
  assert.equal(response.ok, true, `expected ordinary reconciliation to succeed: ${JSON.stringify(response)}`);

  // Cancelled before reconciliation completed - immediately absent, and
  // never adopted as active.
  assert.equal(offscreenResponder.pending.has(tabId), false);
  const pendingTabState = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(pendingTabState.data.state, 'active');

  // The abandoned "getUserMedia" call finally resolves - it must create no
  // Session, since offscreen.js's own PendingStart-cancellation check
  // refuses to adopt an operation it already marked cancelled.
  release();
  await tick(20);
  const startResult = await rawStartPromise;
  assert.equal(startResult.ok, false);
  assert.equal(offscreenResponder.sessions.has(tabId), false);

  offscreenResponder.setStartCaptureOverride(null);
});

test('r4fix2: a PendingStart that becomes an active Session between enumeration and the reconciliation Stop is still stopped', async () => {
  resetEverything();
  const pendingTabId = freshTabId();
  const pageKey = 'https://r4fix2-race-become-active.example/';
  offscreenDocumentCreated = true;

  const operationId = 'op-race-become-active';
  offscreenResponder.pending.set(pendingTabId, { tabId: pendingTabId, operationId, cancelled: false });

  // Constructs the exact race the spec describes deterministically: by the
  // time reconciliation's own operation-scoped STOP_CAPTURE for this
  // candidate arrives, the PendingStart has already completed and become a
  // real Session - promoted here right when the STOP_CAPTURE override is
  // invoked, then delegated to the same real decideAndApplyStopCapture-
  // backed default logic, which correctly reports 'stopped' for a genuine
  // Session match.
  offscreenResponder.setStopCaptureOverride((payload) => {
    if (payload.tabId === pendingTabId && offscreenResponder.pending.has(pendingTabId)) {
      offscreenResponder.pending.delete(pendingTabId);
      offscreenResponder.sessions.set(pendingTabId, { operationId, pageKey, gainPercent: 100 });
    }
    return offscreenResponder.defaultStopCapture(payload);
  });

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://r4fix2-trigger.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });

  assert.equal(response.ok, true, `expected reconciliation to succeed via the 'stopped' outcome: ${JSON.stringify(response)}`);
  assert.equal(offscreenResponder.sessions.has(pendingTabId), false, 'the just-promoted Session was torn down by the same Stop');
  assert.equal(offscreenResponder.pending.has(pendingTabId), false);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix2: a malformed pending candidate (invalid tabId) enters emergency fail-closed', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  offscreenResponder.setGetActiveSessionsOverride(() => ({
    ok: true,
    data: { sessions: [], pending: [{ tabId: -1, operationId: 'op-bad' }] },
  }));

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://r4fix2-malformed-pending.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('r4fix2: a malformed pending candidate (empty operationId) enters emergency fail-closed', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const tabId = freshTabId();
  offscreenResponder.setGetActiveSessionsOverride(() => ({
    ok: true,
    data: { sessions: [], pending: [{ tabId, operationId: '' }] },
  }));

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://r4fix2-malformed-pending-op.example/');
  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setGetActiveSessionsOverride(null);
});

test('r4fix2: a pending candidate whose cancellation STOP_CAPTURE never resolves enters emergency fail-closed', async () => {
  resetEverything();
  offscreenDocumentCreated = true;
  const pendingTabId = freshTabId();
  offscreenResponder.pending.set(pendingTabId, { tabId: pendingTabId, operationId: 'op-hung-cancel', cancelled: false });
  offscreenResponder.setStopCaptureOverride(() => new Promise(() => {})); // never resolves

  const triggerTabId = freshTabId();
  setTab(triggerTabId, 'https://r4fix2-hung-cancel-trigger.example/');
  const responsePromise = send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: triggerTabId });
  // reconcileState()'s own confirmedStopCapture attempt for the pending
  // candidate (1500ms) + the emergency sweep's own per-candidate force:true
  // attempt (another 1500ms), both real wall-clock timeouts, plus margin.
  await tick(500); // two chained offscreen timeouts (60ms each) + a wide margin

  const response = await responsePromise;
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);
  // The override hangs unconditionally (both the ordinary and the
  // emergency force:true attempt), so the fake's own pending Map is never
  // actually cancelled here - closeDocument() is the guarantee this
  // codebase makes instead: nothing is left running unaccounted for, but
  // it does so at the offscreen-DOCUMENT level, not by individually
  // resolving every hung candidate.
  assert.equal(offscreenResponder.pending.has(pendingTabId), true, 'never cancelled - the override hangs forever regardless of force');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix2: no partial cache is published - a genuinely valid session candidate is not kept active when a sibling pending candidate cannot be confirmed cancelled', async () => {
  resetEverything();
  const tabGood = freshTabId();
  const pendingTabId = freshTabId();
  const pageGood = 'https://r4fix2-partial-good.example/';
  setTab(tabGood, pageGood);
  await addAndAssertSaved(pageGood);

  offscreenDocumentCreated = true;
  offscreenResponder.sessions.set(tabGood, { operationId: 'op-good', pageKey: pageGood, gainPercent: 100 });
  capturedTabsData = [{ tabId: tabGood, status: 'active' }];
  offscreenResponder.pending.set(pendingTabId, { tabId: pendingTabId, operationId: 'op-pending-bad', cancelled: false });
  offscreenResponder.setStopCaptureOverride((payload) => {
    if (payload.tabId === pendingTabId) {
      return { ok: false, error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure cancelling the pending candidate' } };
    }
    return offscreenResponder.defaultStopCapture(payload);
  });

  const response = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabGood });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.RECONCILIATION_FAILED);
  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setStopCaptureOverride(null);
  offscreenDocumentCreated = false;
  const followUp = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: tabGood });
  assert.equal(followUp.ok, true);
  assert.notEqual(followUp.data.state, 'active', 'tabGood was never published as active despite being otherwise legitimate');
  assert.equal(offscreenResponder.sessions.has(tabGood), false, 'closeDocument() unconditionally clears the fake sessions Map');
  // The override unconditionally rejects STOP_CAPTURE for pendingTabId
  // (both the ordinary force:false attempt and the emergency force:true
  // retry), so it is never actually cancelled at the offscreen layer - the
  // guarantee this test proves is that tabGood's cache was never published
  // as partial, not that every hung candidate resolves.
  assert.equal(offscreenResponder.pending.has(pendingTabId), true, 'never cancelled - the override unconditionally rejects it');
});

// ===========================================================================
// Review round 4, fix #3: confirmedStopCapture must strictly validate every
// field of a STOP_CAPTURE response against the exact request it answers -
// a response with a merely plausible-looking status string, but internally
// inconsistent fields, must never be treated as confirmation.
// ===========================================================================

test('r4fix3: exact active-operation stop is confirmed and clears the local cache entry', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-exact-stop.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, true);
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
});

test('r4fix3: exact PendingStart cancellation is confirmed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-exact-pending-cancel.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);

  const stopResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopResponse.ok, true);

  release();
  await startPromise;
  offscreenResponder.setStartCaptureOverride(null);
});

test('r4fix3: a genuinely absent response (nothing to stop) is confirmed', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://r4fix3-absent.example/');
  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, true);
  assert.equal(response.data.state, 'inactive');
});

test('r4fix3: a valid operation_mismatch is never treated as confirmation - escalates instead of claiming inactive', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-valid-mismatch.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  // Genuinely correct, internally-consistent operation_mismatch shape -
  // still must never be confirmed.
  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: payload.operationId ?? null,
      status: 'operation_mismatch',
      stoppedOperationId: null,
      currentOperationId: 'some-other-live-operation-id',
    },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix3: status "stopped" with the wrong requestedOperationId is rejected as malformed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-wrong-requested.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: 'wrong-requested-id', // does not echo the real request
      status: 'stopped',
      stoppedOperationId: payload.operationId,
      currentOperationId: null,
    },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false, 'a malformed response must never be treated as a confirmed stop');
  assert.equal(closeDocumentCallCount, 1, 'escalated to the emergency sweep instead');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix3: status "stopped" with the wrong stoppedOperationId is rejected as malformed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-wrong-stopped.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: payload.operationId ?? null,
      status: 'stopped',
      // null (not merely "a different but present string") so this stays
      // invalid even under the emergency sweep's own force:true retry,
      // where a *present*, non-empty stoppedOperationId that legitimately
      // differs from the request is spec-defined as acceptable (force
      // bypasses exact matching) - a MISSING one is never acceptable,
      // force or not, since it fails to prove anything was actually
      // stopped at all.
      stoppedOperationId: null,
      currentOperationId: null,
    },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1);

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix3: status "absent" with a non-null currentOperationId is rejected as malformed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-absent-nonnull.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: payload.operationId ?? null,
      status: 'absent',
      stoppedOperationId: null,
      currentOperationId: 'unexpectedly-live-operation-id',
    },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false, 'a session genuinely exists in the SW cache, so a bare {state:"inactive"} short-circuit does not apply here');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix3: a malformed response never deletes the SW cache on its own - only the emergency sweep does', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-malformed-preserves-cache.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);

  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: 'wrong-request',
      status: 'stopped',
      stoppedOperationId: 'wrong-operation',
      currentOperationId: offscreenResponder.sessions.get(tabId)?.operationId ?? null,
    },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false);
  assert.equal(closeDocumentCallCount, 1, 'the emergency sweep - not the malformed response itself - is what tore it down');
  assert.equal(offscreenResponder.sessions.size, 0, 'the emergency sweep force-stopped it - no hidden graph left running');

  offscreenResponder.setStopCaptureOverride(null);
});

test('r4fix3: a malformed response with a genuinely live fake offscreen Session escalates and leaves no hidden graph', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix3-malformed-live-session.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  await enableTab(tabId);
  assert.equal(offscreenResponder.sessions.has(tabId), true);

  // A textbook "malformed spec example" response: superficially ok:true and
  // status:'stopped', but every scoping field is wrong.
  offscreenResponder.setStopCaptureOverride((payload) => ({
    ok: true,
    data: {
      tabId: payload.tabId,
      requestedOperationId: 'wrong-request',
      status: 'stopped',
      stoppedOperationId: 'wrong-operation',
      currentOperationId: offscreenResponder.sessions.get(tabId)?.operationId ?? null,
    },
  }));

  const response = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(response.ok, false);

  assert.equal(closeDocumentCallCount, 1);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  assert.equal(offscreenResponder.sessions.size, 0);

  offscreenResponder.setStopCaptureOverride(null);
});

// ===========================================================================
// Review round 4, fix #4: a precondition that becomes false while
// chrome.storage.local.set() (not .get()) is genuinely in flight must be
// re-checked after the write resolves too, and compensated for - these
// tests use pauseStorageSet(). ADD_CURRENT_PAGE itself has no such
// precondition-recheck dance (see the product-model correction section
// above) - the test below documents and proves exactly why that is safe.
// ===========================================================================

test('ADD_CURRENT_PAGE completes normally even if navigation happens while its storage.set is still in flight - no compensation is needed, since the save was not tied to any cancellable operation', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://add-current-set-in-flight.example/';
  const otherPageKey = 'https://add-current-set-in-flight-dest.example/';
  setTab(tabId, pageKey);

  const releaseSet = pauseStorageSet();
  const addPromise = send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 130 });
  await tick(30); // let it pass the expectedPageKey check and reach the paused storage.set

  setTab(tabId, otherPageKey);
  await fireCommitted(tabId, otherPageKey);
  await tick(30); // let the real (unpaused) offscreen teardown for the navigation actually finish

  releaseSet();
  const result = await addPromise;
  assert.equal(
    result.ok,
    true,
    'the page was legitimately being saved at the moment the expectedPageKey check passed - a later navigation does not retroactively invalidate it'
  );

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 130);
  assert.equal(otherPageKey in pages, false);
});

test('PERSIST_PAGE_VOLUME invalidated by Stop while storage.set is awaiting restores the previous volume', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://r4fix4-compensate-persist.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);
  const { data } = await enableTab(tabId);

  const releaseSet = pauseStorageSet();
  const persistPromise = send(MESSAGE_TYPES.PERSIST_PAGE_VOLUME, { tabId, gainPercent: 170, expectedOperationId: data.operationId });
  await tick(30); // let it reach persistExistingVolumeIfPreconditionHolds's paused storage.set

  const stopResponse = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopResponse.ok, true);

  releaseSet();
  const persistResult = await persistPromise;
  assert.equal(persistResult.ok, false);

  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 100, 'restored to the previous value, never left stale at 170');
});

// ===========================================================================
// Review round 4, fix #5: a cancelled PendingStart must not block retries.
// (The immediate-removal property itself is exercised throughout the r3fix2
// section above, which was updated to assert it - these add the remaining
// required coverage: the raw offscreen "pending_cancelled" status, and a
// second START_CAPTURE succeeding before the first getUserMedia settles is
// covered by the "fix5: a second START_CAPTURE..." test earlier in this file.)
// ===========================================================================

test('fix5: Stop against a genuine offscreen PendingStart reports status "pending_cancelled" via the real routed path', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://fix5-pending-cancelled-status.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey);

  const { override, release } = createControllablePendingStart();
  offscreenResponder.setStartCaptureOverride(override);
  const startPromise = send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId));
  await tick(20);
  assert.equal(offscreenResponder.pending.has(tabId), true);

  const pendingEntry = offscreenResponder.pending.get(tabId);
  const rawStop = await dispatch({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.STOP_CAPTURE,
    requestId: 'fix5-raw-stop',
    payload: { tabId, operationId: pendingEntry.operationId, force: false },
  });
  assert.equal(rawStop.ok, true);
  assert.equal(rawStop.data.status, 'pending_cancelled');
  assert.equal(offscreenResponder.pending.has(tabId), false, 'immediately absent');

  release();
  await startPromise;
  offscreenResponder.setStartCaptureOverride(null);
});

// ===========================================================================
// v0.1.3: exact-page-scoped two-way LIVE saved-page slider synchronization.
//
//  - Saved-pages row slider drag (SET_SAVED_PAGE_LIVE_GAIN, options-only)
//    changes any active session sharing the identical exact pageKey, live,
//    with NO storage write and NO capture start; a confirmed change also
//    broadcasts TAB_STATE_CHANGED so an open popup follows in real time.
//  - Popup slider drag (SET_TAB_GAIN) additionally broadcasts
//    SAVED_PAGE_LIVE_GAIN_CHANGED to OPTIONS so an open Saved-pages row
//    follows in real time.
//  - Both are exact-pageKey-scoped; a different path/query/fragment/host is
//    never touched. A failed/stale offscreen update updates nothing.
// ===========================================================================

test('livesync#1: SET_SAVED_PAGE_LIVE_GAIN at 209% changes a matching active offscreen session to 209 (2.09)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-209.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  const resp = await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: 209 }, OPTIONS_TEST_SENDER);
  assert.equal(resp.ok, true, `expected live gain to succeed: ${JSON.stringify(resp)}`);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 209, 'the active offscreen session moved to 209 (2.09)');
});

test('livesync#2: the matching popup receives TAB_STATE_CHANGED showing 209%', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-popup-follows.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  capturedBroadcasts.length = 0;
  await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: 209 }, OPTIONS_TEST_SENDER);

  const stateBroadcasts = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED);
  assert.ok(stateBroadcasts.length >= 1, 'a TAB_STATE_CHANGED was broadcast to the popup');
  const last = stateBroadcasts[stateBroadcasts.length - 1];
  assert.equal(last.payload.tabId, tabId);
  assert.equal(last.payload.gainPercent, 209, 'the popup broadcast carries the new 209% live gain');
});

test('livesync#3: rapid SET_SAVED_PAGE_LIVE_GAIN 150 -> 180 -> 240 leaves the session at 240%', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-rapid.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  for (const value of [150, 180, 240]) {
    await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: value }, OPTIONS_TEST_SENDER);
  }
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 240, 'the final live value 240 wins');
});

test('livesync#4: SET_SAVED_PAGE_LIVE_GAIN writes nothing to storage (the saved default is untouched)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-no-write.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: 175 }, OPTIONS_TEST_SENDER);
  const pages = await savedVolumes();
  assert.equal(pages[pageKey], 100, 'the stored default stays 100 - a live drag never persists');
});

test('livesync#5: UPDATE_SAVED_PAGE_VOLUME (the change commit) persists exactly the final value', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-commit.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  // Several live drags first (persist nothing), then one commit.
  for (const value of [150, 180, 240]) {
    await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: value }, OPTIONS_TEST_SENDER);
  }
  assert.equal((await savedVolumes())[pageKey], 100, 'still unpersisted while dragging');

  const commit = await send(MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, { pageKey, gainPercent: 240 }, OPTIONS_TEST_SENDER);
  assert.equal(commit.ok, true);
  assert.equal((await savedVolumes())[pageKey], 240, 'only the final committed value is persisted');
});

test('livesync#6: SET_SAVED_PAGE_LIVE_GAIN never starts capture on an inactive saved page', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-inactive.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);

  const resp = await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: 200 }, OPTIONS_TEST_SENDER);
  assert.equal(resp.ok, true, 'a no-op live drag with no active session still resolves ok');
  assert.equal(offscreenResponder.sessions.has(tabId), false, 'no capture was started');
});

test('livesync#7: a different exact pageKey on the same hostname is untouched', async () => {
  resetEverything();
  const host = 'https://same-host.example';
  const pageA = `${host}/a`;
  const pageB = `${host}/b`;
  const tabA = freshTabId();
  const tabB = freshTabId();
  setTab(tabA, pageA);
  setTab(tabB, pageB);
  await addAndAssertSaved(pageA, 100);
  await addAndAssertSaved(pageB, 100);
  await enableTab(tabA);
  await enableTab(tabB);

  await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey: pageA, gainPercent: 250 }, OPTIONS_TEST_SENDER);
  assert.equal(offscreenResponder.sessions.get(tabA).gainPercent, 250, 'the exact page moved');
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 100, 'the same-host different-path page is untouched');
});

test('livesync#8: popup SET_TAB_GAIN broadcasts SAVED_PAGE_LIVE_GAIN_CHANGED to the options view', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-popup-to-options.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  const { data } = await enableTab(tabId);

  capturedBroadcasts.length = 0;
  const resp = await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 188, expectedOperationId: data.operationId });
  assert.equal(resp.ok, true);

  const optionBroadcasts = broadcastsTo(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED);
  assert.equal(optionBroadcasts.length, 1, 'exactly one live-gain notice to the options view');
  assert.equal(optionBroadcasts[0].payload.pageKey, pageKey);
  assert.equal(optionBroadcasts[0].payload.gainPercent, 188);
});

test('livesync#9: popup SET_TAB_GAIN on an UNSAVED page creates no saved entry (options has no matching row)', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-unsaved.example/';
  setTab(tabId, pageKey);
  const { data } = await enableTab(tabId); // unsaved temporary session

  const resp = await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 150, expectedOperationId: data.operationId });
  assert.equal(resp.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 150, 'the live gain still applied to the temporary session');
  assert.deepEqual(await savedVolumes(), {}, 'no saved entry was created for the unsaved page');
});

test('livesync#10: a FAILED offscreen live update updates neither the SW cache nor the popup', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-fail.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  await enableTab(tabId);

  // The offscreen SET_TAB_GAIN fails - propagation must not falsely update.
  offscreenResponder.setSetTabGainOverride(() => ({ ok: false, error: { code: ERROR_CODES.NOT_ACTIVE, message: 'simulated' } }));
  capturedBroadcasts.length = 0;

  await send(MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: 250 }, OPTIONS_TEST_SENDER);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 100, 'the SW cache stays at the last confirmed value, not the failed 250');
  const popupBroadcasts = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED).filter((b) => b.payload.gainPercent === 250);
  assert.equal(popupBroadcasts.length, 0, 'no popup broadcast claims the unconfirmed 250');

  offscreenResponder.setSetTabGainOverride(null);
});

test('livesync#11: a stale operationId SET_TAB_GAIN is rejected and broadcasts nothing to the options view', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://livesync-stale-op.example/';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);
  const first = await enableTab(tabId);
  const staleOperationId = first.data.operationId;

  // Disable and re-enable: a brand-new operation now owns this tab.
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  const second = await enableTab(tabId);
  assert.notEqual(second.data.operationId, staleOperationId);

  capturedBroadcasts.length = 0;
  const resp = await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 199, expectedOperationId: staleOperationId });
  assert.equal(resp.ok, false, 'a stale-generation gain is rejected');
  assert.equal(resp.error.code, ERROR_CODES.NOT_ACTIVE);
  const optionBroadcasts = broadcastsTo(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED);
  assert.equal(optionBroadcasts.length, 0, 'a stale update moves no options row');
});

test('livesync#12: the new live-sync messages pass real target-aware validation', async () => {
  const { validateMessage } = await import('../shared/validation.js');
  const toSw = validateMessage({
    target: TARGETS.SERVICE_WORKER,
    type: MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN,
    requestId: 'r',
    payload: { pageKey: 'https://ok.example/', gainPercent: 150 },
  });
  assert.equal(toSw.ok, true, 'SET_SAVED_PAGE_LIVE_GAIN validates for the service worker');
  const toOptions = validateMessage({
    target: TARGETS.OPTIONS,
    type: MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED,
    requestId: 'r',
    payload: { pageKey: 'https://ok.example/', gainPercent: 150 },
  });
  assert.equal(toOptions.ok, true, 'SAVED_PAGE_LIVE_GAIN_CHANGED validates for the options page');
});

test('livesync#13: wrong sender, wrong target, malformed pageKey, and gain above 300 are all rejected', async () => {
  const { validateMessage } = await import('../shared/validation.js');

  // Wrong sender: SET_SAVED_PAGE_LIVE_GAIN is options-only; the popup sender is rejected.
  resetEverything();
  const wrongSender = await send(
    MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN,
    { pageKey: 'https://x.example/', gainPercent: 150 },
    DEFAULT_TEST_SENDER
  );
  assert.equal(wrongSender.ok, false, 'the popup sender may not send this options-only message');
  assert.equal(wrongSender.error.code, ERROR_CODES.INVALID_MESSAGE);

  // Wrong target: SAVED_PAGE_LIVE_GAIN_CHANGED addressed to the service worker is rejected by the sender matrix.
  const wrongTarget = await send(
    MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED,
    { pageKey: 'https://x.example/', gainPercent: 150 },
    OPTIONS_TEST_SENDER
  );
  assert.equal(wrongTarget.ok, false, 'a broadcast-only type is not accepted as a service-worker command');

  // Malformed pageKey (empty / non-string) is rejected by the payload validator.
  const base = { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, requestId: 'r' };
  assert.equal(validateMessage({ ...base, payload: { pageKey: '', gainPercent: 150 } }).ok, false, 'empty pageKey rejected');
  assert.equal(validateMessage({ ...base, payload: { pageKey: 123, gainPercent: 150 } }).ok, false, 'non-string pageKey rejected');

  // Gain above 300 (and non-integer) is rejected outright, not clamped.
  assert.equal(validateMessage({ ...base, payload: { pageKey: 'https://x.example/', gainPercent: 350 } }).ok, false, 'gain > 300 rejected');
  assert.equal(validateMessage({ ...base, payload: { pageKey: 'https://x.example/', gainPercent: 150.5 } }).ok, false, 'non-integer gain rejected');
});

// ===========================================================================
// v0.2.0: schema-6 saved-page metadata, rename, and the bulk selection
// operations (Reset selected to 100% / Delete selected), driven end to end
// through the real registerMessageHandler -> validateMessage -> service-worker
// path against the fake offscreen responder.
// ===========================================================================

async function savedRecords() {
  return settings.getSavedPages();
}

// --- Title snapshots ---

test('meta #11: Add this page stores the tab title the SERVICE WORKER read, as titleSnapshot', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://titled.example/watch';
  setTab(tabId, pageKey, 'Real Tab Title');

  const response = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 175 });
  assert.equal(response.ok, true, JSON.stringify(response));

  const record = (await savedRecords())[pageKey];
  assert.equal(record.titleSnapshot, 'Real Tab Title');
  assert.equal(record.volumePercent, 175, "the popup's current slider value is stored as the volume");
  assert.equal(record.customName, '', 'customName starts empty');
});

test('meta #12: a popup-supplied title in the payload is IGNORED - only the server-read title is stored', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://spoof.example/page';
  setTab(tabId, pageKey, 'Genuine Title');

  // A malicious/buggy popup tries to dictate the stored label.
  const response = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, {
    tabId,
    expectedPageKey: pageKey,
    gainPercent: 100,
    title: 'ATTACKER SUPPLIED',
    titleSnapshot: 'ATTACKER SUPPLIED',
    customName: 'ATTACKER SUPPLIED',
  });
  assert.equal(response.ok, true);

  const record = (await savedRecords())[pageKey];
  assert.equal(record.titleSnapshot, 'Genuine Title', 'the service worker used its own chrome.tabs.get title');
  assert.equal(record.customName, '', 'a popup-supplied customName is not honoured by Add this page');
});

test('meta #13: a stored title is sanitized and length-limited', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://messy-title.example/';
  const nasty = `  Wild\n\tTitle   with \u0007control\u0000 chars  ${'x'.repeat(400)}`;
  setTab(tabId, pageKey, nasty);

  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 100 });
  const record = (await savedRecords())[pageKey];
  assert.equal(record.titleSnapshot.length <= MAX_TITLE_SNAPSHOT_LENGTH, true, 'length-limited');
  assert.equal(record.titleSnapshot.includes('\n'), false, 'no raw newlines');
  assert.equal(record.titleSnapshot.includes('\u0007'), false, 'no control characters');
  assert.equal(record.titleSnapshot.includes('\u0000'), false, 'no NUL characters');
  assert.ok(record.titleSnapshot.startsWith('Wild Title with control chars'), record.titleSnapshot);
});

test('meta #14: Add this page again refreshes the title but keeps an existing customName', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://refresh-title.example/';
  setTab(tabId, pageKey, 'First Title');
  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 120 });

  const renamed = await send(MESSAGE_TYPES.RENAME_SAVED_PAGE, { pageKey, customName: 'My Label' }, OPTIONS_TEST_SENDER);
  assert.equal(renamed.ok, true);

  setTab(tabId, pageKey, 'Second Title');
  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 200 });

  const record = (await savedRecords())[pageKey];
  assert.equal(record.titleSnapshot, 'Second Title', 'the snapshot refreshed');
  assert.equal(record.customName, 'My Label', 'the user-chosen name survived');
  assert.equal(record.volumePercent, 120, 'volume stays idempotent on a re-save');
});

test('meta: Add this page during a navigation race still returns PAGE_CHANGED and saves neither page', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://race-a.example/';
  const pageB = 'https://race-b.example/';
  setTab(tabId, pageA, 'A');
  setTab(tabId, pageB, 'B'); // the tab already moved on

  const response = await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageA, gainPercent: 150 });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_CHANGED);
  assert.deepEqual(await savedRecords(), {}, 'neither page was saved');
});

test('meta: Add this page never restarts an already-active temporary session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://active-then-save.example/';
  setTab(tabId, pageKey, 'Playing');
  const { data } = await enableTab(tabId, 190);

  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 190 });

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active', 'still active');
  assert.equal(state.data.operationId, data.operationId, 'the SAME operation - never restarted');
  assert.equal(state.data.saved, true);
});

test('meta #15/#16: a manual add stores customName with an EMPTY titleSnapshot; no name falls back to the URL label', async () => {
  resetEverything();
  const named = 'https://manual-named.example/show';
  const unnamed = 'https://manual-unnamed.example/clip';

  await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: named, gainPercent: 175, customName: '  Movie  Night ' });
  await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: unnamed, gainPercent: 100 });

  const pages = await savedRecords();
  assert.deepEqual(pages[named], { volumePercent: 175, titleSnapshot: '', customName: 'Movie Night' });
  assert.deepEqual(pages[unnamed], { volumePercent: 100, titleSnapshot: '', customName: '' });

  // #17: the display-name priority resolves each one correctly.
  assert.equal(getDisplayName(named, pages[named]), 'Movie Night');
  assert.equal(getDisplayName(unnamed, pages[unnamed]), 'manual-unnamed.example · clip', 'local URL fallback');
});

// --- Rename ---

test('rename #59/#63/#64: rename changes only customName - never the gain, never the session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://rename-live.example/';
  setTab(tabId, pageKey, 'Snapshot Title');
  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 180 });
  const { data } = await enableTab(tabId, 180);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 180);

  const response = await send(MESSAGE_TYPES.RENAME_SAVED_PAGE, { pageKey, customName: 'Renamed' }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(response.data.customName, 'Renamed');

  const record = (await savedRecords())[pageKey];
  assert.equal(record.customName, 'Renamed');
  assert.equal(record.volumePercent, 180, 'volume untouched');
  assert.equal(record.titleSnapshot, 'Snapshot Title', 'titleSnapshot untouched');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 180, 'live gain untouched');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active', 'capture neither started nor stopped');
  assert.equal(state.data.operationId, data.operationId, 'the same operation generation');
});

test('rename #60/#61: an empty rename clears the override and display falls back to titleSnapshot then the URL', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://fallback-chain.example/clip';
  setTab(tabId, pageKey, 'Captured Title');
  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId, expectedPageKey: pageKey, gainPercent: 100 });
  await send(MESSAGE_TYPES.RENAME_SAVED_PAGE, { pageKey, customName: 'Override' }, OPTIONS_TEST_SENDER);
  assert.equal(getDisplayName(pageKey, (await savedRecords())[pageKey]), 'Override');

  await send(MESSAGE_TYPES.RENAME_SAVED_PAGE, { pageKey, customName: '' }, OPTIONS_TEST_SENDER);
  let record = (await savedRecords())[pageKey];
  assert.equal(record.customName, '');
  assert.equal(getDisplayName(pageKey, record), 'Captured Title', 'falls back to the titleSnapshot');

  // With no snapshot either, it falls back to the locally derived URL label.
  record = { ...record, titleSnapshot: '' };
  assert.equal(getDisplayName(pageKey, record), 'fallback-chain.example · clip');
});

test('rename #62: a rename is immediately reflected in local search results', async () => {
  resetEverything();
  const pageKey = 'https://opaque-host.example/z9q1';
  await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: pageKey, gainPercent: 100 });
  assert.deepEqual(filterSavedPageKeys(await savedRecords(), 'jazz'), [], 'not findable before the rename');

  await send(MESSAGE_TYPES.RENAME_SAVED_PAGE, { pageKey, customName: 'Jazz Radio' }, OPTIONS_TEST_SENDER);
  assert.deepEqual(filterSavedPageKeys(await savedRecords(), 'jazz'), [pageKey], 'findable straight after the rename');
});

test('rename #65: renaming a page that is not saved returns a structured error and creates nothing', async () => {
  resetEverything();
  const response = await send(
    MESSAGE_TYPES.RENAME_SAVED_PAGE,
    { pageKey: 'https://never-saved.example/', customName: 'Nope' },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_NOT_SAVED);
  assert.deepEqual(await savedRecords(), {});
});

test('rename #66: wrong sender and malformed payloads are rejected', async () => {
  resetEverything();
  const pageKey = 'https://rename-guard.example/';
  await send(MESSAGE_TYPES.ADD_PAGE_MANUAL, { rawUrl: pageKey, gainPercent: 100 });

  // RENAME_SAVED_PAGE is options-only.
  const wrongSender = await send(MESSAGE_TYPES.RENAME_SAVED_PAGE, { pageKey, customName: 'x' }, DEFAULT_TEST_SENDER);
  assert.equal(wrongSender.ok, false);
  assert.equal(wrongSender.error.code, ERROR_CODES.INVALID_MESSAGE);

  const { validateMessage } = await import('../shared/validation.js');
  const base = { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.RENAME_SAVED_PAGE, requestId: 'r' };
  assert.equal(validateMessage({ ...base, payload: { pageKey: '', customName: 'x' } }).ok, false, 'empty pageKey');
  assert.equal(validateMessage({ ...base, payload: { pageKey } }).ok, false, 'missing customName');
  assert.equal(validateMessage({ ...base, payload: { pageKey, customName: 42 } }).ok, false, 'non-string customName');
  assert.equal(
    validateMessage({ ...base, payload: { pageKey, customName: 'x'.repeat(MAX_CUSTOM_NAME_LENGTH + 1) } }).ok,
    false,
    'over-long customName is rejected, not silently truncated'
  );
  assert.equal(validateMessage({ ...base, payload: { pageKey, customName: '' } }).ok, true, 'an empty name is valid');

  // The record is untouched by every rejected attempt.
  assert.equal((await savedRecords())[pageKey].customName, '');
});

// --- Reset selected to 100% ---

test('reset #39: an INACTIVE selected page simply saves 100%', async () => {
  resetEverything();
  const pageKey = 'https://reset-inactive.example/';
  await addAndAssertSaved(pageKey, 250);

  const response = await send(
    MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100,
    { pageKeys: [pageKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.results, [{ pageKey, ok: true }]);
  assert.equal((await savedVolumes())[pageKey], 100);
});

test('reset #40/#42: an ACTIVE selected page moves the offscreen gain to 1.0, saves 100%, and STAYS captured', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://reset-active.example/';
  setTab(tabId, pageKey, 'Loud Page');
  await addAndAssertSaved(pageKey, 250);
  const { data } = await enableTab(tabId, 250);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 250);

  const response = await send(
    MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100,
    { pageKeys: [pageKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.results, [{ pageKey, ok: true }]);

  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 100, 'GainNode gain 1.0');
  assert.equal((await savedVolumes())[pageKey], 100, 'saved preference is 100%');
  assert.equal(offscreenResponder.sessions.has(tabId), true, 'capture is still running - this is not a stop');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.gainPercent, 100);
  assert.equal(state.data.operationId, data.operationId, 'the same operation - never restarted');
});

test('reset #41: both the popup (TAB_STATE_CHANGED) and the Saved-pages row (live gain) receive the 100% update', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://reset-broadcasts.example/';
  setTab(tabId, pageKey, 'X');
  await addAndAssertSaved(pageKey, 220);
  await enableTab(tabId, 220);

  capturedBroadcasts.length = 0;
  await send(MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100, { pageKeys: [pageKey] }, OPTIONS_TEST_SENDER);

  const popupStates = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED).filter(
    (b) => b.payload.tabId === tabId && b.payload.gainPercent === 100
  );
  assert.ok(popupStates.length >= 1, 'the popup was told the tab is now at 100%');

  const rowUpdates = broadcastsTo(TARGETS.OPTIONS, MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED).filter(
    (b) => b.payload.pageKey === pageKey && b.payload.gainPercent === 100
  );
  assert.ok(rowUpdates.length >= 1, 'the Saved-pages row was told to move to 100%');
});

test('reset #43/#44/#45: unselected pages, same-host different-path pages, and unsaved sessions are untouched', async () => {
  resetEverything();
  const selectedTab = freshTabId();
  const siblingTab = freshTabId();
  const unsavedTab = freshTabId();
  const selectedKey = 'https://reset-host.example/selected';
  const siblingKey = 'https://reset-host.example/sibling'; // same host, different exact path
  const otherKey = 'https://reset-other.example/';
  const unsavedKey = 'https://reset-unsaved.example/';

  setTab(selectedTab, selectedKey, 'S');
  setTab(siblingTab, siblingKey, 'B');
  setTab(unsavedTab, unsavedKey, 'U');
  await addAndAssertSaved(selectedKey, 250);
  await addAndAssertSaved(siblingKey, 250);
  await addAndAssertSaved(otherKey, 250);
  await enableTab(selectedTab, 250);
  await enableTab(siblingTab, 250);
  await enableTab(unsavedTab, 250); // unsaved temporary session

  await send(MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100, { pageKeys: [selectedKey] }, OPTIONS_TEST_SENDER);

  const volumes = await savedVolumes();
  assert.equal(volumes[selectedKey], 100, 'the selected page reset');
  assert.equal(volumes[siblingKey], 250, 'the same-host different-path page is untouched');
  assert.equal(volumes[otherKey], 250, 'an unselected page is untouched');
  assert.equal(offscreenResponder.sessions.get(selectedTab).gainPercent, 100);
  assert.equal(offscreenResponder.sessions.get(siblingTab).gainPercent, 250, 'the sibling tab keeps its gain');
  assert.equal(offscreenResponder.sessions.get(unsavedTab).gainPercent, 250, 'the unsaved session is untouched');
  assert.equal(unsavedKey in volumes, false, 'no saved record was created for the unsaved page');
});

test('reset #46/#47/#48: a failed live update does not persist 100% for THAT page and does not block the others', async () => {
  resetEverything();
  const failingTab = freshTabId();
  const okTab = freshTabId();
  const failingKey = 'https://reset-fails.example/';
  const okKey = 'https://reset-succeeds.example/';
  setTab(failingTab, failingKey, 'F');
  setTab(okTab, okKey, 'O');
  await addAndAssertSaved(failingKey, 250);
  await addAndAssertSaved(okKey, 250);
  await enableTab(failingTab, 250);
  await enableTab(okTab, 250);

  // The offscreen live update fails for the FAILING tab only.
  offscreenResponder.setSetTabGainOverride((payload) => {
    if (payload.tabId === failingTab) {
      return { ok: false, error: { code: ERROR_CODES.NOT_ACTIVE, message: 'simulated' } };
    }
    const session = offscreenResponder.sessions.get(payload.tabId);
    if (!session || session.operationId !== payload.operationId) {
      return { ok: false, error: { code: ERROR_CODES.NOT_ACTIVE, message: 'No active session for this tab.' } };
    }
    session.gainPercent = payload.gainPercent;
    return { ok: true, data: { tabId: payload.tabId, gainPercent: payload.gainPercent } };
  });

  const response = await send(
    MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100,
    { pageKeys: [failingKey, okKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true, 'the batch itself resolves - per-page results carry the detail');

  const results = response.data.results;
  const failing = results.find((r) => r.pageKey === failingKey);
  const succeeding = results.find((r) => r.pageKey === okKey);
  assert.equal(failing.ok, false, 'the failing page is reported as failed, never as success');
  assert.ok(failing.error.code, 'a structured error code is reported');
  assert.equal(succeeding.ok, true, 'the unrelated page still succeeded');

  const volumes = await savedVolumes();
  assert.equal(volumes[failingKey], 250, '100% was NOT persisted for the page whose live update failed');
  assert.equal(volumes[okKey], 100, 'the independent page committed normally');

  offscreenResponder.setSetTabGainOverride(null);
});

// --- Delete selected ---

test('delete #49/#53/#55: selected inactive pages are deleted; unselected and different exact URLs are untouched', async () => {
  resetEverything();
  const deleteKey = 'https://del-host.example/gone';
  const siblingKey = 'https://del-host.example/stays'; // same host, different exact path
  const otherKey = 'https://del-other.example/';
  await addAndAssertSaved(deleteKey, 150);
  await addAndAssertSaved(siblingKey, 150);
  await addAndAssertSaved(otherKey, 150);

  const response = await send(
    MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES,
    { pageKeys: [deleteKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.results, [{ pageKey: deleteKey, ok: true }]);

  const volumes = await savedVolumes();
  assert.equal(deleteKey in volumes, false, 'the selected page is gone');
  assert.equal(volumes[siblingKey], 150, 'the same-host different-path page survives');
  assert.equal(volumes[otherKey], 150, 'the unselected page survives');
});

test('delete #50: a selected ACTIVE page is stopped through confirmed teardown before its record is removed', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://del-active.example/';
  setTab(tabId, pageKey, 'A');
  await addAndAssertSaved(pageKey, 150);
  await enableTab(tabId, 150);
  assert.equal(offscreenResponder.sessions.has(tabId), true);

  const response = await send(MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES, { pageKeys: [pageKey] }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.results, [{ pageKey, ok: true }]);

  assert.equal(offscreenResponder.sessions.has(tabId), false, 'the live session was stopped');
  assert.equal(pageKey in (await savedVolumes()), false, 'the record was removed');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active', 'boosting did not silently restart');
  assert.equal(state.data.saved, false, 'the popup now sees an unsaved page');
});

test('delete #51/#52/#57: a failed teardown PRESERVES that record and never blocks an unrelated deletion', async () => {
  resetEverything();
  const stubbornTab = freshTabId();
  const stubbornKey = 'https://del-stubborn.example/';
  const easyKey = 'https://del-easy.example/';
  setTab(stubbornTab, stubbornKey, 'S');
  await addAndAssertSaved(stubbornKey, 150);
  await addAndAssertSaved(easyKey, 150);
  await enableTab(stubbornTab, 150);

  // STOP_CAPTURE for the stubborn tab can never be confirmed.
  offscreenResponder.setStopCaptureOverride((payload) => {
    if (payload.tabId === stubbornTab) {
      return { ok: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'simulated stop failure' } };
    }
    return offscreenResponder.defaultStopCapture(payload);
  });

  const response = await send(
    MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES,
    { pageKeys: [stubbornKey, easyKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);

  const results = response.data.results;
  const stubborn = results.find((r) => r.pageKey === stubbornKey);
  const easy = results.find((r) => r.pageKey === easyKey);
  assert.equal(stubborn.ok, false, 'the unconfirmed teardown is reported as a failure');
  assert.ok(stubborn.error.code);
  assert.equal(easy.ok, true, 'the unrelated page was still deleted');

  const volumes = await savedVolumes();
  assert.equal(volumes[stubbornKey], 150, 'the saved record was NOT deleted while its session might still be live');
  assert.equal(easyKey in volumes, false, 'the independent page was deleted');

  offscreenResponder.setStopCaptureOverride(null);
});

test('delete: an UNSAVED active session on another tab is never disturbed by a bulk delete', async () => {
  resetEverything();
  const savedTab = freshTabId();
  const unsavedTab = freshTabId();
  const savedKey = 'https://del-saved.example/';
  const unsavedKey = 'https://del-untouched.example/';
  setTab(savedTab, savedKey, 'S');
  setTab(unsavedTab, unsavedKey, 'U');
  await addAndAssertSaved(savedKey, 150);
  await enableTab(savedTab, 150);
  await enableTab(unsavedTab, 150);

  await send(MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES, { pageKeys: [savedKey] }, OPTIONS_TEST_SENDER);

  assert.equal(offscreenResponder.sessions.has(savedTab), false, 'the selected saved page stopped');
  assert.equal(offscreenResponder.sessions.has(unsavedTab), true, 'the unrelated unsaved session kept running');
});

test('delete #58: the individual row Delete uses the same safe core - an unconfirmed teardown keeps the record', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://del-single-safe.example/';
  setTab(tabId, pageKey, 'S');
  await addAndAssertSaved(pageKey, 150);
  await enableTab(tabId, 150);

  offscreenResponder.setStopCaptureOverride(() => ({
    ok: false,
    error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'simulated stop failure' },
  }));

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, false, 'the single delete reports the same structured failure');
  assert.equal((await savedVolumes())[pageKey], 150, 'the record survives, exactly like the bulk path');

  offscreenResponder.setStopCaptureOverride(null);
});

test('delete: a successful individual row Delete removes the record and stops its session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://del-single-ok.example/';
  setTab(tabId, pageKey, 'S');
  await addAndAssertSaved(pageKey, 150);
  await enableTab(tabId, 150);

  const response = await send(MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.equal(offscreenResponder.sessions.has(tabId), false);
  assert.equal(pageKey in (await savedVolumes()), false);
});

// --- Bulk payload validation + sender matrix ---

test('bulk: pageKeys payloads are strictly validated (array, non-empty, canonical, no duplicates, bounded)', async () => {
  const { validateMessage } = await import('../shared/validation.js');
  const good = 'https://bulk-ok.example/';
  for (const type of [MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100, MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES]) {
    const base = { target: TARGETS.SERVICE_WORKER, type, requestId: 'r' };
    assert.equal(validateMessage({ ...base, payload: { pageKeys: [good] } }).ok, true, `${type} accepts a valid list`);
    assert.equal(validateMessage({ ...base, payload: { pageKeys: [] } }).ok, false, 'empty array rejected');
    assert.equal(validateMessage({ ...base, payload: { pageKeys: good } }).ok, false, 'non-array rejected');
    assert.equal(validateMessage({ ...base, payload: {} }).ok, false, 'missing pageKeys rejected');
    assert.equal(validateMessage({ ...base, payload: { pageKeys: [good, good] } }).ok, false, 'duplicates rejected');
    assert.equal(validateMessage({ ...base, payload: { pageKeys: [''] } }).ok, false, 'empty key rejected');
    assert.equal(validateMessage({ ...base, payload: { pageKeys: ['not a URL'] } }).ok, false, 'non-canonical key rejected');
    assert.equal(
      validateMessage({ ...base, payload: { pageKeys: ['https://chromewebstore.google.com/detail/x'] } }).ok,
      false,
      'restricted key rejected'
    );
    assert.equal(
      validateMessage({ ...base, payload: { pageKeys: ['https://user:pass@x.example/'] } }).ok,
      false,
      'credentialed key rejected'
    );
    assert.equal(
      validateMessage({ ...base, payload: { pageKeys: ['https://EXAMPLE.com/'] } }).ok,
      false,
      'a non-canonical form is rejected rather than silently canonicalized'
    );
    const oversized = Array.from({ length: MAX_BULK_PAGE_KEYS + 1 }, (_, i) => `https://bulk.example/${i}`);
    assert.equal(validateMessage({ ...base, payload: { pageKeys: oversized } }).ok, false, 'oversized batch rejected');
  }
});

test('bulk: both bulk messages are options-only - the popup sender is rejected', async () => {
  resetEverything();
  const pageKey = 'https://bulk-sender.example/';
  await addAndAssertSaved(pageKey, 150);

  for (const type of [MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100, MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES]) {
    const response = await send(type, { pageKeys: [pageKey] }, DEFAULT_TEST_SENDER);
    assert.equal(response.ok, false, `${type} must reject the popup sender`);
    assert.equal(response.error.code, ERROR_CODES.INVALID_MESSAGE);
  }
  assert.equal((await savedVolumes())[pageKey], 150, 'nothing was changed by the rejected attempts');
});

test('bulk: a bulk operation naming a page that is not saved reports it per-page without touching the others', async () => {
  resetEverything();
  const realKey = 'https://bulk-real.example/';
  const ghostKey = 'https://bulk-ghost.example/';
  await addAndAssertSaved(realKey, 250);

  const response = await send(
    MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100,
    { pageKeys: [ghostKey, realKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  const ghost = response.data.results.find((r) => r.pageKey === ghostKey);
  const real = response.data.results.find((r) => r.pageKey === realKey);
  assert.equal(ghost.ok, false);
  assert.equal(ghost.error.code, ERROR_CODES.PAGE_NOT_SAVED);
  assert.equal(real.ok, true);
  assert.equal((await savedVolumes())[realKey], 100);
});

test('GET_SAVED_PAGES returns schema-6 records plus the currently active exact pageKeys', async () => {
  resetEverything();
  const activeTab = freshTabId();
  const activeKey = 'https://gsp-active.example/';
  const idleKey = 'https://gsp-idle.example/';
  setTab(activeTab, activeKey, 'Active Page');
  await send(MESSAGE_TYPES.ADD_CURRENT_PAGE, { tabId: activeTab, expectedPageKey: activeKey, gainPercent: 175 });
  await addAndAssertSaved(idleKey, 120);
  await enableTab(activeTab, 175);

  const response = await send(MESSAGE_TYPES.GET_SAVED_PAGES, {}, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.savedPages[activeKey], {
    volumePercent: 175,
    titleSnapshot: 'Active Page',
    customName: '',
  });
  assert.deepEqual(response.data.activePageKeys, [activeKey], 'only the genuinely active exact page is listed');
  assert.equal(response.data.savedPages[idleKey].volumePercent, 120);
});

// ===========================================================================
// v0.3.0 Stage 1: the fullscreen-compatible page-audio backend, driven end to
// end through the real registerMessageHandler -> validateMessage -> service
// worker path.
//
// The defining guarantee of this backend is negative: an ordinary Enable must
// never touch chrome.tabCapture and never create an offscreen document, because
// a live capture session is exactly what stops the page's own fullscreen from
// working and lights the capture indicator.
// ===========================================================================

test('page-audio #1/#2/#3: an ordinary Enable uses page-audio, never tabCapture, never offscreen', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch', 'A Film');

  const response = await enablePageAudio(tabId, 200);

  assert.equal(response.data.backend, 'page-audio', 'the page-audio backend owns the session');
  assert.equal(response.data.state, 'active');
  assert.equal(tabCaptureCalls, 0, 'chrome.tabCapture was never called');
  assert.equal(createDocumentCallCount, 0, 'no offscreen document was created');
  assert.equal(offscreenDocumentCreated, false);
  assert.equal(offscreenResponder.sessions.size, 0, 'no offscreen session exists');
  assert.equal(pageGainFor(tabId), 200, 'the page controller received the requested gain');
});

test('page-audio #4/#5: injection happens only after the explicit action, targeting the current tab', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch', 'A Film');

  // Merely reading state must never inject anything.
  await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(executeScriptCalls.length, 0, 'no injection before an explicit user action');

  await enablePageAudio(tabId, 150);
  assert.ok(executeScriptCalls.length >= 2, 'the explicit action injected the bridge and the controller');
  for (const call of executeScriptCalls) {
    assert.equal(call.tabId, tabId, 'injection targets the tab the user acted on');
  }
});

test('page-audio: only packaged local files are injected - never a generated code string', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch');
  await enablePageAudio(tabId);

  for (const call of executeScriptCalls) {
    assert.ok(Array.isArray(call.files) && call.files.length > 0, 'every injection uses `files`');
    for (const file of call.files) {
      assert.match(file, /^page-audio\/[a-z-]+\.js$/, `${file} is a packaged local file`);
    }
    assert.equal('func' in call, false, 'no serialized function injection');
    assert.equal('code' in call, false, 'no code-string injection');
  }
  const worlds = executeScriptCalls.map((c) => c.world);
  assert.ok(worlds.includes('ISOLATED'), 'the extension bridge is injected into the isolated world');
  assert.ok(worlds.includes('MAIN'), 'the page controller is injected into the MAIN world');
});

test('page-audio #6/#7: repeated Enable does not build a second controller', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch');

  await enablePageAudio(tabId, 120);
  const installsAfterFirst = pageControllers.get(`${tabId}:0`).installed;

  // A second Enable while already active is a no-op for the session.
  const second = await send(MESSAGE_TYPES.START_PAGE_AUDIO, startPayload(tabId, 180));
  assert.equal(second.ok, true);
  assert.equal(
    pageControllers.get(`${tabId}:0`).installed,
    installsAfterFirst,
    'no second controller installation for an already-active tab'
  );
});

test('page-audio #26: gain updates reach the page controller and are operation-scoped', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch');
  const { data } = await enablePageAudio(tabId, 100);

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 235,
    expectedOperationId: data.operationId,
  });
  assert.equal(response.ok, true);
  assert.equal(pageGainFor(tabId), 235, 'the page controller applied the new gain');
  assert.equal(tabCaptureCalls, 0, 'still no capture involvement');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.gainPercent, 235);
  assert.equal(state.data.backend, 'page-audio');
});

test('page-audio #27: a stale operationId gain update is rejected and changes nothing', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch');
  const first = await enablePageAudio(tabId, 150);
  const staleOperationId = first.data.operationId;

  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  const second = await enablePageAudio(tabId, 150);
  assert.notEqual(second.data.operationId, staleOperationId);

  const response = await send(MESSAGE_TYPES.SET_TAB_GAIN, {
    tabId,
    gainPercent: 300,
    expectedOperationId: staleOperationId,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.NOT_ACTIVE);
  assert.notEqual(pageGainFor(tabId), 300, 'the superseded generation could not move live audio');
});

test('page-audio #24: an unsupported player reports a structured reason and never starts capture', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://drm.example/watch');
  setPageMediaState(tabId, 'UNSUPPORTED_MEDIA');

  const response = await send(MESSAGE_TYPES.START_PAGE_AUDIO, startPayload(tabId, 200));

  assert.equal(response.ok, false, 'never a fake success for a player that cannot be routed');
  assert.equal(response.error.code, ERROR_CODES.PAGE_AUDIO_UNSUPPORTED);
  assert.ok(response.error.message.length > 10, 'a real reason is reported');
  assert.equal(tabCaptureCalls, 0, 'compatibility mode was NOT started silently');
  assert.equal(createDocumentCallCount, 0, 'no offscreen document was created');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active', 'the tab is left cleanly inactive');
});

test('page-audio #22: an inaccessible cross-origin frame reports a structured permission result', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://host.example/watch');
  // The player lives in a subframe this extension cannot script.
  setInjectableFrames(tabId, [{ frameId: 1, documentId: 'doc-iframe' }]);
  inaccessibleFrames.add(`${tabId}:1`);

  const response = await send(MESSAGE_TYPES.START_PAGE_AUDIO, startPayload(tabId, 200));

  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_AUDIO_UNSUPPORTED);
  assert.equal(response.error.pageAudioState, 'PERMISSION_REQUIRED', 'reported as a permission problem');
  assert.equal(tabCaptureCalls, 0, 'a frame-access failure never escalates to capture');
});

test('page-audio #23/#25: compatibility mode starts ONLY from its own explicit message', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://drm.example/watch');
  setPageMediaState(tabId, 'UNSUPPORTED_MEDIA');

  // The ordinary path declines and leaves everything untouched.
  const declined = await send(MESSAGE_TYPES.START_PAGE_AUDIO, startPayload(tabId, 180));
  assert.equal(declined.ok, false);
  assert.equal(tabCaptureCalls, 0);

  // The user then deliberately chooses compatibility mode.
  const compat = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 180));
  assert.equal(compat.ok, true, 'the explicit fallback starts the existing backend');
  assert.equal(compat.data.state, 'active');
  assert.ok(tabCaptureCalls > 0, 'now, and only now, tabCapture is used');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 180);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.backend, 'tab-capture', 'the session reports the compatibility backend');
});

test('page-audio #28: navigation invalidates the page-audio session and its frame records', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://player.example/a';
  const pageB = 'https://player.example/b';
  setTab(tabId, pageA);
  await enablePageAudio(tabId, 200);

  setTab(tabId, pageB);
  await fireCommitted(tabId, pageB);
  await tick(20);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active', 'the old session did not survive navigation');
  assert.equal(tabCaptureCalls, 0, 'navigation handling never involved capture');
});

test('auto-resume: a saved page reapplies its volume automatically when it loads, with no popup action', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/saved-episode';
  // A fresh worker after a browser/PC restart: the volume preference is in
  // storage, but no in-memory session exists and the popup was never opened.
  await addAndAssertSaved(pageKey, 180);
  setTab(tabId, pageKey, 'Saved Episode');

  // The tab finishes loading the saved URL - the only trigger.
  await fireCommitted(tabId, pageKey);
  await tick(20);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active', 'the saved page resumed boosting on its own');
  assert.equal(state.data.backend, 'page-audio', 'auto-resume uses the fullscreen-compatible backend');
  assert.equal(pageGainFor(tabId), 180, 'the page controller received the saved volume');
  assert.equal(tabCaptureCalls, 0, 'auto-resume never touches tab capture');
  assert.equal(createDocumentCallCount, 0, 'auto-resume never creates an offscreen document');
});

test('auto-resume: a page the user never saved is never boosted on its own', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/not-saved';
  setTab(tabId, pageKey);

  await fireCommitted(tabId, pageKey);
  await tick(20);

  assert.equal(executeScriptCalls.length, 0, 'nothing was injected for an unsaved page');
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active', 'an unsaved page stays inactive');
  assert.equal(tabCaptureCalls, 0);
});

test('auto-resume: a saved SPA route resumes when history navigation reaches its exact URL', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/spa/episode-2';
  await addAndAssertSaved(pageKey, 180);
  setTab(tabId, pageKey, 'Episode 2');

  // A History API navigation has no new document commit, but it still opens
  // the exact saved page and must receive the same local preference.
  await fireHistoryStateUpdated(tabId, pageKey);
  await tick(20);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.backend, 'page-audio');
  assert.equal(pageGainFor(tabId), 180);
  assert.equal(tabCaptureCalls, 0, 'SPA auto-resume never uses tab capture');
});

test('auto-resume: moving between saved SPA routes replaces the old exact-page session', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://player.example/spa/episode-1';
  const pageB = 'https://player.example/spa/episode-2';
  await addAndAssertSaved(pageA, 130);
  await addAndAssertSaved(pageB, 210);
  setTab(tabId, pageA, 'Episode 1');
  await enablePageAudio(tabId, 130);

  setTab(tabId, pageB, 'Episode 2');
  await fireHistoryStateUpdated(tabId, pageB);
  await tick(20);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active');
  assert.equal(state.data.backend, 'page-audio');
  assert.equal(pageGainFor(tabId), 210, 'the new saved route receives its own preference');
  assert.equal(tabCaptureCalls, 0);
});

test('auto-resume: a saved page whose media cannot be routed fails silently, starting nothing', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/drm-saved';
  await addAndAssertSaved(pageKey, 200);
  setTab(tabId, pageKey);
  setPageMediaState(tabId, 'UNSUPPORTED_MEDIA');

  // Must not throw out of the navigation listener, and must leave no session.
  await fireCommitted(tabId, pageKey);
  await tick(20);

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active', 'an unsupported saved page is left inactive');
  assert.equal(tabCaptureCalls, 0, 'a failed auto-resume never falls back to capture');
  assert.equal(createDocumentCallCount, 0);
});

test('page-audio #29: Disable returns the page gain to 1.0 without tearing down playback', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch');
  await enablePageAudio(tabId, 250);
  assert.equal(pageGainFor(tabId), 250);

  const stop = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stop.ok, true);
  assert.equal(pageGainFor(tabId), 100, 'gain returned to exactly 100% (1.0)');
  assert.equal(pageControllers.get(`${tabId}:0`).observersDisposed, true, 'the observer was released');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.notEqual(state.data.state, 'active');
  assert.equal(tabCaptureCalls, 0);
});

test('page-audio #31: Saved-pages live gain reaches a page-audio session and updates the popup', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/saved';
  setTab(tabId, pageKey, 'Saved Film');
  await addAndAssertSaved(pageKey, 100);
  await enablePageAudio(tabId, 100);

  capturedBroadcasts.length = 0;
  const response = await send(
    MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN,
    { pageKey, gainPercent: 275 },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  assert.equal(pageGainFor(tabId), 275, 'the page-audio session followed the Saved-pages slider');

  const popupStates = broadcastsTo(TARGETS.POPUP, MESSAGE_TYPES.TAB_STATE_CHANGED).filter(
    (b) => b.payload.tabId === tabId && b.payload.gainPercent === 275
  );
  assert.ok(popupStates.length >= 1, 'the popup was told about the new gain');
});

test('page-audio: Reset selected to 100% works for a page-audio session and keeps it running', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/reset';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 260);
  await enablePageAudio(tabId, 260);

  const response = await send(
    MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100,
    { pageKeys: [pageKey] },
    OPTIONS_TEST_SENDER
  );
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.results, [{ pageKey, ok: true }]);
  assert.equal(pageGainFor(tabId), 100, 'page gain is now 1.0');
  assert.equal((await savedVolumes())[pageKey], 100, 'the preference was committed');

  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });
  assert.equal(state.data.state, 'active', 'still boosting - a reset is not a stop');
  assert.equal(state.data.backend, 'page-audio');
});

test('page-audio: Delete selected stops a page-audio session and removes the record', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://player.example/delete';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 150);
  await enablePageAudio(tabId, 150);

  const response = await send(MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES, { pageKeys: [pageKey] }, OPTIONS_TEST_SENDER);
  assert.equal(response.ok, true);
  assert.deepEqual(response.data.results, [{ pageKey, ok: true }]);
  assert.equal(pageGainFor(tabId), 100, 'the page was returned to neutral gain');
  assert.equal(pageKey in (await savedVolumes()), false, 'the record is gone');
});

test('page-audio #32/#33: exact-page matching is unchanged and a temporary session persists nothing', async () => {
  resetEverything();
  const tabA = freshTabId();
  const tabB = freshTabId();
  const pageA = 'https://same-host.example/one';
  const pageB = 'https://same-host.example/two';
  setTab(tabA, pageA);
  setTab(tabB, pageB);

  await enablePageAudio(tabA, 240);
  await enablePageAudio(tabB, 120);

  assert.equal(pageGainFor(tabA), 240);
  assert.equal(pageGainFor(tabB), 120, 'a different exact path is an entirely separate session');
  assert.deepEqual(await savedVolumes(), {}, 'a temporary page-audio session writes nothing to storage');
});

test('page-audio #35: START_PAGE_AUDIO is popup-only and payload-validated', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/watch');

  const wrongSender = await send(MESSAGE_TYPES.START_PAGE_AUDIO, startPayload(tabId, 150), OPTIONS_TEST_SENDER);
  assert.equal(wrongSender.ok, false, 'the options page may not start a tab session');
  assert.equal(wrongSender.error.code, ERROR_CODES.INVALID_MESSAGE);

  const { validateMessage } = await import('../shared/validation.js');
  const base = { target: TARGETS.SERVICE_WORKER, type: MESSAGE_TYPES.START_PAGE_AUDIO, requestId: 'r' };
  assert.equal(validateMessage({ ...base, payload: { tabId, expectedPageKey: 'x', initialGainPercent: 100 } }).ok, true);
  assert.equal(validateMessage({ ...base, payload: { tabId: null, expectedPageKey: 'x', initialGainPercent: 100 } }).ok, false);
  assert.equal(validateMessage({ ...base, payload: { tabId, initialGainPercent: 100 } }).ok, false, 'expectedPageKey required');
  assert.equal(validateMessage({ ...base, payload: { tabId, expectedPageKey: 'x' } }).ok, false, 'gain required');
});

test('page-audio: a navigation race still returns PAGE_CHANGED and starts nothing', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://player.example/a';
  const pageB = 'https://player.example/b';
  setTab(tabId, pageA);
  setTab(tabId, pageB); // the tab moved on before the click was processed

  const response = await send(MESSAGE_TYPES.START_PAGE_AUDIO, {
    tabId,
    expectedPageKey: pageA,
    initialGainPercent: 200,
  });
  assert.equal(response.ok, false);
  assert.equal(response.error.code, ERROR_CODES.PAGE_CHANGED);
  assert.equal(tabCaptureCalls, 0);
  assert.equal(executeScriptCalls.length, 0, 'nothing was injected for a page the user did not act on');
});

test('page-audio #34: the compatibility backend still behaves exactly as before', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageKey = 'https://compat.example/watch';
  setTab(tabId, pageKey);
  await addAndAssertSaved(pageKey, 100);

  const started = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 175));
  assert.equal(started.ok, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 175, 'the offscreen graph is used');

  await send(MESSAGE_TYPES.SET_TAB_GAIN, { tabId, gainPercent: 210, expectedOperationId: started.data.operationId });
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 210);

  const stopped = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(stopped.ok, true);
  assert.equal(offscreenResponder.sessions.has(tabId), false, 'confirmed teardown still applies');
});

test('page-audio: a page-audio session survives reconciliation (offscreen knows nothing about it)', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://player.example/reconcile');
  await enablePageAudio(tabId, 190);

  // Force a reconciliation pass, which rebuilds the cache from the offscreen
  // document's enumeration - which has no knowledge of page-audio sessions.
  offscreenDocumentCreated = true;
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId });

  assert.equal(state.data.state, 'active', 'the page-audio session was not wrongly discarded');
  assert.equal(state.data.backend, 'page-audio');
  assert.equal(state.data.gainPercent, 190);
});

// ===========================================================================
// v0.3.0 Stage 2: resource lifecycle.
//
// These assert that repeated use does not accumulate anything - neither
// service-worker records nor offscreen resources - and that the offscreen
// document is closed once the compatibility backend has genuinely nothing
// left to do. All timing is driven by a controlled short delay, never a sleep.
// ===========================================================================

test('stage2 #6/#7: navigation and tab close leave no page-audio frame records behind', async () => {
  resetEverything();
  const tabId = freshTabId();
  const pageA = 'https://frames.example/a';
  const pageB = 'https://frames.example/b';
  setTab(tabId, pageA);
  setInjectableFrames(tabId, [
    { frameId: 0, documentId: 'doc-top' },
    { frameId: 1, documentId: 'doc-child' },
  ]);

  await enablePageAudio(tabId, 180);
  assert.equal(sw.__getRuntimeStateForTests().pageAudioFrames.frames, 2, 'both frames were recorded');

  setTab(tabId, pageB);
  await fireCommitted(tabId, pageB);
  await tick(20);

  const afterNavigation = sw.__getRuntimeStateForTests();
  assert.deepEqual(afterNavigation.pageAudioFrames, { tabs: 0, frames: 0 }, 'navigation released every frame record');
  assert.equal(afterNavigation.sessions, 0, 'and the session itself');
});

test('stage2: closing a tab releases its page-audio records unconditionally', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://frames.example/closing');
  await enablePageAudio(tabId, 150);
  assert.equal(sw.__getRuntimeStateForTests().pageAudioFrames.frames, 1);

  removeTabData(tabId);
  await fireTabRemoved(tabId);
  await tick(20);

  assert.deepEqual(sw.__getRuntimeStateForTests().pageAudioFrames, { tabs: 0, frames: 0 });
});

test('stage2 #8: ten page-audio enable/disable cycles do not grow service-worker state', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://cycles.example/page');

  for (let cycle = 0; cycle < 10; cycle += 1) {
    await enablePageAudio(tabId, 150 + cycle);
    const active = sw.__getRuntimeStateForTests();
    assert.equal(active.sessions, 1, `cycle ${cycle}: exactly one session`);
    assert.equal(active.pageAudioFrames.frames, 1, `cycle ${cycle}: exactly one frame record`);

    await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
    const idle = sw.__getRuntimeStateForTests();
    assert.equal(idle.sessions, 0, `cycle ${cycle}: session released`);
    assert.deepEqual(idle.pageAudioFrames, { tabs: 0, frames: 0 }, `cycle ${cycle}: frame records released`);
  }

  assert.equal(tabCaptureCalls, 0, 'ten page-audio cycles never touched tabCapture');
  assert.equal(createDocumentCallCount, 0, 'and never created an offscreen document');
});

test('stage2 #1/#2/#3/#4: repeated page-audio gain changes reuse one controller and one graph', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://cycles.example/gain');
  const { data } = await enablePageAudio(tabId, 100);

  const installsAfterStart = pageControllers.get(`${tabId}:0`).installed;
  for (let i = 0; i < 10; i += 1) {
    await send(MESSAGE_TYPES.SET_TAB_GAIN, {
      tabId,
      gainPercent: 100 + i * 20,
      expectedOperationId: data.operationId,
    });
  }

  assert.equal(
    pageControllers.get(`${tabId}:0`).installed,
    installsAfterStart,
    'ten gain changes installed no additional controller'
  );
  assert.equal(executeScriptCalls.filter((c) => c.world === 'MAIN').length, 1, 'the MAIN controller was injected once');
  assert.equal(pageGainFor(tabId), 280, 'the final value is authoritative');
  assert.equal(sw.__getRuntimeStateForTests().pageAudioFrames.frames, 1, 'still exactly one frame record');
});

test('stage2 #14/#15: ten compatibility cycles leave zero sessions and zero pending work', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://compat-cycles.example/page');

  for (let cycle = 0; cycle < 10; cycle += 1) {
    const started = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));
    assert.equal(started.ok, true, `cycle ${cycle} started`);
    assert.equal(offscreenResponder.sessions.size, 1, `cycle ${cycle}: one offscreen session`);

    const stopped = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
    assert.equal(stopped.ok, true, `cycle ${cycle} stopped`);
    assert.equal(offscreenResponder.sessions.size, 0, `cycle ${cycle}: offscreen session released`);
    assert.equal(offscreenResponder.pending.size, 0, `cycle ${cycle}: no PendingStart left`);
  }

  const state = sw.__getRuntimeStateForTests();
  assert.equal(state.sessions, 0, 'no service-worker session survived');
  assert.equal(state.inFlightCompatibilityOperations, 0, 'no operation left in flight');
});

test('stage2 #12/#13: compatibility teardown is idempotent and a stale stop cannot kill a newer session', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://compat-idem.example/page');

  const first = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  // A duplicate stop is a harmless no-op.
  const duplicate = await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(duplicate.ok, true, 'a repeated teardown is idempotent');

  // A brand-new session must survive a stale teardown aimed at the old one.
  const second = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 200));
  assert.notEqual(second.data.operationId, first.data.operationId);

  const staleTeardown = await dispatch({
    target: TARGETS.OFFSCREEN,
    type: MESSAGE_TYPES.STOP_CAPTURE,
    requestId: 'stale-stop',
    payload: { tabId, operationId: first.data.operationId, force: false },
  });
  assert.equal(staleTeardown.data.status, 'operation_mismatch', 'the stale stop touched nothing');
  assert.equal(offscreenResponder.sessions.has(tabId), true, 'the newer session is still live');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 200);
});

test('stage2 #16/#19/#20: the offscreen document closes when idle, and a later start recreates it once', async () => {
  resetEverything();
  sw.__setOffscreenIdleCloseDelayForTests(30);
  const tabId = freshTabId();
  setTab(tabId, 'https://idle.example/page');

  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));
  assert.equal(createDocumentCallCount, 1, 'the document was created once');
  assert.equal(offscreenDocumentCreated, true);

  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(sw.__getRuntimeStateForTests().compatibilityIdle, true, 'nothing is left to do');

  await tick(120); // past the controlled idle delay
  assert.equal(offscreenDocumentCreated, false, 'the idle document was closed');
  assert.equal(closeDocumentCallCount, 1, 'closed exactly once');

  // The next explicit compatibility start recreates it, exactly once.
  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 175));
  assert.equal(createDocumentCallCount, 2, 'recreated once for the new start');
  assert.equal(offscreenDocumentCreated, true);
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 175);
});

test('stage2 #17: a new compatibility start cancels a pending idle close', async () => {
  resetEverything();
  sw.__setOffscreenIdleCloseDelayForTests(60);
  const tabId = freshTabId();
  setTab(tabId, 'https://idle-cancel.example/page');

  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId });
  assert.equal(sw.__getRuntimeStateForTests().offscreenIdleCloseScheduled, true, 'a close is pending');

  // Start again before the debounce elapses.
  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 190));
  await tick(150);

  assert.equal(offscreenDocumentCreated, true, 'the document survived - the close was cancelled');
  assert.equal(closeDocumentCallCount, 0, 'nothing was closed while a session is live');
  assert.equal(offscreenResponder.sessions.get(tabId).gainPercent, 190);
});

test('stage2 #21/#22: two live compatibility tabs prevent idle close; stopping one preserves the other', async () => {
  resetEverything();
  sw.__setOffscreenIdleCloseDelayForTests(30);
  const tabA = freshTabId();
  const tabB = freshTabId();
  setTab(tabA, 'https://idle-two.example/a');
  setTab(tabB, 'https://idle-two.example/b');

  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabA, 150));
  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabB, 160));
  assert.equal(offscreenResponder.sessions.size, 2);

  // Stopping one leaves the other running, so the document must stay open.
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId: tabA });
  await tick(120);

  assert.equal(offscreenDocumentCreated, true, 'a still-active session keeps the document alive');
  assert.equal(closeDocumentCallCount, 0);
  assert.equal(offscreenResponder.sessions.has(tabB), true, 'the surviving session is untouched');
  assert.equal(offscreenResponder.sessions.get(tabB).gainPercent, 160);

  // Only once the last one stops does the document become idle.
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId: tabB });
  await tick(120);
  assert.equal(offscreenDocumentCreated, false, 'now it closes');
});

test('stage2: a live page-audio session never keeps the offscreen document alive', async () => {
  resetEverything();
  sw.__setOffscreenIdleCloseDelayForTests(30);
  const compatTab = freshTabId();
  const pageAudioTab = freshTabId();
  setTab(compatTab, 'https://mixed.example/compat');
  setTab(pageAudioTab, 'https://mixed.example/page-audio');

  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(compatTab, 150));
  await enablePageAudio(pageAudioTab, 200);

  // Stop only the compatibility session; the page-audio one keeps running.
  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId: compatTab });
  await tick(120);

  assert.equal(offscreenDocumentCreated, false, 'page-audio owns no offscreen resource, so the document closed');
  const state = await send(MESSAGE_TYPES.GET_TAB_STATE, { tabId: pageAudioTab });
  assert.equal(state.data.state, 'active', 'the page-audio session is unaffected by the close');
  assert.equal(pageGainFor(pageAudioTab), 200);
});

test('stage2 #11: a failed compatibility start leaves no session, no pending start, and no live graph', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://failed-start.example/page');

  offscreenResponder.setStartCaptureOverride(() => ({
    ok: false,
    error: { code: ERROR_CODES.CAPTURE_FAILED, message: 'simulated failure' },
  }));

  const response = await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));
  assert.equal(response.ok, false);

  assert.equal(offscreenResponder.sessions.size, 0, 'no offscreen session survived the failed start');
  assert.equal(offscreenResponder.pending.size, 0, 'no PendingStart was orphaned');
  const state = sw.__getRuntimeStateForTests();
  assert.equal(state.sessions, 0, 'no service-worker session survived');
  assert.equal(state.inFlightCompatibilityOperations, 0, 'the in-flight counter was released');

  offscreenResponder.setStartCaptureOverride(null);
});

test('stage2 #23: no video track is ever requested - the capture path is audio-only', async () => {
  resetEverything();
  const tabId = freshTabId();
  setTab(tabId, 'https://audio-only.example/page');
  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(tabId, 150));

  // getMediaStreamId only ever yields an audio-consumed stream id here; the
  // offscreen document's own contract test covers the constraint shape.
  const offscreenSource = readFileSync(path.join(ROOT_DIR, 'offscreen/offscreen.js'), 'utf8');
  assert.equal(/video\s*:\s*true/.test(offscreenSource), false, 'no video track is requested');
  assert.equal(offscreenSource.includes('MediaRecorder'), false, 'nothing records the stream');
});

test('stage2: mixed backends stay independent - stopping one never disturbs the other', async () => {
  resetEverything();
  const compatTab = freshTabId();
  const pageTab = freshTabId();
  setTab(compatTab, 'https://independent.example/compat');
  setTab(pageTab, 'https://independent.example/page');

  await send(MESSAGE_TYPES.START_CAPTURE, startPayload(compatTab, 220));
  await enablePageAudio(pageTab, 130);

  await send(MESSAGE_TYPES.STOP_CAPTURE, { tabId: pageTab });

  assert.equal(offscreenResponder.sessions.get(compatTab).gainPercent, 220, 'the compatibility session is untouched');
  assert.equal(pageGainFor(pageTab), 100, 'the page-audio session returned to neutral');
  const state = sw.__getRuntimeStateForTests();
  assert.equal(state.sessions, 1, 'only the compatibility session remains');
});
