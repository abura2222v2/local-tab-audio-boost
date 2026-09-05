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

import {
  STORAGE_KEYS,
  SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES,
  LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES,
  DEFAULT_VOLUME_PERCENT,
} from './constants.js';
import { normalizeSavedPages } from './validation.js';
import { createSavedPageRecord, sanitizeTitleSnapshot, sanitizeCustomName } from './saved-page-metadata.js';

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
 * Migrates a legacy install into schema 6, preserving every valid canonical
 * exact pageKey and its valid percentage. `sourceKey` is where the legacy map
 * lives:
 *   - schema 4: the `allowedPages` key, values are numbers;
 *   - schema 5: the current `savedPages` key, values are numbers.
 * Both are folded through the one normalizeSavedPages implementation, which
 * turns a bare number into a full schema-6 record `{volumePercent,
 * titleSnapshot: '', customName: ''}` and drops anything malformed or
 * uncanonical (see its doc comment, and normalizeSavedPageRecord's).
 *
 * The new schema is written FIRST, in a single set() carrying both the new
 * settings version and the migrated map; only after that write succeeds is the
 * legacy allowedPages key removed. If the write throws, nothing is deleted and
 * schemaInitPromise is cleared, so a later caller retries the migration from
 * the still-intact original data rather than losing it.
 */
async function migrateLegacyToSchema6(sourceKey) {
  const legacyMap = await readRaw(sourceKey, {});
  const migrated = normalizeSavedPages(legacyMap);
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
        // prior migration that wrote schema-6 but crashed before cleanup).
        // Remove it if present; never re-write settings/savedPages.
        await removeLegacyAllowedPagesIfPresent();
        return;
      }
      if (settings && settings.schemaVersion === LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES) {
        // Schema 5 -> 6: the savedPages key already holds canonical exact
        // URLs, but each value is a bare number. Every valid volume is
        // preserved; titleSnapshot/customName start empty.
        await migrateLegacyToSchema6(STORAGE_KEYS.SAVED_PAGES);
        return;
      }
      if (settings && settings.schemaVersion === LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES) {
        // Schema 4 -> 6, straight through: the legacy allowedPages map is
        // numeric exactly like schema 5's, so it needs no intermediate hop.
        await migrateLegacyToSchema6(STORAGE_KEYS.LEGACY_ALLOWED_PAGES);
        return;
      }
      // No recognized prior schema (fresh install, or anything else
      // unrecognized/malformed) - reset to empty schema-6 defaults, exactly
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

/**
 * In-process cache of the last known-good normalized savedPages map, valid
 * for the lifetime of this module instance (cleared implicitly by a service-
 * worker restart, which gets a fresh module realm). This module is the ONLY
 * writer of chrome.storage.local's savedPages key in the whole extension
 * (see the file-level comment), so nothing outside writeSavedPages below can
 * ever invalidate it - caching is safe precisely because that invariant
 * holds. Without this, every single read (GET_TAB_STATE on every popup open,
 * GET_SAVED_PAGES, the auto-resume check on every navigation, every bulk
 * per-page operation) re-ran normalizeSavedPages - a URL parse plus record
 * validation for EVERY saved page - even when nothing had changed since the
 * last read.
 */
let cachedSavedPages = null;

async function readSavedPages() {
  await ensureSchemaInitialized();
  if (cachedSavedPages === null) {
    cachedSavedPages = normalizeSavedPages(await readRaw(STORAGE_KEYS.SAVED_PAGES, {}));
  }
  // A fresh shallow copy on every call: every mutation function in this
  // module treats the map it gets back as its own private read-modify-write
  // surface (it may delete a key from it, or reassign a key to a brand-new
  // record, before writing the result back) - handing out the literal cached
  // object to more than one caller would let one caller's in-progress edit
  // leak into another's view before either actually commits. Individual
  // record objects are never mutated in place anywhere in this module (a
  // change always replaces a key with a brand-new record via `pages[key] =
  // {...}`), so sharing THOSE by reference between the cache and every copy
  // is safe, and this copy is a cheap O(n) key copy - not a re-normalization.
  return { ...cachedSavedPages };
}

async function writeSavedPages(pages) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SAVED_PAGES]: pages });
  cachedSavedPages = pages;
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
 * Adds (or refreshes the metadata of) one saved page.
 *
 * Volume is idempotent exactly as before: saving an already-saved page
 * preserves its existing volume rather than overwriting it with
 * `volumePercent`, which is what makes a concurrent duplicate save (e.g. two
 * Add-URL-manually submissions for the identical URL) never clobber a value
 * someone else already committed.
 *
 * Metadata follows schema-6's ownership rules, and is the reason this can
 * write even when the page already exists:
 *  - `titleSnapshot` is refreshed whenever the caller supplies a non-empty one
 *    ("Add this page" re-reads the live tab title). A manual add never supplies
 *    one, so an existing snapshot is preserved.
 *  - `customName` is applied only when the caller supplies a non-empty one, so
 *    an existing user-chosen name always survives a re-save. It is never
 *    cleared here - clearing is exclusively RENAME_SAVED_PAGE's job.
 * The read-modify-write runs inside the shared serialized mutation queue and
 * re-reads authoritative storage first, so it can never resurrect a stale
 * snapshot over a concurrent rename/volume update/delete.
 */
export function addSavedPage(pageKey, volumePercent, metadata = {}) {
  return enqueueMutation(async () => {
    const pages = await readSavedPages();
    const existing = pages[pageKey];
    const incomingTitle = sanitizeTitleSnapshot(metadata.titleSnapshot);
    const incomingName = sanitizeCustomName(metadata.customName);

    const nextVolume = existing ? existing.volumePercent : volumePercent;
    const nextTitle = incomingTitle || (existing ? existing.titleSnapshot : '');
    const nextName = incomingName || (existing ? existing.customName : '');

    const record = createSavedPageRecord({
      volumePercent: nextVolume,
      titleSnapshot: nextTitle,
      customName: nextName,
    });
    if (record === null) {
      return { pageKey, volumePercent: existing ? existing.volumePercent : null, aborted: true, code: 'INVALID_VOLUME' };
    }

    const unchanged =
      existing &&
      existing.volumePercent === record.volumePercent &&
      existing.titleSnapshot === record.titleSnapshot &&
      existing.customName === record.customName;
    if (!unchanged) {
      pages[pageKey] = record;
      await writeSavedPages(pages);
    }
    return { pageKey, volumePercent: record.volumePercent, titleSnapshot: record.titleSnapshot, customName: record.customName };
  });
}

/**
 * Sets one saved page's local `customName` override, and nothing else.
 * `pageKey`, `volumePercent`, and `titleSnapshot` are all carried through
 * untouched, so a rename can never move a page, change its audio, or discard
 * its captured title. An empty (or whitespace-only) name clears the override,
 * after which the display name falls back to titleSnapshot, then to a locally
 * derived URL label.
 *
 * Never creates a missing entry: renaming a page that was deleted (or cleared)
 * in the meantime is a structured no-op, not a resurrection.
 */
export function renameSavedPage(pageKey, customName) {
  return enqueueMutation(async () => {
    const pages = await readSavedPages();
    const existing = pages[pageKey];
    if (!existing) {
      return { aborted: true, code: 'PAGE_NOT_SAVED', pageKey };
    }
    const nextName = sanitizeCustomName(customName);
    if (existing.customName === nextName) {
      return { aborted: false, pageKey, customName: nextName };
    }
    pages[pageKey] = {
      volumePercent: existing.volumePercent,
      titleSnapshot: existing.titleSnapshot,
      customName: nextName,
    };
    await writeSavedPages(pages);
    return { aborted: false, pageKey, customName: nextName };
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

/**
 * Batch removal for bulk Delete selected: one read-modify-write for the
 * WHOLE list, inside a single mutation-queue turn, instead of one
 * chrome.storage.local round trip per pageKey. The caller has already
 * decided (via confirmed session teardown, per pageKey) which of these are
 * actually safe to remove - this never re-derives that decision, it only
 * removes exactly the keys it is given. Idempotent per key, exactly like
 * removeSavedPage: a key that is absent, or appears more than once, is a
 * harmless no-op for that key. Writes storage at most once, and only if at
 * least one given key actually existed.
 */
export function removeSavedPages(pageKeys) {
  return enqueueMutation(async () => {
    const pages = await readSavedPages();
    const removed = new Set();
    for (const pageKey of pageKeys) {
      if (pageKey in pages) {
        delete pages[pageKey];
        removed.add(pageKey);
      }
    }
    if (removed.size > 0) {
      await writeSavedPages(pages);
    }
    return { removed };
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
/**
 * Batch version of persistExistingVolumeIfPreconditionHolds for bulk "Reset
 * selected to 100%": writes the SAME volumePercent to every given pageKey
 * that is already saved, in one read-modify-write inside a single
 * mutation-queue turn, instead of one chrome.storage.local round trip per
 * page. There is no per-page precondition here (the caller - resetting
 * every selected page to 100% - has none beyond "still saved"; the
 * per-tab live-gain confirmation that DOES need a precondition happens
 * separately, before this is ever called, via applyConfirmedGainToSession).
 * A pageKey that is not currently saved is simply left out of `updated` -
 * never resurrected, exactly like the single-page function's PAGE_NOT_SAVED
 * outcome. Writes storage at most once, and only if at least one given
 * pageKey actually existed.
 */
export function persistVolumesIfSaved(pageKeys, volumePercent) {
  return enqueueMutation(async () => {
    const pages = await readSavedPages();
    const updated = new Set();
    for (const pageKey of pageKeys) {
      const existing = pages[pageKey];
      if (existing) {
        pages[pageKey] = { ...existing, volumePercent };
        updated.add(pageKey);
      }
    }
    if (updated.size > 0) {
      await writeSavedPages(pages);
    }
    return { updated };
  });
}

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
    // Record-level update: ONLY volumePercent changes. titleSnapshot and
    // customName are carried through from the authoritative record just read,
    // so a volume commit can never discard a concurrent rename's name or a
    // captured title.
    const previousRecord = pages[pageKey];
    const previousVolumePercent = previousRecord.volumePercent;
    pages[pageKey] = { ...previousRecord, volumePercent };
    await writeSavedPages(pages);
    // The precondition can ALSO become false while this very write was in
    // flight (e.g. a real, paused chrome.storage.local.set call) - nothing
    // else can have mutated storage in that window (every mutation is
    // serialized through this same queue), so `pages` in memory is still
    // an accurate reflection of what was just written, and compensating by
    // restoring the previous value directly (no re-read needed) is safe
    // and stays inside this same queue turn.
    if (!precondition()) {
      pages[pageKey] = { ...previousRecord, volumePercent: previousVolumePercent };
      await writeSavedPages(pages);
      return { aborted: true, code: 'PRECONDITION_FAILED' };
    }
    return { aborted: false, pageKey, volumePercent };
  });
}

/**
 * Test-only: resets internal singleton state (the schema-initialization
 * gate, the mutation queue, and the normalized-savedPages cache) between
 * test runs. Not called by any extension context - only by
 * tests/storage-logic.test.js and tests/service-worker-logic.test.js, so
 * each test can rely on a fresh "first service-worker instance" view of
 * storage rather than seeing another test's cached savedPages.
 */
export function __resetForTests() {
  schemaInitPromise = null;
  mutationQueue = Promise.resolve();
  cachedSavedPages = null;
}
