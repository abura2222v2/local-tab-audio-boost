// Exercises shared/settings.js's real serialized-mutation-queue and
// schema-initialization/migration code against a minimal in-memory
// chrome.storage.local stub - no real Chrome needed.
//
// Product-model note: a saved page is a stored preference (its exact URL
// plus a preferred gain percentage), never a capture permission - none of
// these tests exercise or depend on any capture-gating behavior.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as settings from '../shared/settings.js';
import {
  STORAGE_KEYS,
  SCHEMA_VERSION,
  LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES,
  LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES,
  DEFAULT_VOLUME_PERCENT,
} from '../shared/constants.js';

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


function installChromeStub(initial = {}) {
  let store = { ...initial };
  const removedKeys = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          store = { ...store, ...obj };
        },
        async remove(key) {
          removedKeys.push(key);
          const next = { ...store };
          delete next[key];
          store = next;
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  // Each test gets a fresh "first service-worker instance" view: the
  // module-level schema-initialization gate and mutation queue are reset,
  // not just the backing store, otherwise only the very first test in this
  // file would ever exercise first-run schema initialization.
  settings.__resetForTests();
  const accessor = () => store;
  accessor.removedKeys = removedKeys;
  return accessor;
}

/**
 * Same as installChromeStub, but chrome.storage.local.get can be paused on
 * demand - used to prove the precondition-recheck-after-every-async-boundary
 * behavior required by persistExistingVolumeIfPreconditionHolds: something
 * must be able to change the precondition's underlying state *while*
 * readSavedPages()'s own chrome.storage.local.get call is still in flight.
 */
function installPausableChromeStub(initial = {}) {
  let store = { ...initial };
  let gate = null; // Promise|null - when set, every get() call awaits it once
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (gate) await gate;
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          store = { ...store, ...obj };
        },
        async remove(key) {
          const next = { ...store };
          delete next[key];
          store = next;
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();
  return {
    getStore: () => store,
    pauseGet() {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        gate = null;
      };
    },
  };
}

function tick(ms = 20) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Same as installPausableChromeStub, but chrome.storage.local.SET can be
 * paused on demand instead of .get - used to prove that a precondition
 * becoming false while writeSavedPages()'s own chrome.storage.local.set
 * call is still in flight must be re-checked AFTER that write resolves
 * too, and compensated for - not merely checked once before the write
 * began (which pauseGet-based tests, above, cannot exercise, since by the
 * time .set() is ever called the precondition has already been re-checked
 * past that point).
 */
function installSetPausableChromeStub(initial = {}) {
  let store = { ...initial };
  let gate = null; // Promise|null - when set, every set() call awaits it once
  const setCalls = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          if (gate) await gate;
          setCalls.push(obj);
          store = { ...store, ...obj };
        },
        async remove(key) {
          const next = { ...store };
          delete next[key];
          store = next;
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();
  return {
    getStore: () => store,
    setCalls,
    pauseSet() {
      let release;
      gate = new Promise((resolve) => {
        release = resolve;
      });
      return () => {
        release();
        gate = null;
      };
    },
  };
}

test('two concurrent additions of different pages both survive', async () => {
  installChromeStub();
  await Promise.all([
    settings.addSavedPage('https://a.example/', DEFAULT_VOLUME_PERCENT),
    settings.addSavedPage('https://b.example/', DEFAULT_VOLUME_PERCENT),
  ]);
  const pages = await savedVolumes();
  assert.deepEqual(pages, {
    'https://a.example/': DEFAULT_VOLUME_PERCENT,
    'https://b.example/': DEFAULT_VOLUME_PERCENT,
  });
});

test('an addition and a removal racing on different pages never clobber one another', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://existing.example/': 80 },
  });
  await Promise.all([
    settings.addSavedPage('https://new.example/', DEFAULT_VOLUME_PERCENT),
    settings.removeSavedPage('https://existing.example/'),
  ]);
  const pages = await savedVolumes();
  assert.deepEqual(pages, { 'https://new.example/': DEFAULT_VOLUME_PERCENT });
});

test('persist and clear are serialized relative to each other, never producing a mixed state', async () => {
  installChromeStub();
  await settings.addSavedPage('https://x.example/', DEFAULT_VOLUME_PERCENT);
  await Promise.all([
    settings.persistExistingVolumeIfPreconditionHolds('https://x.example/', 150, () => true),
    settings.clearSavedPages(),
  ]);
  const pages = await savedVolumes();
  const isFullyCleared = Object.keys(pages).length === 0;
  const isPersistedThenNotCleared = pages['https://x.example/'] === 150;
  assert.ok(isFullyCleared || isPersistedThenNotCleared);
});

test('duplicate save is idempotent and preserves the already-saved volume', async () => {
  installChromeStub();
  await settings.addSavedPage('https://y.example/', DEFAULT_VOLUME_PERCENT);
  await settings.persistExistingVolumeIfPreconditionHolds('https://y.example/', 175, () => true);
  await settings.addSavedPage('https://y.example/', DEFAULT_VOLUME_PERCENT);
  const pages = await savedVolumes();
  assert.equal(pages['https://y.example/'], 175);
});

test('getSavedPages: a second read is served from the in-process cache, never touching storage again', async () => {
  let getCalls = 0;
  let store = {
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://cache-hit.example/': { volumePercent: 150, titleSnapshot: '', customName: '' },
    },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          getCalls += 1;
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          store = { ...store, ...obj };
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();

  await settings.getSavedPages();
  const callsAfterFirstRead = getCalls;
  assert.ok(callsAfterFirstRead > 0, 'the first read genuinely touches storage');

  await settings.getSavedPages();
  await settings.getSavedPages();
  assert.equal(getCalls, callsAfterFirstRead, 'subsequent reads are served from the cache, not from storage');

  // A write still invalidates/refreshes the cache with the new value - the
  // very next read reflects it without needing another storage.get at all.
  await settings.addSavedPage('https://cache-hit-2.example/', DEFAULT_VOLUME_PERCENT);
  const pages = await settings.getSavedPages();
  assert.equal(getCalls, callsAfterFirstRead, 'the write path never calls storage.get either');
  assert.ok('https://cache-hit-2.example/' in pages, 'the cache reflects the write immediately');
});

test('getSavedPages: the returned map is a private copy - mutating it never corrupts the cache for the next caller', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://isolated.example/': { volumePercent: 150, titleSnapshot: '', customName: '' },
    },
  });

  const first = await settings.getSavedPages();
  delete first['https://isolated.example/'];
  first['https://injected.example/'] = { volumePercent: 999, titleSnapshot: '', customName: '' };

  const second = await settings.getSavedPages();
  assert.ok('https://isolated.example/' in second, 'a deletion on one caller\'s copy never affects another read');
  assert.equal('https://injected.example/' in second, false, 'an addition on one caller\'s copy never leaks into another read');
});

test('duplicate remove is idempotent', async () => {
  installChromeStub();
  await settings.addSavedPage('https://z.example/', DEFAULT_VOLUME_PERCENT);
  const first = await settings.removeSavedPage('https://z.example/');
  const second = await settings.removeSavedPage('https://z.example/');
  assert.equal(first.removed, true);
  assert.equal(second.removed, false);
});

test('removeSavedPages: batch-removes exactly the given keys in one write, leaving others untouched', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://batch-a.example/', DEFAULT_VOLUME_PERCENT);
  await settings.addSavedPage('https://batch-b.example/', DEFAULT_VOLUME_PERCENT);
  await settings.addSavedPage('https://batch-keep.example/', DEFAULT_VOLUME_PERCENT);

  const setCallsBefore = stub.setCalls.length;
  const { removed } = await settings.removeSavedPages(['https://batch-a.example/', 'https://batch-b.example/']);
  assert.deepEqual([...removed].sort(), ['https://batch-a.example/', 'https://batch-b.example/']);
  assert.equal(stub.setCalls.length, setCallsBefore + 1, 'one write for the whole batch, not one per key');

  const pages = await savedVolumes();
  assert.deepEqual(Object.keys(pages), ['https://batch-keep.example/']);
});

test('removeSavedPages: an absent or duplicated key is a harmless no-op for that key', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://batch-only.example/', DEFAULT_VOLUME_PERCENT);

  const setCallsBefore = stub.setCalls.length;
  const { removed } = await settings.removeSavedPages([
    'https://batch-only.example/',
    'https://batch-missing.example/',
    'https://batch-only.example/',
  ]);
  assert.deepEqual([...removed], ['https://batch-only.example/']);
  assert.equal(stub.setCalls.length, setCallsBefore + 1);

  // Removing a batch that matches nothing at all writes nothing.
  const result = await settings.removeSavedPages(['https://nothing-here.example/']);
  assert.deepEqual([...result.removed], []);
  assert.equal(stub.setCalls.length, setCallsBefore + 1, 'no write when nothing in the batch existed');
});

test('persistVolumesIfSaved: writes the same volume to every already-saved key in one write, skipping unsaved ones', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://reset-a.example/', 250);
  await settings.addSavedPage('https://reset-b.example/', 300);
  await settings.addSavedPage('https://reset-keep.example/', 150);

  const setCallsBefore = stub.setCalls.length;
  const { updated } = await settings.persistVolumesIfSaved(
    ['https://reset-a.example/', 'https://reset-b.example/', 'https://reset-missing.example/'],
    100
  );
  assert.deepEqual([...updated].sort(), ['https://reset-a.example/', 'https://reset-b.example/']);
  assert.equal(stub.setCalls.length, setCallsBefore + 1, 'one write for the whole batch');

  const volumes = await savedVolumes();
  assert.equal(volumes['https://reset-a.example/'], 100);
  assert.equal(volumes['https://reset-b.example/'], 100);
  assert.equal(volumes['https://reset-keep.example/'], 150, 'an unselected page is untouched');
});

test('persistVolumesIfSaved: a batch matching nothing saved writes nothing', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://reset-untouched.example/', 200);

  const setCallsBefore = stub.setCalls.length;
  const { updated } = await settings.persistVolumesIfSaved(['https://reset-nothing.example/'], 100);
  assert.deepEqual([...updated], []);
  assert.equal(stub.setCalls.length, setCallsBefore, 'no write when nothing in the batch was saved');

  const volumes = await savedVolumes();
  assert.equal(volumes['https://reset-untouched.example/'], 200, 'unrelated saved page is untouched');
});

test('importSavedPages: writes every given {pageKey, record} pair in one write, overwriting an existing record', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://import-existing.example/', 150);

  const setCallsBefore = stub.setCalls.length;
  const { imported } = await settings.importSavedPages([
    { pageKey: 'https://import-existing.example/', record: { volumePercent: 200, titleSnapshot: 'T', customName: 'N' } },
    { pageKey: 'https://import-new.example/', record: { volumePercent: 250, titleSnapshot: '', customName: '' } },
  ]);
  assert.deepEqual([...imported].sort(), ['https://import-existing.example/', 'https://import-new.example/']);
  assert.equal(stub.setCalls.length, setCallsBefore + 1, 'one write for the whole batch');

  const pages = await settings.getSavedPages();
  assert.deepEqual(pages['https://import-existing.example/'], { volumePercent: 200, titleSnapshot: 'T', customName: 'N' });
  assert.deepEqual(pages['https://import-new.example/'], { volumePercent: 250, titleSnapshot: '', customName: '' });
});

test('importSavedPages: an empty batch writes nothing', async () => {
  const stub = installSetPausableChromeStub();
  await settings.getSavedPages(); // warm up schema init (a fresh install writes its own defaults once)
  const setCallsBefore = stub.setCalls.length;
  const { imported } = await settings.importSavedPages([]);
  assert.equal(imported.size, 0);
  assert.equal(stub.setCalls.length, setCallsBefore, 'no write for an empty batch');
});

test('duplicate persist is idempotent', async () => {
  installChromeStub();
  await settings.addSavedPage('https://w.example/', DEFAULT_VOLUME_PERCENT);
  await settings.persistExistingVolumeIfPreconditionHolds('https://w.example/', 120, () => true);
  await settings.persistExistingVolumeIfPreconditionHolds('https://w.example/', 120, () => true);
  const pages = await savedVolumes();
  assert.equal(pages['https://w.example/'], 120);
});

test('clearing an already-empty list is a successful no-op', async () => {
  installChromeStub();
  const result = await settings.clearSavedPages();
  assert.deepEqual(result, {});
  assert.deepEqual(await savedVolumes(), {});
});

test('addSavedPage saves a caller-supplied initial volume for a genuinely new page (e.g. the Add-URL-manually modal)', async () => {
  installChromeStub();
  const result = await settings.addSavedPage('https://manual.example/', 65);
  assert.equal(result.volumePercent, 65);
  const pages = await savedVolumes();
  assert.equal(pages['https://manual.example/'], 65);
});

test('addSavedPage adopts (preserves) a volume saved concurrently by another addSavedPage for the same key', async () => {
  installChromeStub();
  await Promise.all([
    settings.addSavedPage('https://race-save.example/', 150),
    settings.addSavedPage('https://race-save.example/', 30),
  ]);
  const pages = await savedVolumes();
  // Whichever call actually won the race, the loser must adopt that exact
  // value rather than silently overwriting it - so the final value must be
  // one of the two candidates, never some other value.
  assert.ok(pages['https://race-save.example/'] === 150 || pages['https://race-save.example/'] === 30);
});

// ===========================================================================
// Schema-4 -> schema-5 migration (r5 issue #5): preserve every valid exact
// pageKey and its valid percentage from the legacy `allowedPages` key into
// the new `savedPages` key, single-flight and serialized against mutations,
// then DELETE the legacy key once (and only once) the schema-5 write has
// succeeded. A failed schema-5 write leaves the legacy key intact for retry.
// ===========================================================================

test('r5-5: a schema-4 install migrates every valid entry into savedPages and removes the legacy allowedPages key', async () => {
  const getStore = installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES },
    [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]: {
      'https://legacy-a.example/': 150,
      'https://legacy-b.example/': 40,
    },
  });
  const pages = await savedVolumes();
  assert.deepEqual(pages, {
    'https://legacy-a.example/': 150,
    'https://legacy-b.example/': 40,
  });
  const readSettings = await settings.getSettings();
  assert.equal(readSettings.schemaVersion, SCHEMA_VERSION);
  // The legacy exact-URL map is gone from storage entirely.
  assert.equal(STORAGE_KEYS.LEGACY_ALLOWED_PAGES in getStore(), false);
  assert.deepEqual(getStore.removedKeys, [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]);
});

test('r5-5: migration drops malformed/uncanonical legacy entries safely, keeping the valid ones', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES },
    [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]: {
      'https://legacy-valid.example/': 120,
      'https://legacy-out-of-range.example/': 999,
      bad: 'not-a-number',
      'not a URL': 100,
      '': 50,
    },
  });
  const pages = await savedVolumes();
  assert.deepEqual(pages, { 'https://legacy-valid.example/': 120 });
});

test('r5-5: a failed schema-5 write during migration leaves the legacy allowedPages key intact for retry', async () => {
  let store = {
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_ALLOWED_PAGES },
    [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]: { 'https://retry-me.example/': 175 },
  };
  let failNextSet = true;
  let removeCalled = false;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          if (failNextSet) {
            failNextSet = false;
            throw new Error('simulated schema-5 write failure');
          }
          store = { ...store, ...obj };
        },
        async remove(key) {
          removeCalled = true;
          const next = { ...store };
          delete next[key];
          store = next;
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();

  // First attempt: the schema-5 write throws -> the whole init rejects and
  // the legacy key must NOT have been removed.
  await assert.rejects(() => settings.getSavedPages());
  assert.equal(removeCalled, false, 'legacy key must never be removed if the schema-5 write failed');
  assert.equal(STORAGE_KEYS.LEGACY_ALLOWED_PAGES in store, true);

  // A later caller retries from scratch: this time the write succeeds, the
  // data migrates, and only now is the legacy key removed.
  const pages = await savedVolumes();
  assert.deepEqual(pages, { 'https://retry-me.example/': 175 });
  assert.equal(removeCalled, true);
  assert.equal(STORAGE_KEYS.LEGACY_ALLOWED_PAGES in store, false);
});

test('r5-5: an already-current schema-5 profile with a leftover legacy allowedPages key cleans it up (no settings/savedPages re-write)', async () => {
  const getStore = installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://kept.example/': 133 },
    [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]: { 'https://leftover.example/': 90 },
  });
  const pages = await savedVolumes();
  assert.deepEqual(pages, { 'https://kept.example/': 133 });
  assert.equal(STORAGE_KEYS.LEGACY_ALLOWED_PAGES in getStore(), false, 'stray legacy key cleaned up');
  assert.deepEqual(getStore.removedKeys, [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]);
});

test('r5-5: Clear all leaves neither savedPages entries nor a legacy allowedPages map', async () => {
  const getStore = installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://a.example/': 100, 'https://b.example/': 150 },
    [STORAGE_KEYS.LEGACY_ALLOWED_PAGES]: { 'https://ghost.example/': 120 },
  });
  await settings.clearSavedPages();
  assert.deepEqual(await savedVolumes(), {});
  assert.equal(STORAGE_KEYS.LEGACY_ALLOWED_PAGES in getStore(), false);
});

test('a completely empty store (fresh install, no legacy schema-4 data) resets to empty schema-5 defaults', async () => {
  installChromeStub();
  const readSettings = await settings.getSettings();
  assert.equal(readSettings.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(await savedVolumes(), {});
});

test('an unrecognized/malformed stored schemaVersion (neither current nor the one defined legacy version) resets to empty schema-5 defaults', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: 1 },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://stale.example/': 100 },
  });
  const pages = await savedVolumes();
  assert.deepEqual(pages, {});
  const readSettings = await settings.getSettings();
  assert.equal(readSettings.schemaVersion, SCHEMA_VERSION);
});

test('an already-current schema-5 install (no stray legacy key) is left completely untouched (no re-write, no remove)', async () => {
  const getStore = installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://current.example/': 133 },
  });
  const pages = await savedVolumes();
  assert.deepEqual(pages, { 'https://current.example/': 133 });
  assert.deepEqual(getStore.removedKeys, [], 'no legacy key present -> remove is never called');
});

// --- persistExistingVolumeIfPreconditionHolds must never save a page ---

test('persistExistingVolumeIfPreconditionHolds on a missing key does not save it', async () => {
  installChromeStub();
  const result = await settings.persistExistingVolumeIfPreconditionHolds('https://ghost.example/', 150, () => true);
  assert.equal(result.aborted, true);
  assert.equal(result.code, 'PAGE_NOT_SAVED');
  const pages = await savedVolumes();
  assert.equal('https://ghost.example/' in pages, false);
});

test('persistExistingVolumeIfPreconditionHolds is rejected when the precondition itself fails (e.g. a stale operationId)', async () => {
  installChromeStub();
  await settings.addSavedPage('https://guarded.example/', DEFAULT_VOLUME_PERCENT);
  const result = await settings.persistExistingVolumeIfPreconditionHolds('https://guarded.example/', 150, () => false);
  assert.equal(result.aborted, true);
  assert.equal(result.code, 'PRECONDITION_FAILED');
  const pages = await savedVolumes();
  assert.equal(pages['https://guarded.example/'], DEFAULT_VOLUME_PERCENT);
});

test('a delayed persist after Remove does not re-save the page', async () => {
  installChromeStub();
  await settings.addSavedPage('https://removed.example/', DEFAULT_VOLUME_PERCENT);
  await settings.removeSavedPage('https://removed.example/');
  // Simulates a PERSIST_PAGE_VOLUME/UPDATE_SAVED_PAGE_VOLUME message that
  // was in flight before the Remove completed, arriving after it.
  const result = await settings.persistExistingVolumeIfPreconditionHolds('https://removed.example/', 150, () => true);
  assert.equal(result.aborted, true);
  assert.equal(result.code, 'PAGE_NOT_SAVED');
  assert.deepEqual(await savedVolumes(), {});
});

test('a delayed persist after Clear all does not re-save the page', async () => {
  installChromeStub();
  await settings.addSavedPage('https://cleared.example/', DEFAULT_VOLUME_PERCENT);
  await settings.clearSavedPages();
  const result = await settings.persistExistingVolumeIfPreconditionHolds('https://cleared.example/', 150, () => true);
  assert.equal(result.aborted, true);
  assert.equal(result.code, 'PAGE_NOT_SAVED');
  assert.deepEqual(await savedVolumes(), {});
});

test('a valid, active-session persist still updates the value for an already-saved page', async () => {
  installChromeStub();
  await settings.addSavedPage('https://ok.example/', DEFAULT_VOLUME_PERCENT);
  const result = await settings.persistExistingVolumeIfPreconditionHolds('https://ok.example/', 160, () => true);
  assert.equal(result.aborted, false);
  assert.equal(result.volumePercent, 160);
  const pages = await savedVolumes();
  assert.equal(pages['https://ok.example/'], 160);
});

test('updating one saved URL never changes another URL on the same hostname', async () => {
  installChromeStub();
  await settings.addSavedPage('https://shared-host.example/page-a', DEFAULT_VOLUME_PERCENT);
  await settings.addSavedPage('https://shared-host.example/page-b', DEFAULT_VOLUME_PERCENT);
  await settings.persistExistingVolumeIfPreconditionHolds('https://shared-host.example/page-a', 190, () => true);
  const pages = await savedVolumes();
  assert.equal(pages['https://shared-host.example/page-a'], 190);
  assert.equal(pages['https://shared-host.example/page-b'], DEFAULT_VOLUME_PERCENT);
});

// --- Schema initialization must be single-flight and race-free ---

test('a concurrent addSavedPage during a delayed first-run schema initialization preserves the saved page', async () => {
  let releaseDelayedWrite;
  const delayGate = new Promise((resolve) => {
    releaseDelayedWrite = resolve;
  });
  let store = {};
  let setCallCount = 0;
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          setCallCount += 1;
          if (setCallCount === 1) {
            // Pause the very first write - the schema-reset write triggered
            // by the first getSavedPages() call below - until released.
            await delayGate;
          }
          store = { ...store, ...obj };
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();

  const getPromise = settings.getSavedPages(); // starts schema initialization, which is now paused mid-write
  await new Promise((resolve) => setTimeout(resolve, 20)); // let it actually reach the paused write
  const addPromise = settings.addSavedPage('https://race.example/', DEFAULT_VOLUME_PERCENT); // must await the SAME initialization, not run ahead of it

  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseDelayedWrite();

  await Promise.all([getPromise, addPromise]);
  const pages = await savedVolumes();
  assert.deepEqual(pages, { 'https://race.example/': DEFAULT_VOLUME_PERCENT });
});

test('clearSavedPages awaits schema initialization before writing - it never races ahead of a delayed first-run reset', async () => {
  let releaseDelayedWrite;
  const delayGate = new Promise((resolve) => {
    releaseDelayedWrite = resolve;
  });
  let store = {};
  let setCallCount = 0;
  const setCallOrder = [];
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          setCallCount += 1;
          if (setCallCount === 1) {
            // Pause the very first write - the schema-reset write triggered
            // by getSavedPages() below - until released.
            await delayGate;
            setCallOrder.push('schema-init');
          } else {
            setCallOrder.push('clear');
          }
          store = { ...store, ...obj };
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();

  const getPromise = settings.getSavedPages(); // starts schema initialization, paused mid-write
  await new Promise((resolve) => setTimeout(resolve, 20)); // let it actually reach the paused write
  const clearPromise = settings.clearSavedPages(); // must await the SAME initialization, not write ahead of it

  await new Promise((resolve) => setTimeout(resolve, 20));
  releaseDelayedWrite();

  await Promise.all([getPromise, clearPromise]);
  // The schema-reset write must have completed strictly before
  // clearSavedPages's own write - never the other way around.
  assert.deepEqual(setCallOrder, ['schema-init', 'clear']);
  const readSettings = await settings.getSettings();
  assert.equal(readSettings.schemaVersion, SCHEMA_VERSION);
  assert.deepEqual(await savedVolumes(), {});
});

test('schema initialization runs exactly once even under many concurrent first callers', async () => {
  let setCallCount = 0;
  let store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          setCallCount += 1;
          store = { ...store, ...obj };
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();

  await Promise.all([
    settings.getSavedPages(),
    settings.getSavedPages(),
    settings.addSavedPage('https://p1.example/', DEFAULT_VOLUME_PERCENT),
    settings.addSavedPage('https://p2.example/', DEFAULT_VOLUME_PERCENT),
    settings.getSettings(),
  ]);

  // Exactly one schema-reset write, plus one write per addSavedPage call.
  assert.equal(setCallCount, 3);
  const pages = await savedVolumes();
  assert.deepEqual(pages, {
    'https://p1.example/': DEFAULT_VOLUME_PERCENT,
    'https://p2.example/': DEFAULT_VOLUME_PERCENT,
  });
});

test('a failed schema initialization can be retried by a later caller', async () => {
  let attempt = 0;
  let store = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          attempt += 1;
          if (attempt === 1) {
            throw new Error('simulated storage failure');
          }
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          store = { ...store, ...obj };
        },
        async setAccessLevel() {
          return undefined;
        },
      },
    },
  };
  settings.__resetForTests();

  await assert.rejects(() => settings.getSavedPages());
  // The module state must have reset so a later call retries from scratch
  // rather than being permanently wedged.
  const pages = await savedVolumes();
  assert.deepEqual(pages, {});
});

// --- Preconditions must be re-checked after every asynchronous boundary,
// not only once before the read. The caller's own in-memory state (a
// service-worker Session, allowlistRevision) can change while
// readSavedPages()'s chrome.storage.local.get call is in flight. ---

test('persistExistingVolumeIfPreconditionHolds: a precondition that becomes false while storage.get is in flight writes nothing', async () => {
  // Storage is seeded directly (schema already current) rather than via a
  // warm-up addSavedPage() call: readSavedPages() caches its normalized
  // result for the life of the module instance (see shared/settings.js), so
  // a prior successful read/write would make the read below a cache hit -
  // never actually reaching chrome.storage.local.get at all, defeating the
  // whole point of this test. Seeding storage directly, with the cache still
  // cold from __resetForTests(), guarantees the paused get() below is the
  // real, first, in-flight read this test depends on.
  const stub = installPausableChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://race-persist.example/': { volumePercent: DEFAULT_VOLUME_PERCENT, titleSnapshot: '', customName: '' },
    },
  });
  const releaseGet = stub.pauseGet();

  let stillValid = true;
  const resultPromise = settings.persistExistingVolumeIfPreconditionHolds('https://race-persist.example/', 180, () => stillValid);

  await tick(); // let it reach and block inside the paused storage.get
  stillValid = false; // simulates the caller's Session/operationId becoming stale mid-read
  releaseGet();

  const result = await resultPromise;
  assert.equal(result.aborted, true);
  assert.equal(result.code, 'PRECONDITION_FAILED');
  const pages = await savedVolumes();
  assert.equal(pages['https://race-persist.example/'], DEFAULT_VOLUME_PERCENT); // untouched, never bumped to 180
});

// ===========================================================================
// A precondition that becomes false while chrome.storage.local.SET (not
// .get) is genuinely in flight must be re-checked after the write resolves
// too, and compensated for inside the same serialized mutation-queue turn.
// ===========================================================================

test('persistExistingVolumeIfPreconditionHolds: a precondition invalidated while storage.set is in flight restores the previous volume', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://compensate-persist.example/', DEFAULT_VOLUME_PERCENT);
  const releaseSet = stub.pauseSet();

  let stillValid = true;
  const resultPromise = settings.persistExistingVolumeIfPreconditionHolds('https://compensate-persist.example/', 170, () => stillValid);

  await tick();
  stillValid = false; // e.g. Stop/navigation/supersession invalidated this operation mid-write
  releaseSet();

  const result = await resultPromise;
  assert.equal(result.aborted, true);
  const pages = await savedVolumes();
  assert.equal(pages['https://compensate-persist.example/'], DEFAULT_VOLUME_PERCENT, 'restored to the previous value, never left stale at 170');
});

test('a concurrent Add queued behind a compensated persist still succeeds normally afterward', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://compensate-then-add.example/', DEFAULT_VOLUME_PERCENT);
  const releaseSet = stub.pauseSet();

  let stillValid = true;
  const persistPromise = settings.persistExistingVolumeIfPreconditionHolds('https://compensate-then-add.example/', 170, () => stillValid);
  await tick();
  stillValid = false;
  // Enqueued while the compensated operation's turn is still in progress
  // (its own storage.set is paused) - must still run strictly AFTER the
  // compensating write completes, and must still succeed normally.
  const addPromise = settings.addSavedPage('https://queued-after-persist.example/', DEFAULT_VOLUME_PERCENT);
  releaseSet();

  const [persistResult] = await Promise.all([persistPromise, addPromise]);
  assert.equal(persistResult.aborted, true);
  const pages = await savedVolumes();
  assert.equal(pages['https://compensate-then-add.example/'], DEFAULT_VOLUME_PERCENT, 'restored, not left stale');
  assert.equal(pages['https://queued-after-persist.example/'], DEFAULT_VOLUME_PERCENT, 'the queued Add still wins normally');
});

test('Clear-all queued behind a compensated persist still produces an empty saved-pages map', async () => {
  const stub = installSetPausableChromeStub();
  await settings.addSavedPage('https://compensate-then-clear.example/', DEFAULT_VOLUME_PERCENT);
  const releaseSet = stub.pauseSet();

  let stillValid = true;
  const persistPromise = settings.persistExistingVolumeIfPreconditionHolds('https://compensate-then-clear.example/', 190, () => stillValid);
  await tick();
  stillValid = false;
  const clearPromise = settings.clearSavedPages();
  releaseSet();

  const [persistResult] = await Promise.all([persistPromise, clearPromise]);
  assert.equal(persistResult.aborted, true);
  const pages = await savedVolumes();
  assert.deepEqual(pages, {}, 'Clear-all queued behind the compensated persist still produces an empty saved-pages map');
});

// ===========================================================================
// Schema 6: saved pages are stored as RECORDS
// ({volumePercent, titleSnapshot, customName}) rather than bare numbers.
// These tests exercise the schema-5 -> schema-6 migration and the
// record-level mutations (metadata refresh rules, rename) directly against
// the real shared/settings.js storage layer.
// ===========================================================================

test('schema6 #1/#2/#3: a schema-5 numeric entry migrates to a record, preserving the volume, with empty metadata', async () => {
  const getStore = installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://five-a.example/': 209,
      'https://five-b.example/': 40,
    },
  });

  const pages = await settings.getSavedPages();
  assert.deepEqual(pages, {
    'https://five-a.example/': { volumePercent: 209, titleSnapshot: '', customName: '' },
    'https://five-b.example/': { volumePercent: 40, titleSnapshot: '', customName: '' },
  });

  const readSettings = await settings.getSettings();
  assert.equal(readSettings.schemaVersion, SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 6);
  // The migrated records are what is actually persisted, not just what is read back.
  assert.deepEqual(getStore()[STORAGE_KEYS.SAVED_PAGES]['https://five-a.example/'], {
    volumePercent: 209,
    titleSnapshot: '',
    customName: '',
  });
});

test('schema6 #5/#10: schema-5 migration drops invalid URLs and keeps distinct path/query/fragment separate', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://keep.example/one': 100,
      'https://keep.example/two': 110,
      'https://keep.example/one?x=1': 120,
      'https://keep.example/one#frag': 130,
      'not a URL': 100,
      'chrome://settings/': 100,
      'https://user:pass@creds.example/': 100,
      'https://out-of-range.example/': 999,
    },
  });

  assert.deepEqual(await savedVolumes(), {
    'https://keep.example/one': 100,
    'https://keep.example/two': 110,
    'https://keep.example/one?x=1': 120,
    'https://keep.example/one#frag': 130,
  });
});

test('schema6 #4: an existing schema-6 profile with real metadata survives normalization untouched', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://meta.example/': { volumePercent: 175, titleSnapshot: 'A Real Title', customName: 'My Name' },
    },
  });
  assert.deepEqual(await settings.getSavedPages(), {
    'https://meta.example/': { volumePercent: 175, titleSnapshot: 'A Real Title', customName: 'My Name' },
  });
});

test('schema6 #6: invalid metadata types are normalized safely and untrusted extra properties are dropped', async () => {
  installChromeStub({
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: SCHEMA_VERSION },
    [STORAGE_KEYS.SAVED_PAGES]: {
      'https://messy.example/': { volumePercent: 120, titleSnapshot: 99, customName: ['x'], evil: 'payload' },
      'https://broken.example/': { volumePercent: 'loud', titleSnapshot: '', customName: '' },
    },
  });
  const pages = await settings.getSavedPages();
  assert.deepEqual(pages, {
    'https://messy.example/': { volumePercent: 120, titleSnapshot: '', customName: '' },
  });
  assert.equal('evil' in pages['https://messy.example/'], false);
});

test('schema6 #7: a failed schema-5 -> schema-6 write leaves the ORIGINAL numeric data intact and is retryable', async () => {
  let failNextSet = true;
  const store = {
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://retry-six.example/': 165 },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          if (failNextSet) {
            failNextSet = false;
            throw new Error('simulated storage failure');
          }
          Object.assign(store, obj);
        },
        async remove(key) {
          delete store[key];
        },
      },
    },
  };
  settings.__resetForTests();

  await assert.rejects(() => settings.getSavedPages(), /simulated storage failure/);
  // Nothing was destroyed - the original schema-5 numeric map is still there.
  assert.deepEqual(store[STORAGE_KEYS.SAVED_PAGES], { 'https://retry-six.example/': 165 });
  assert.equal(store[STORAGE_KEYS.SETTINGS].schemaVersion, LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES);

  // A later caller retries the migration and succeeds, preserving the volume.
  assert.deepEqual(await settings.getSavedPages(), {
    'https://retry-six.example/': { volumePercent: 165, titleSnapshot: '', customName: '' },
  });
  assert.equal(store[STORAGE_KEYS.SETTINGS].schemaVersion, SCHEMA_VERSION);
});

test('schema6 #8: a schema-5 migration racing many concurrent callers still runs exactly once', async () => {
  let setCalls = 0;
  const store = {
    [STORAGE_KEYS.SETTINGS]: { schemaVersion: LEGACY_SCHEMA_VERSION_WITH_NUMERIC_VOLUMES },
    [STORAGE_KEYS.SAVED_PAGES]: { 'https://single-flight.example/': 155 },
  };
  globalThis.chrome = {
    storage: {
      local: {
        async get(key) {
          if (typeof key === 'string') {
            return Object.prototype.hasOwnProperty.call(store, key) ? { [key]: store[key] } : {};
          }
          return { ...store };
        },
        async set(obj) {
          setCalls += 1;
          Object.assign(store, obj);
        },
        async remove(key) {
          delete store[key];
        },
      },
    },
  };
  settings.__resetForTests();

  const results = await Promise.all([
    settings.getSavedPages(),
    settings.getSavedPages(),
    settings.getSavedPages(),
    settings.addSavedPage('https://concurrent-add.example/', 120),
  ]);
  // Exactly one migration write, plus the one concurrent add's own write.
  assert.equal(setCalls, 2, 'the migration itself wrote exactly once');
  assert.deepEqual(results[0], {
    'https://single-flight.example/': { volumePercent: 155, titleSnapshot: '', customName: '' },
  });
  const final = await settings.getSavedPages();
  assert.equal(final['https://single-flight.example/'].volumePercent, 155, 'the migrated page survived the concurrent add');
  assert.equal(final['https://concurrent-add.example/'].volumePercent, 120);
});

// --- Record-level metadata mutations ---

test('schema6: addSavedPage stores a titleSnapshot and sanitizes it', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://titled.example/', 150, { titleSnapshot: '   My   Great\nPage   ' });
  const pages = await settings.getSavedPages();
  assert.deepEqual(pages['https://titled.example/'], {
    volumePercent: 150,
    titleSnapshot: 'My Great Page',
    customName: '',
  });
});

test('schema6 #14: re-saving refreshes the titleSnapshot but PRESERVES an existing customName', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://refresh.example/', 150, { titleSnapshot: 'Old Title' });
  await settings.renameSavedPage('https://refresh.example/', 'User Chosen');

  // "Add this page" again, with a new live tab title and no customName supplied.
  await settings.addSavedPage('https://refresh.example/', 999, { titleSnapshot: 'New Title' });

  const record = (await settings.getSavedPages())['https://refresh.example/'];
  assert.equal(record.titleSnapshot, 'New Title', 'the snapshot refreshes from the live tab title');
  assert.equal(record.customName, 'User Chosen', 'the user-chosen name survives untouched');
  assert.equal(record.volumePercent, 150, 'volume stays idempotent on a re-save');
});

test('schema6 #15: a manual add stores a customName and leaves titleSnapshot empty', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://manual-named.example/', 175, { customName: '  Movie   Night  ' });
  assert.deepEqual((await settings.getSavedPages())['https://manual-named.example/'], {
    volumePercent: 175,
    titleSnapshot: '',
    customName: 'Movie Night',
  });
});

test('schema6: a manual re-add preserves an existing titleSnapshot and only replaces a supplied name', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://both.example/', 150, { titleSnapshot: 'Captured Title' });
  await settings.addSavedPage('https://both.example/', 150, { customName: 'Manual Name' });
  const record = (await settings.getSavedPages())['https://both.example/'];
  assert.equal(record.titleSnapshot, 'Captured Title', 'the captured title is preserved');
  assert.equal(record.customName, 'Manual Name');

  // An empty name never clears an existing one here - only Rename does that.
  await settings.addSavedPage('https://both.example/', 150, { customName: '' });
  assert.equal((await settings.getSavedPages())['https://both.example/'].customName, 'Manual Name');
});

test('schema6 #59: renameSavedPage changes ONLY customName', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://rename.example/', 175, { titleSnapshot: 'Snapshot' });
  await settings.renameSavedPage('https://rename.example/', '  New   Name  ');
  assert.deepEqual((await settings.getSavedPages())['https://rename.example/'], {
    volumePercent: 175,
    titleSnapshot: 'Snapshot',
    customName: 'New Name',
  });
});

test('schema6 #60: an empty rename CLEARS the override without touching anything else', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://clear-name.example/', 175, { titleSnapshot: 'Snapshot', customName: 'Old' });
  await settings.renameSavedPage('https://clear-name.example/', '   ');
  assert.deepEqual((await settings.getSavedPages())['https://clear-name.example/'], {
    volumePercent: 175,
    titleSnapshot: 'Snapshot',
    customName: '',
  });
});

test('schema6 #65: renaming a page that is not saved is a structured no-op, never a resurrection', async () => {
  installChromeStub({});
  const result = await settings.renameSavedPage('https://ghost.example/', 'Nope');
  assert.equal(result.aborted, true);
  assert.equal(result.code, 'PAGE_NOT_SAVED');
  assert.deepEqual(await settings.getSavedPages(), {});
});

test('schema6: a volume commit preserves the record metadata (never discards a name or title)', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://vol.example/', 100, { titleSnapshot: 'T', customName: 'N' });
  const result = await settings.persistExistingVolumeIfPreconditionHolds('https://vol.example/', 240, () => true);
  assert.equal(result.aborted, false);
  assert.deepEqual((await settings.getSavedPages())['https://vol.example/'], {
    volumePercent: 240,
    titleSnapshot: 'T',
    customName: 'N',
  });
});

test('schema6: a compensated (precondition-invalidated) volume write restores the volume AND keeps metadata', async () => {
  installChromeStub({});
  await settings.addSavedPage('https://compensate-meta.example/', 100, { titleSnapshot: 'T', customName: 'N' });
  let allow = true;
  const result = await settings.persistExistingVolumeIfPreconditionHolds(
    'https://compensate-meta.example/',
    240,
    () => {
      const current = allow;
      allow = false; // becomes false after the first check
      return current;
    }
  );
  assert.equal(result.aborted, true);
  assert.deepEqual((await settings.getSavedPages())['https://compensate-meta.example/'], {
    volumePercent: 100,
    titleSnapshot: 'T',
    customName: 'N',
  });
});
