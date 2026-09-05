// Shared constants used across every extension context (service worker,
// offscreen document, popup, options page) and by the Node unit tests.

export const TARGETS = Object.freeze({
  SERVICE_WORKER: 'service-worker',
  OFFSCREEN: 'offscreen',
  POPUP: 'popup',
  OPTIONS: 'options',
});

export const MESSAGE_TYPES = Object.freeze({
  // popup/options -> service worker
  GET_TAB_STATE: 'GET_TAB_STATE',
  GET_SAVED_PAGES: 'GET_SAVED_PAGES',
  // Saves the CURRENT tab's exact URL, plus the popup's current slider
  // value, as a saved page. Never itself starts or requires a capture
  // session - saving is a storage-only preference, not a permission.
  ADD_CURRENT_PAGE: 'ADD_CURRENT_PAGE',
  ADD_PAGE_MANUAL: 'ADD_PAGE_MANUAL',
  REMOVE_SAVED_PAGE: 'REMOVE_SAVED_PAGE',
  CLEAR_SAVED_PAGES: 'CLEAR_SAVED_PAGES',
  // Options/saved-pages-view -> service worker: updates one saved page's
  // default percentage directly by pageKey (not tab-scoped), and
  // best-effort propagates it to any currently active session(s) sharing
  // that exact pageKey.
  UPDATE_SAVED_PAGE_VOLUME: 'UPDATE_SAVED_PAGE_VOLUME',
  // Options/saved-pages-view -> service worker: a THROTTLED, LIVE-ONLY gain
  // for one exact saved pageKey, sent continuously while a row slider is
  // dragged (the `input` event). It NEVER writes storage and NEVER starts a
  // capture session - it only applies to any currently active session(s)
  // sharing that identical pageKey, via the same confirmed, operation-scoped
  // offscreen update that UPDATE_SAVED_PAGE_VOLUME uses. The final value is
  // committed exactly once, separately, through UPDATE_SAVED_PAGE_VOLUME on
  // the slider's `change` event.
  SET_SAVED_PAGE_LIVE_GAIN: 'SET_SAVED_PAGE_LIVE_GAIN',
  // Options/saved-pages-view -> service worker: sets ONE saved page's local
  // customName override (display only). Never touches volumePercent,
  // titleSnapshot, or any capture session. An empty string clears the
  // override, so the display name falls back to titleSnapshot then a locally
  // derived URL label.
  RENAME_SAVED_PAGE: 'RENAME_SAVED_PAGE',
  // Options/saved-pages-view -> service worker: bulk operations over an
  // explicit list of exact pageKeys (the view's current selection). Both
  // return structured PER-PAGE results - one page's failure never blocks an
  // unrelated page, and a failed page is never reported as succeeded.
  RESET_SELECTED_SAVED_PAGES_TO_100: 'RESET_SELECTED_SAVED_PAGES_TO_100',
  DELETE_SELECTED_SAVED_PAGES: 'DELETE_SELECTED_SAVED_PAGES',
  // Options/saved-pages-view -> service worker: bulk-imports saved pages from
  // a local JSON file the user picked (never fetched - a File the browser's
  // own file picker already gave the page). Each entry is independently
  // canonicalized and validated exactly like ADD_PAGE_MANUAL; a malformed or
  // unsupported entry never blocks an unrelated one, and importing an already
  // -saved exact pageKey OVERWRITES that page's stored record (an explicit,
  // user-initiated restore - never merged/preserved like ADD_PAGE_MANUAL's
  // idempotent-volume behavior).
  IMPORT_SAVED_PAGES: 'IMPORT_SAVED_PAGES',
  // Popup -> service worker: starts the fullscreen-compatible page-audio
  // backend for the current tab. This is what an ordinary Enable click (or a
  // first slider move) requests; it never touches chrome.tabCapture, so the
  // page's own fullscreen keeps working and no capture indicator appears.
  START_PAGE_AUDIO: 'START_PAGE_AUDIO',
  // Popup -> service worker: the DELIBERATE fallback to the tabCapture
  // backend, offered only after page-audio reported a structured reason it
  // cannot work. Never chosen automatically.
  START_CAPTURE: 'START_CAPTURE',
  STOP_CAPTURE: 'STOP_CAPTURE',
  SET_TAB_GAIN: 'SET_TAB_GAIN',
  PERSIST_PAGE_VOLUME: 'PERSIST_PAGE_VOLUME',
  // service worker -> offscreen
  GET_ACTIVE_SESSIONS: 'GET_ACTIVE_SESSIONS',
  // offscreen -> service worker
  SESSION_STOPPED: 'SESSION_STOPPED',
  SESSION_ERROR: 'SESSION_ERROR',
  // service worker -> popup/options (best-effort broadcasts)
  TAB_STATE_CHANGED: 'TAB_STATE_CHANGED',
  SAVED_PAGES_CHANGED: 'SAVED_PAGES_CHANGED',
  // service worker -> popup: a narrowly-scoped notice that ONE exact saved
  // pageKey's stored value changed (from the saved-pages view). The popup
  // refreshes only if that pageKey matches the tab it is open on - it never
  // starts capture. Distinct from SAVED_PAGES_CHANGED (options-only, carries
  // the whole map) so the popup never subscribes to a broad map broadcast.
  SAVED_PAGE_CHANGED: 'SAVED_PAGE_CHANGED',
  // service worker -> options/saved-pages-view: a narrowly-scoped LIVE-gain
  // notice for ONE exact pageKey, emitted while the POPUP slider drives an
  // active session's live gain (from handleSetTabGain, after the offscreen
  // document confirms the change). An open Saved-pages view moves only the
  // matching exact row's slider + percentage in real time; it never persists.
  // Carries just the pageKey + gainPercent (never the whole map).
  SAVED_PAGE_LIVE_GAIN_CHANGED: 'SAVED_PAGE_LIVE_GAIN_CHANGED',
});

export const ERROR_CODES = Object.freeze({
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  NO_TAB: 'NO_TAB',
  INVALID_URL: 'INVALID_URL',
  UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
  CREDENTIALS_IN_URL: 'CREDENTIALS_IN_URL',
  RESTRICTED_PAGE: 'RESTRICTED_PAGE',
  // Never used to gate START_CAPTURE - a page needs no saved preference to
  // be temporarily boosted. Used only when an operation that inherently
  // requires an existing saved entry (persisting a volume, updating one
  // from the saved-pages view) targets a pageKey that isn't saved.
  PAGE_NOT_SAVED: 'PAGE_NOT_SAVED',
  CAPTURE_FAILED: 'CAPTURE_FAILED',
  // The fullscreen-compatible page-audio backend cannot run on this page (its
  // media is cross-origin without CORS, DRM-protected, or in a frame the
  // extension cannot reach). Never triggers an automatic fallback - the popup
  // shows the reason and offers compatibility mode as a separate choice.
  PAGE_AUDIO_UNSUPPORTED: 'PAGE_AUDIO_UNSUPPORTED',
  ALREADY_IN_PROGRESS: 'ALREADY_IN_PROGRESS',
  RECONCILIATION_FAILED: 'RECONCILIATION_FAILED',
  NOT_ACTIVE: 'NOT_ACTIVE',
  PAGE_CHANGED: 'PAGE_CHANGED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
});

export const SESSION_STOP_REASONS = Object.freeze({
  USER_DISABLED: 'user_disabled',
  TAB_CLOSED: 'tab_closed',
  REPLACED: 'replaced',
  FULL_NAVIGATION: 'full_navigation',
  SAME_DOCUMENT_PAGE_CHANGED: 'same_document_page_changed',
  REMOVED_FROM_SAVED_PAGES: 'removed_from_saved_pages',
  CLEANUP: 'cleanup',
  RECONCILIATION: 'reconciliation',
  EMERGENCY_FAIL_CLOSED: 'emergency_fail_closed',
  STALE_STATUS_IGNORED: 'stale_status_ignored',
  CAPTURE_START_FAILED: 'capture_start_failed',
  PERSIST_FAILED: 'persist_failed',
  SUPERSEDED: 'superseded',
});

export const DEFAULT_VOLUME_PERCENT = 100;

// Saved-page metadata limits (schema 6). Both are local-only display strings;
// neither is ever fetched, and neither affects exact-page matching.
export const MAX_TITLE_SNAPSHOT_LENGTH = 200;
export const MAX_CUSTOM_NAME_LENGTH = 120;

// Upper bound on a single bulk (reset/delete) request's pageKeys array. Far
// above any realistic saved-page count, but bounded so a malformed or hostile
// options-page payload can never enqueue unbounded work in the service worker.
export const MAX_BULK_PAGE_KEYS = 1000;
export const MIN_GAIN_PERCENT = 0;
// GainNode gain is gainPercent/100, so 100% = 1.0, 200% = 2.0, 300% = 3.0.
// There is no compressor/limiter anywhere - gain above 100% is plain
// multiplication and can clip/distort; the UI keeps that warning.
export const MAX_GAIN_PERCENT = 300;

// How long the service worker waits for a response from the offscreen
// document before treating it as ambiguous/hung, both during emergency
// fail-closed cleanup and while confirming an operation-scoped teardown
// after a failed/ambiguous capture start.
export const OFFSCREEN_RESPONSE_TIMEOUT_MS = 1500;

// How long the service worker waits for an injected page-audio frame bridge
// to answer before treating that frame as unreachable. A page that never
// replies must never leave an Enable click hanging.
export const PAGE_AUDIO_RESPONSE_TIMEOUT_MS = 2000;

// How long the offscreen document may sit with no active or pending
// compatibility work before it is closed. Debounced, and always re-checked
// against authoritative state immediately before the close actually runs.
export const OFFSCREEN_IDLE_CLOSE_MS = 10000;

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'settings',
  SAVED_PAGES: 'savedPages',
  // Schema-4's storage key, read only during the one-time schema-4 ->
  // schema-5 migration in shared/settings.js - never written again.
  LEGACY_ALLOWED_PAGES: 'allowedPages',
});

// Schema 6 stores each saved page as a RECORD:
//   { volumePercent, titleSnapshot, customName }
// rather than schema 5's bare number. titleSnapshot/customName are local-only
// display metadata - see shared/saved-page-metadata.js.
export const SCHEMA_VERSION = 6;
export const LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES = 4;
// Schema 5's savedPages map: { pageKey: volumePercent } - migrated in place to
// schema-6 records (volume preserved, metadata fields empty).
export const LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES = 5;

export const OFFSCREEN_DOCUMENT_PATH = 'offscreen/offscreen.html';
export const SERVICE_WORKER_SCRIPT_PATH = 'service-worker.js';
export const POPUP_PATH = 'popup/popup.html';
export const OPTIONS_PATH = 'options/options.html';

export const RESTRICTED_HOSTNAMES = Object.freeze([
  'chromewebstore.google.com',
]);

// hostname + required path prefix, for restricted origins that are only
// restricted under a specific path (legacy Chrome Web Store URL).
export const RESTRICTED_HOSTNAME_PATH_PREFIXES = Object.freeze([
  { hostname: 'chrome.google.com', pathPrefix: '/webstore' },
]);
