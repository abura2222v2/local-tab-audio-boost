// Pure payload/message-shape validators. No Chrome API calls anywhere in
// this file - it must be importable and testable under plain Node.

import {
  TARGETS,
  MESSAGE_TYPES,
  MIN_GAIN_PERCENT,
  MAX_GAIN_PERCENT,
  MAX_BULK_PAGE_KEYS,
  MAX_CUSTOM_NAME_LENGTH,
  ERROR_CODES,
  SESSION_STOP_REASONS,
} from './constants.js';
import { canonicalizePageKey } from './urls.js';
import { normalizeSavedPageRecord } from './saved-page-metadata.js';

export function isValidTarget(value) {
  return Object.values(TARGETS).includes(value);
}

export function isValidMessageType(value) {
  return Object.values(MESSAGE_TYPES).includes(value);
}

export function isValidTabId(value) {
  return Number.isInteger(value) && value > 0;
}

export function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

export function isValidGainPercent(value) {
  return Number.isInteger(value) && value >= MIN_GAIN_PERCENT && value <= MAX_GAIN_PERCENT;
}

/** Clamps an arbitrary numeric input into a valid integer gain percent. */
export function clampGainPercent(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.min(MAX_GAIN_PERCENT, Math.max(MIN_GAIN_PERCENT, rounded));
}

// Payload shape validators for messages addressed to the offscreen document
// (service-worker -> offscreen). These have different shapes than the
// popup/service-worker-facing messages that happen to share a `type` name -
// see the target-keyed PAYLOAD_VALIDATORS_BY_TARGET map below, which is what
// actually enforces that a message is checked against the shape for the
// target it is addressed to, never a shape belonging to some other target.
export function isValidOffscreenStartCapturePayload(p) {
  return (
    isPlainObject(p) &&
    isValidTabId(p.tabId) &&
    isNonEmptyString(p.streamId) &&
    isNonEmptyString(p.operationId) &&
    isNonEmptyString(p.pageKey) &&
    isValidGainPercent(p.gainPercent)
  );
}

const KNOWN_SESSION_STOP_REASONS = new Set(Object.values(SESSION_STOP_REASONS));

/**
 * `operationId` is required whenever `force` is not `true` - only the
 * emergency fail-closed sweep and an explicit user Disable/force path may
 * omit it, and both always pass `force: true` when they do. `force`, when
 * present, must be a genuine boolean - never coerced from an arbitrary
 * value (a caller must never be able to pass the *string* "false" and have
 * it silently treated as bypassing operationId matching).
 */
export function isValidOffscreenStopCapturePayload(p) {
  if (!isPlainObject(p) || !isValidTabId(p.tabId)) return false;
  if (p.force !== undefined && typeof p.force !== 'boolean') return false;
  const forced = p.force === true;
  if (!forced) {
    if (!isNonEmptyString(p.operationId)) return false;
  } else if (p.operationId !== undefined && !isNonEmptyString(p.operationId)) {
    return false;
  }
  if (p.reason !== undefined && (!isNonEmptyString(p.reason) || !KNOWN_SESSION_STOP_REASONS.has(p.reason))) return false;
  return true;
}

export function isValidOffscreenSetGainPayload(p) {
  return isPlainObject(p) && isValidTabId(p.tabId) && typeof p.gainPercent === 'number' && isNonEmptyString(p.operationId);
}

// Payload shape validators for messages addressed to the SERVICE WORKER
// (popup/options -> service-worker, and offscreen -> service-worker events).
const SERVICE_WORKER_PAYLOAD_VALIDATORS = {
  [MESSAGE_TYPES.GET_TAB_STATE]: (p) => isPlainObject(p) && isValidTabId(p.tabId),
  [MESSAGE_TYPES.GET_SAVED_PAGES]: (p) => isPlainObject(p),
  // ADD_CURRENT_PAGE carries the popup's server-derived expectedPageKey
  // (from the same tab's last GET_TAB_STATE/TAB_STATE_CHANGED) so the
  // service worker can detect a navigation that raced the click - see
  // handleAddCurrentPage in service-worker.js. It is never trusted as
  // authority, only compared against a freshly-resolved value. `gainPercent`
  // is the popup's current main-slider value, saved atomically alongside
  // the URL - saving is a storage-only preference, never a capture trigger.
  [MESSAGE_TYPES.ADD_CURRENT_PAGE]: (p) =>
    isPlainObject(p) && isValidTabId(p.tabId) && isNonEmptyString(p.expectedPageKey) && typeof p.gainPercent === 'number',
  // `gainPercent` is optional here (the "Add URL manually" modal's initial
  // volume) - a missing value defaults to 100% in the handler. `customName` is
  // the modal's optional local name field: absent or a string within the
  // stored maximum. A manually added URL is NEVER fetched, so it never gets a
  // titleSnapshot - only this optional name.
  [MESSAGE_TYPES.ADD_PAGE_MANUAL]: (p) =>
    isPlainObject(p) &&
    isNonEmptyString(p.rawUrl) &&
    (p.gainPercent === undefined || typeof p.gainPercent === 'number') &&
    (p.customName === undefined || (typeof p.customName === 'string' && p.customName.length <= MAX_CUSTOM_NAME_LENGTH)),
  [MESSAGE_TYPES.REMOVE_SAVED_PAGE]: (p) => isPlainObject(p) && isNonEmptyString(p.pageKey),
  [MESSAGE_TYPES.CLEAR_SAVED_PAGES]: (p) => isPlainObject(p),
  // Saved-pages-view -> service worker, direct pageKey update - never
  // tab/operationId-scoped, since it does not originate from any one tab.
  [MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME]: (p) => isPlainObject(p) && isNonEmptyString(p.pageKey) && typeof p.gainPercent === 'number',
  // Saved-pages-view -> service worker, LIVE-only (no persistence) gain for
  // one exact pageKey. Unlike UPDATE_SAVED_PAGE_VOLUME (which clamps an
  // arbitrary number before persisting), a live-drag value is required to be
  // an in-range integer gain percent here (0-300) - a malformed pageKey or an
  // out-of-range/non-integer gain is rejected outright rather than clamped, so
  // a stray live message can never drive audio to an unintended value.
  [MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN]: (p) => isPlainObject(p) && isNonEmptyString(p.pageKey) && isValidGainPercent(p.gainPercent),
  // Saved-pages-view -> service worker: sets ONE page's local customName.
  // `customName` must be a string (an EMPTY string is valid and clears the
  // override) and must not exceed the stored maximum before sanitization -
  // an over-long name is rejected outright rather than silently truncated.
  [MESSAGE_TYPES.RENAME_SAVED_PAGE]: (p) =>
    isPlainObject(p) &&
    isNonEmptyString(p.pageKey) &&
    typeof p.customName === 'string' &&
    p.customName.length <= MAX_CUSTOM_NAME_LENGTH,
  // Saved-pages-view -> service worker: bulk operations over an explicit,
  // fully-validated list of canonical exact pageKeys (see isValidPageKeyList).
  [MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100]: (p) => isPlainObject(p) && isValidPageKeyList(p.pageKeys),
  [MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES]: (p) => isPlainObject(p) && isValidPageKeyList(p.pageKeys),
  // START_CAPTURE carries the popup's last server-derived `expectedPageKey`
  // (never trusted as URL authority - only compared against a freshly
  // re-derived pageKey in handleStartCapture) so a click/slider observed on
  // page A can never start capture on page B if the tab navigated in
  // between. `initialGainPercent` is the user's current slider value
  // (slider-triggered start) or the displayed default/saved value (Enable
  // click), bound to the resulting operation as its starting gain.
  [MESSAGE_TYPES.START_CAPTURE]: (p) =>
    isPlainObject(p) && isValidTabId(p.tabId) && isNonEmptyString(p.expectedPageKey) && typeof p.initialGainPercent === 'number',
  [MESSAGE_TYPES.STOP_CAPTURE]: (p) => isPlainObject(p) && isValidTabId(p.tabId),
  // SET_TAB_GAIN/PERSIST_PAGE_VOLUME carry the popup's expectedOperationId
  // (from the same tab's last GET_TAB_STATE/TAB_STATE_CHANGED) so a
  // message from a superseded session generation can never be mistaken
  // for one from the session currently active on this tab. This is a
  // DIFFERENT, popup-facing shape than the offscreen-facing SET_TAB_GAIN
  // payload below (which carries `operationId`, not `expectedOperationId`) -
  // the two must never be validated against the same validator.
  [MESSAGE_TYPES.SET_TAB_GAIN]: (p) =>
    isPlainObject(p) && isValidTabId(p.tabId) && typeof p.gainPercent === 'number' && isNonEmptyString(p.expectedOperationId),
  [MESSAGE_TYPES.PERSIST_PAGE_VOLUME]: (p) =>
    isPlainObject(p) && isValidTabId(p.tabId) && typeof p.gainPercent === 'number' && isNonEmptyString(p.expectedOperationId),
  [MESSAGE_TYPES.SESSION_STOPPED]: (p) => isPlainObject(p) && isValidTabId(p.tabId) && isNonEmptyString(p.operationId),
  [MESSAGE_TYPES.SESSION_ERROR]: (p) => isPlainObject(p) && isValidTabId(p.tabId) && isNonEmptyString(p.operationId),
};

// Payload shape validators for messages addressed to the OFFSCREEN document
// (service-worker -> offscreen only).
const OFFSCREEN_PAYLOAD_VALIDATORS = {
  [MESSAGE_TYPES.START_CAPTURE]: isValidOffscreenStartCapturePayload,
  [MESSAGE_TYPES.STOP_CAPTURE]: isValidOffscreenStopCapturePayload,
  [MESSAGE_TYPES.SET_TAB_GAIN]: isValidOffscreenSetGainPayload,
  [MESSAGE_TYPES.GET_ACTIVE_SESSIONS]: (p) => isPlainObject(p),
};

// Payload shape validators for messages addressed to the POPUP (best-effort
// broadcasts from the service worker only).
const POPUP_PAYLOAD_VALIDATORS = {
  [MESSAGE_TYPES.TAB_STATE_CHANGED]: (p) => isPlainObject(p) && isValidTabId(p.tabId),
  // SAVED_PAGE_CHANGED carries only the exact pageKey whose saved value
  // changed - the popup compares it against its own current pageKey and
  // refreshes only on an exact match (never starts capture).
  [MESSAGE_TYPES.SAVED_PAGE_CHANGED]: (p) => isPlainObject(p) && isNonEmptyString(p.pageKey),
};

// Payload shape validators for messages addressed to the OPTIONS page
// (best-effort broadcasts from the service worker only).
const OPTIONS_PAYLOAD_VALIDATORS = {
  [MESSAGE_TYPES.SAVED_PAGES_CHANGED]: (p) => isPlainObject(p),
  // SAVED_PAGE_LIVE_GAIN_CHANGED carries the exact pageKey whose live gain
  // changed (from the popup slider) plus the confirmed in-range integer
  // gainPercent - the options view moves only the matching exact row.
  [MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED]: (p) =>
    isPlainObject(p) && isNonEmptyString(p.pageKey) && isValidGainPercent(p.gainPercent),
};

// Keyed by BOTH target and type - a message's `type` alone is never enough
// to pick the right payload shape, since several types (START_CAPTURE,
// STOP_CAPTURE, SET_TAB_GAIN) carry a genuinely different shape depending on
// which context the message is addressed to (popup/options -> service-worker
// vs. service-worker -> offscreen). There is deliberately no looser "union"
// validator anywhere that would accept fields belonging to a different
// target's shape.
const PAYLOAD_VALIDATORS_BY_TARGET = {
  [TARGETS.SERVICE_WORKER]: SERVICE_WORKER_PAYLOAD_VALIDATORS,
  [TARGETS.OFFSCREEN]: OFFSCREEN_PAYLOAD_VALIDATORS,
  [TARGETS.POPUP]: POPUP_PAYLOAD_VALIDATORS,
  [TARGETS.OPTIONS]: OPTIONS_PAYLOAD_VALIDATORS,
};

/**
 * Validates the outer envelope (target/type/requestId) and, where a shape
 * validator is registered for this exact (target, type) pair, the payload
 * too. `message.target` is trusted here only as a lookup KEY into the
 * per-target validator map, never as authority over which handler actually
 * runs it - registerMessageHandler (shared/messages.js) independently
 * filters every message on `message.target === selfTarget` before this
 * function is ever reached for a given listener, so by the time a
 * validator is selected here, `message.target` is already known to be
 * exactly the context that is about to handle the message.
 */
export function validateMessage(message) {
  if (!isPlainObject(message)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Message must be an object.' };
  }
  if (!isValidTarget(message.target)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Invalid or missing target.' };
  }
  if (!isValidMessageType(message.type)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Invalid or missing type.' };
  }
  if (!isNonEmptyString(message.requestId)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: 'Invalid or missing requestId.' };
  }
  const validator = PAYLOAD_VALIDATORS_BY_TARGET[message.target]?.[message.type];
  if (validator && !validator(message.payload)) {
    return { ok: false, code: ERROR_CODES.INVALID_MESSAGE, message: `Invalid payload for ${message.type}.` };
  }
  return { ok: true };
}

/**
 * Recovers a malformed/legacy savedPages storage value into a safe SCHEMA-6
 * map whose every key is a genuine canonical exact-page key and whose every
 * value is a well-formed `{volumePercent, titleSnapshot, customName}` record.
 *
 * This is the single normalization used for BOTH a defensive read of a
 * schema-6 profile and the schema-5 -> schema-6 migration, because
 * normalizeSavedPageRecord (shared/saved-page-metadata.js) accepts either
 * representation:
 *   - a bare number (schema 5) becomes a record with empty metadata;
 *   - a schema-6 object is validated and sanitized, and any unrecognized
 *     property is dropped rather than trusted.
 * An entry whose value cannot yield a valid record (bad type, non-integer or
 * out-of-range volume) is ignored entirely, exactly as an out-of-range number
 * was ignored under schema 5.
 *
 * Every candidate key is run through the single canonical matcher
 * (canonicalizePageKey in shared/urls.js - never re-implemented here), and
 * only its canonical result is retained. This drops unsupported-scheme,
 * restricted, credentialed, and otherwise-malformed keys (e.g. "not a URL"),
 * and stores the canonical form rather than a near-miss original, so a
 * default-port or hostname-case variant collapses onto its canonical key.
 *
 * Canonical collisions (two raw keys mapping to the same canonical key) are
 * resolved deterministically: the FIRST valid canonical entry encountered in
 * the input's own key order wins, and later duplicates are ignored. Exact
 * path/query/fragment differences are preserved verbatim by
 * canonicalizePageKey, so genuinely distinct pages never collide.
 */
export function normalizeSavedPages(value) {
  if (!isPlainObject(value)) return {};
  const result = {};
  for (const [rawKey, storedValue] of Object.entries(value)) {
    const record = normalizeSavedPageRecord(storedValue);
    if (record === null) continue;
    const canonical = canonicalizePageKey(rawKey);
    if (!canonical.ok) continue;
    if (!(canonical.pageKey in result)) {
      result[canonical.pageKey] = record;
    }
  }
  return result;
}

/**
 * Validates a bulk operation's `pageKeys` array (RESET_SELECTED_SAVED_PAGES_TO_100
 * / DELETE_SELECTED_SAVED_PAGES). An options-page-supplied list is never
 * trusted: every entry must be a string that canonicalizes to exactly itself,
 * so a non-canonical, restricted, credentialed, or unsupported URL can never
 * enter a bulk operation. Also rejects a non-array, an empty array, an
 * oversized batch, and duplicates.
 */
export function isValidPageKeyList(value) {
  if (!Array.isArray(value)) return false;
  if (value.length === 0 || value.length > MAX_BULK_PAGE_KEYS) return false;
  const seen = new Set();
  for (const entry of value) {
    if (!isNonEmptyString(entry)) return false;
    const canonical = canonicalizePageKey(entry);
    if (!canonical.ok || canonical.pageKey !== entry) return false;
    if (seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
}
