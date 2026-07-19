// The only module in this codebase that reads/writes chrome.storage.local.
// Imported only by service-worker.js - the popup and options page never
// call chrome.storage.local.set directly; every mutation goes through the
// message handlers in service-worker.js, which call the functions here.
//
// Saving a page here is a stored PREFERENCE (its exact URL plus a
// preferred gain percentage) - never a capture permission. Nothing in this
// module, or in service-worker.js's START_CAPTURE handling, treats
// savedPages membership as a precondition for starting a temporary
// capture session. See README.md/SECURITY.md for the full product model.

import { STORAGE_KEYS, SCHEMA_VERSION, LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES, DEFAULT_VOLUME_PERCENT } from './constants.js';
import { normalizeSavedPages } from './validation.js';

// A minimal, zero-dependency in-process promise chain that serializes every
// storage mutation relative to every other one, within the current
// service-worker instance. Not durable across a restart - a restart means
// nothing could have survived mid-flight anyway, and every mutation's
// *result* is already durably written to chrome.storage.local by the time
// it resolves.
let mutationQueue = Promise.resolve();

export function enqueueMutation(run) {
  const result = mutationQueue.then(run, run);
  // A rejection must not wedge the queue for whatever comes after it.
  mutationQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

/** Restricts chrome.storage.local to trusted extension contexts only. */
export async function ensureStorageHardened() {
  if (chrome?.storage?.local?.setAccessLevel) {
    try {
      await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    } catch (err) {
      console.warn('chrome.storage.local.setAccessLevel unsupported or failed:', err?.message ?? err);
    }
  }
}

async function readRaw(key, fallback) {
  const result = await chrome.storage.local.get(key);
  return Object.prototype.hasOwnProperty.call(result, key) ? result[key] : fallback;
}

/**
 * A single, shared, in-flight (then cached-resolved) initialization
 * Promise. Every read and every mutation awaits this exact Promise before
 * touching storage, so the first-run schema reset/migration always fully
 * completes before anything else observes or writes savedPages - no
 * matter how many callers race to be "first." A failed attempt clears the
 * Promise so a later caller can retry; a succeeded attempt is never
 * repeated for the lifetime of this module instance.
 */
let schemaInitPromise = null;

/**
 * Best-effort deletion of the schema-4 exact-URL map, once it is no longer
 * needed. Only issues a chrome.storage.local.remove when the legacy key is
 * actually still present, so it never performs a redundant write on a clean
 * schema-5 profile. Always safe to call - a leftover legacy key (e.g. from a
 * prior migration that wrote schema-5 but crashed before cleanup) is removed
 * the next time initialization runs.
 */
async function removeLegacyAllowedPagesIfPresent() {
  const legacy = await readRaw(STORAGE_KEYS.LEGACY_ALLOWED_PAGES, undefined);
  if (legacy === undefined) return;
  if (chrome?.storage?.local?.remove) {
    await chrome.storage.local.remove(STORAGE_KEYS.LEGACY_ALLOWED_PAGES);
  }
}

/**
 * Migrates a schema-4 install (an `allowedPages` map at the legacy storage
 * key) into schema-5's `savedPages` map, preserving every valid canonical
 * exact pageKey and its valid percentage (normalizeSavedPages drops anything
 * malformed/uncanonical - see its own doc comment). The new schema is
 * written FIRST; only after that write succeeds is the legacy key removed.
 * If the schema-5 write throws, the legacy key is left intact so a later
 * caller retries the migration from scratch rather than losing the data.
 */
async function migrateSchema4ToSchema5() {
  const legacyAllowedPages = await readRaw(STORAGE_KEYS.LEGACY_ALLOWED_PAGES, {});
  const migrated = normalizeSavedPages(legacyAllowedPages);
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: migrated,
  });
  await removeLegacyAllowedPagesIfPresent();
}

function ensureSchemaInitialized() {
  if (!schemaInitPromise) {
    schemaInitPromise = (async () => {
      const settings = await readRaw(STORAGE_KEYS.SETTINGS, null);
      if (settings && settings.schemaVersion === SCHEMA_VERSION) {
        // Already current - but a stray legacy key may still linger (e.g. a
        // prior migration that wrote schema-5 but crashed before cleanup).
        // Remove it if present; never re-write settings/savedPages.
        await removeLegacyAllowedPagesIfPresent();
        return;
      }
      if (settings && settings.schemaVersion === LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES) {
        await migrateSchema4ToSchema5();
        return;
      }
      // No recognized prior schema (fresh install, or anything else
      // unrecognized/malformed) - reset to empty schema-5 defaults, exactly
      // like the pre-migration behavior did for any non-matching version,
      // and drop any stray legacy key alongside it.
      await chrome.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
        [STORAGE_KEYS.SAVED_PAGES]: {},
      });
      await removeLegacyAllowedPagesIfPresent();
    })();
    // Detach a side-effect-only observer that resets the module state on
    // failure, without swallowing the rejection for real awaiters of
    // schemaInitPromise itself.
    schemaInitPromise.catch(() => {
      schemaInitPromise = null;
    });
  }
  return schemaInitPromise;
}

async function readSavedPages() {
  await ensureSchemaInitialized();
  return normalizeSavedPages(await readRaw(STORAGE_KEYS.SAVED_PAGES, {}));
}

async function writeSavedPages(pages) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SAVED_PAGES]: pages });
}

export async function getSettings() {
  await ensureSchemaInitialized();
  return readRaw(STORAGE_KEYS.SETTINGS, { schemaVersion: SCHEMA_VERSION });
}

/** Read-only snapshot of the currently saved pages. Not queued - reads never conflict. */
export async function getSavedPages() {
  return readSavedPages();
}

/**
 * Idempotent: saving an already-saved page preserves its existing volume
 * rather than overwriting it with `volumePercent` - this is what makes a
 * concurrent duplicate save (e.g. two Add-URL-manually submissions for the
 * identical URL) never clobber a value someone else already committed.
 */
export function addSavedPage(pageKey, volumePercent) {
  return enqueueMutation(async () => {
    const pages = await readSavedPages();
    if (!(pageKey in pages)) {
      pages[pageKey] = volumePercent;
      await writeSavedPages(pages);
    }
    return { pageKey, volumePercent: pages[pageKey] };
  });
}

/** Idempotent: removing an absent page is a successful no-op. */
export function removeSavedPage(pageKey) {
  return enqueueMutation(async () => {
    const pages = await readSavedPages();
    const existed = pageKey in pages;
    if (existed) {
      delete pages[pageKey];
      await writeSavedPages(pages);
    }
    return { pageKey, removed: existed };
  });
}

/** Idempotent: clearing an already-empty list is a successful no-op. */
export function clearSavedPages() {
  return enqueueMutation(async () => {
    // Unlike addSavedPage/removeSavedPage/persist*, this never reads the
    // existing savedPages value first (it always writes {} regardless), so
    // it had no other reason to await schema initialization - but skipping
    // the gate still meant a Clear-all racing the very first schema-init
    // write could land before or after it unpredictably. Awaiting it here
    // makes ordering deterministic like every other mutation.
    await ensureSchemaInitialized();
    await writeSavedPages({});
    // Clear all wipes every persisted exact-URL preference - that must
    // include any stray schema-4 URL map, not only the schema-5 one.
    await removeLegacyAllowedPagesIfPresent();
    return {};
  });
}

/**
 * Persists a volume for a page that must ALREADY be saved. Never creates a
 * missing entry - this is what makes a delayed PERSIST_PAGE_VOLUME message
 * (arriving after the page was removed, Clear all, or a navigation to a
 * different page) or an UPDATE_SAVED_PAGE_VOLUME for a since-deleted page a
 * harmless no-op instead of silently re-adding a page nobody currently
 * intends to keep saved.
 *
 * `precondition` is a synchronous callback checked at the start of this
 * mutation's queue turn - immediately before any read or write, not before
 * this call was enqueued and not only after it completes. Typical use: the
 * caller captures a session's operationId/state/pageKey before calling
 * this, and the precondition re-verifies all three are still current at
 * write time. A tab-independent caller (e.g. the saved-pages view's own
 * UPDATE_SAVED_PAGE_VOLUME, which is not scoped to any one tab) may simply
 * pass `() => true`.
 *
 * Returns:
 *  - { aborted: true, code: 'PRECONDITION_FAILED' } if the precondition itself failed;
 *  - { aborted: true, code: 'PAGE_NOT_SAVED' } if the key does not exist in savedPages;
 *  - { aborted: false, pageKey, volumePercent } on a successful update.
 */
export function persistExistingVolumeIfPreconditionHolds(pageKey, volumePercent, precondition) {
  return enqueueMutation(async () => {
    // Re-checked after every asynchronous boundary this turn crosses - the
    // caller's Session state can change while an await is in flight, even
    // inside this single serialized queue turn (the await is itself the gap;
    // nothing else can run storage-mutating code concurrently, but the
    // *caller's* own in-memory state, e.g. the service worker's per-tab
    // cache, is not owned by this queue at all).
    if (!precondition()) {
      return { aborted: true, code: 'PRECONDITION_FAILED' };
    }
    const pages = await readSavedPages();
    if (!precondition()) {
      return { aborted: true, code: 'PRECONDITION_FAILED' };
    }
    if (!(pageKey in pages)) {
      return { aborted: true, code: 'PAGE_NOT_SAVED' };
    }
    if (!precondition()) {
      return { aborted: true, code: 'PRECONDITION_FAILED' };
    }
    const previousVolumePercent = pages[pageKey];
    pages[pageKey] = volumePercent;
    await writeSavedPages(pages);
    // The precondition can ALSO become false while this very write was in
    // flight (e.g. a real, paused chrome.storage.local.set call) - nothing
    // else can have mutated storage in that window (every mutation is
    // serialized through this same queue), so `pages` in memory is still
    // an accurate reflection of what was just written, and compensating by
    // restoring the previous value directly (no re-read needed) is safe
    // and stays inside this same queue turn.
    if (!precondition()) {
      pages[pageKey] = previousVolumePercent;
      await writeSavedPages(pages);
      return { aborted: true, code: 'PRECONDITION_FAILED' };
    }
    return { aborted: false, pageKey, volumePercent };
  });
}

/**
 * Test-only: resets internal singleton state (the schema-initialization
 * gate and the mutation queue) between test runs. Not called by any
 * extension context - only by tests/storage-logic.test.js and
 * tests/service-worker-logic.test.js, so each test can rely on a fresh
 * "first service-worker instance" view of storage.
 */
export function __resetForTests() {
  schemaInitPromise = null;
  mutationQueue = Promise.resolve();
}
