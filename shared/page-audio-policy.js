// Pure, DOM-free policy for the fullscreen-compatible page-audio backend.
//
// This module holds the decisions that must be identical everywhere and must
// be testable without a browser: which media elements are safe to route
// through Web Audio, how a gain percentage maps to a GainNode value, and which
// bridge commands are accepted. The injected page controller applies the same
// rules; tests/page-audio-controller.test.js asserts the two never drift.
//
// The central hazard this encodes: createMediaElementSource() permanently
// reroutes an element's audio through its AudioContext for the rest of the
// document's lifetime. If the element's media is cross-origin without usable
// CORS, the routed output is silence - and it cannot be undone. So anything
// uncertain is refused BEFORE routing, never probed destructively.

import { MIN_GAIN_PERCENT, MAX_GAIN_PERCENT } from './constants.js';

/** Which engine owns a running session. */
export const BACKENDS = Object.freeze({
  PAGE_AUDIO: 'page-audio',
  TAB_CAPTURE: 'tab-capture',
});

export function isValidBackend(value) {
  return value === BACKENDS.PAGE_AUDIO || value === BACKENDS.TAB_CAPTURE;
}

/**
 * Outcomes a page-audio activation attempt can report. A generic "success" is
 * never shown for a player that could not actually be routed.
 */
export const PAGE_AUDIO_STATES = Object.freeze({
  ACTIVE_WITH_MEDIA: 'ACTIVE_WITH_MEDIA',
  ARMED_WAITING_FOR_MEDIA: 'ARMED_WAITING_FOR_MEDIA',
  UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
  PERMISSION_REQUIRED: 'PERMISSION_REQUIRED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONTEXT_SUSPENDED: 'CONTEXT_SUSPENDED',
  ATTACHMENT_FAILED: 'ATTACHMENT_FAILED',
});

export function isTerminalFailureState(state) {
  return (
    state === PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA ||
    state === PAGE_AUDIO_STATES.PERMISSION_DENIED ||
    state === PAGE_AUDIO_STATES.ATTACHMENT_FAILED
  );
}

/** A page-audio session counts as running only in these two states. */
export function isRunningState(state) {
  return state === PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA || state === PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA;
}

/**
 * The complete, narrow command vocabulary the page bridge accepts. There is
 * deliberately no generic "evaluate" or "call" command: the bridge can only
 * install the controller, change gain, report state, reset to neutral, and
 * drop non-essential observers.
 */
export const BRIDGE_COMMANDS = Object.freeze({
  INSTALL: 'INSTALL',
  SET_GAIN: 'SET_GAIN',
  QUERY_STATE: 'QUERY_STATE',
  RESET_TO_NEUTRAL: 'RESET_TO_NEUTRAL',
  DISPOSE_OBSERVERS: 'DISPOSE_OBSERVERS',
});

/** DOM event names used to bridge the isolated world and the MAIN world. */
export const BRIDGE_EVENTS = Object.freeze({
  COMMAND: 'ltab-page-audio-command',
  RESULT: 'ltab-page-audio-result',
});

/** The single global the MAIN-world controller installs itself under. */
export const CONTROLLER_GLOBAL = '__localTabAudioBoostPageController';

/** GainNode value for a validated integer percentage: 100% -> 1.0, 300% -> 3.0. */
export function gainValueFromPercent(gainPercent) {
  return gainPercent / 100;
}

export function isValidGainPercentValue(value) {
  return Number.isInteger(value) && value >= MIN_GAIN_PERCENT && value <= MAX_GAIN_PERCENT;
}

/**
 * Validates a command arriving at the page bridge. Every field is checked
 * explicitly; anything unrecognized is rejected rather than forwarded. The
 * page cannot smuggle a pageKey, tabId, or permission decision through here -
 * those are never read from a bridge message by any privileged code.
 */
export function isValidBridgeCommand(command) {
  if (typeof command !== 'object' || command === null || Array.isArray(command)) return false;
  if (typeof command.operationToken !== 'string' || command.operationToken.length === 0) return false;
  switch (command.type) {
    case BRIDGE_COMMANDS.INSTALL:
      return isValidGainPercentValue(command.gainPercent);
    case BRIDGE_COMMANDS.SET_GAIN:
      return isValidGainPercentValue(command.gainPercent);
    case BRIDGE_COMMANDS.QUERY_STATE:
    case BRIDGE_COMMANDS.RESET_TO_NEUTRAL:
    case BRIDGE_COMMANDS.DISPOSE_OBSERVERS:
      return true;
    default:
      return false;
  }
}

/**
 * Validates the complete snapshot returned across the MAIN-world DOM bridge.
 * Page scripts share that world and DOM event channel, so the service worker
 * must treat every reply as untrusted input even though the controller itself
 * is a packaged file. This cannot prevent a hostile page from interfering
 * with its own audio, but it prevents malformed replies from corrupting the
 * extension's derived session state.
 */
export function isValidPageAudioSnapshot(value, expectedOperationToken) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  if (value.operationToken !== expectedOperationToken) return false;
  if (!isValidGainPercentValue(value.gainPercent)) return false;
  if (!Number.isInteger(value.attachedCount) || value.attachedCount < 0) return false;
  if (!Number.isInteger(value.reinstallCount) || value.reinstallCount < 0) return false;

  const controllerStates = new Set([
    PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA,
    PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA,
    PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA,
    PAGE_AUDIO_STATES.CONTEXT_SUSPENDED,
    PAGE_AUDIO_STATES.ATTACHMENT_FAILED,
  ]);
  if (!controllerStates.has(value.state)) return false;

  const contextStates = new Set(['none', 'running', 'suspended', 'closed']);
  if (!contextStates.has(value.contextState)) return false;

  const refusalValues = new Set(Object.values(ATTACH_REFUSAL));
  return Array.isArray(value.refusals) && value.refusals.every((reason) => refusalValues.has(reason));
}

// --- Media attachment safety -------------------------------------------------

/** Structured reasons an element cannot be safely routed. */
export const ATTACH_REFUSAL = Object.freeze({
  NOT_MEDIA_ELEMENT: 'NOT_MEDIA_ELEMENT',
  NO_SOURCE_YET: 'NO_SOURCE_YET',
  CROSS_ORIGIN_NO_CORS: 'CROSS_ORIGIN_NO_CORS',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  PROTECTED_MEDIA: 'PROTECTED_MEDIA',
  ALREADY_ATTACHED: 'ALREADY_ATTACHED',
  FOREIGN_CONTEXT: 'FOREIGN_CONTEXT',
});

function schemeOf(rawUrl) {
  const colon = rawUrl.indexOf(':');
  if (colon <= 0) return '';
  return rawUrl.slice(0, colon).toLowerCase();
}

function sameOrigin(mediaUrl, documentOrigin) {
  try {
    return new URL(mediaUrl).origin === documentOrigin;
  } catch {
    return false;
  }
}

/**
 * Decides whether one media element may be routed through Web Audio.
 *
 * `descriptor` is a plain snapshot taken by the caller, so this stays pure:
 *   { tagName, currentSrc, documentOrigin, crossOrigin, hasEncryptedMedia,
 *     alreadyAttached, ownedByForeignContext }
 *
 * Safe: same-origin media, blob: URLs minted by this document (which is how
 * Media Source Extensions playback appears), data: URLs, and cross-origin
 * media that explicitly opted into CORS via a crossOrigin attribute.
 * Everything else - notably plain cross-origin src with no crossOrigin mode,
 * and anything reporting encrypted media - is refused untouched.
 */
export function classifyMediaElement(descriptor) {
  const tagName = typeof descriptor?.tagName === 'string' ? descriptor.tagName.toUpperCase() : '';
  if (tagName !== 'VIDEO' && tagName !== 'AUDIO') {
    return { safe: false, reason: ATTACH_REFUSAL.NOT_MEDIA_ELEMENT };
  }
  if (descriptor.alreadyAttached) {
    return { safe: false, reason: ATTACH_REFUSAL.ALREADY_ATTACHED };
  }
  if (descriptor.ownedByForeignContext) {
    return { safe: false, reason: ATTACH_REFUSAL.FOREIGN_CONTEXT };
  }
  // Encrypted/DRM playback must never be rerouted: the routed graph would be
  // silent and the element cannot be recovered.
  if (descriptor.hasEncryptedMedia) {
    return { safe: false, reason: ATTACH_REFUSAL.PROTECTED_MEDIA };
  }

  const currentSrc = typeof descriptor.currentSrc === 'string' ? descriptor.currentSrc : '';
  if (currentSrc.length === 0) {
    // Nothing loaded yet - not a refusal, just not ready. The controller keeps
    // waiting and re-checks when the element actually gets media.
    return { safe: false, reason: ATTACH_REFUSAL.NO_SOURCE_YET, retryable: true };
  }

  const scheme = schemeOf(currentSrc);
  if (scheme === 'blob' || scheme === 'data') {
    // A blob: URL is minted by the document itself (MSE playback included), so
    // it is same-origin by construction.
    return { safe: true, reason: null };
  }
  if (scheme !== 'http' && scheme !== 'https') {
    return { safe: false, reason: ATTACH_REFUSAL.UNSUPPORTED_SCHEME };
  }

  const documentOrigin = typeof descriptor.documentOrigin === 'string' ? descriptor.documentOrigin : '';
  if (sameOrigin(currentSrc, documentOrigin)) {
    return { safe: true, reason: null };
  }

  // Cross-origin: only safe when the element explicitly opted into CORS.
  const crossOrigin = typeof descriptor.crossOrigin === 'string' ? descriptor.crossOrigin.toLowerCase() : '';
  if (crossOrigin === 'anonymous' || crossOrigin === 'use-credentials') {
    return { safe: true, reason: null };
  }
  return { safe: false, reason: ATTACH_REFUSAL.CROSS_ORIGIN_NO_CORS };
}

/**
 * Folds per-element classifications into the document's overall state.
 * "Nothing attached yet, but something might still appear" is ARMED rather
 * than a failure, because players frequently create their media element only
 * once playback starts.
 */
export function summarizeDocumentState({ attachedCount, refusals = [], contextState = 'running' }) {
  if (attachedCount > 0) {
    return contextState === 'suspended' ? PAGE_AUDIO_STATES.CONTEXT_SUSPENDED : PAGE_AUDIO_STATES.ACTIVE_WITH_MEDIA;
  }
  const blocking = refusals.filter(
    (reason) => reason !== ATTACH_REFUSAL.NO_SOURCE_YET && reason !== ATTACH_REFUSAL.ALREADY_ATTACHED
  );
  if (blocking.length > 0) return PAGE_AUDIO_STATES.UNSUPPORTED_MEDIA;
  return PAGE_AUDIO_STATES.ARMED_WAITING_FOR_MEDIA;
}

/** Human-readable explanation for a refusal, shown in the popup. */
export function describeRefusal(reason) {
  switch (reason) {
    case ATTACH_REFUSAL.CROSS_ORIGIN_NO_CORS:
      return "This player's audio is served from another origin without CORS, so it cannot be boosted in fullscreen-compatible mode.";
    case ATTACH_REFUSAL.PROTECTED_MEDIA:
      return 'This player uses protected (DRM) media, which cannot be routed through the page audio engine.';
    case ATTACH_REFUSAL.UNSUPPORTED_SCHEME:
      return "This player's media address is not supported by the page audio engine.";
    case ATTACH_REFUSAL.FOREIGN_CONTEXT:
      return 'This media is already routed through another audio engine on the page.';
    case ATTACH_REFUSAL.NO_SOURCE_YET:
      return 'No media has loaded yet.';
    default:
      return 'This page cannot use fullscreen-compatible mode.';
  }
}
