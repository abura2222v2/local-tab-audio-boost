// Pure, DOM-free logic for the Saved pages view's Export / Import feature.
// No network access of any kind: export serializes data already held in
// memory, and import only ever parses text the caller already read from a
// local File (via the browser's own file picker) - nothing here fetches,
// opens, or transmits anything.
//
// Kept separate from options.js (which owns the DOM/File-API glue: building
// the download link, opening the file picker, reading the File) so this
// logic is unit-testable under plain Node, matching every other view-model
// module in shared/.

export const EXPORT_FORMAT = 'local-tab-audio-boost-saved-pages';
export const EXPORT_FORMAT_VERSION = 1;

/**
 * Builds the exact JSON-serializable object Export writes to a file, from
 * the schema-6 savedPages map already held in memory. `now` is injectable
 * only so a test can assert a deterministic `exportedAt`.
 */
export function buildExportPayload(savedPages, now = new Date()) {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_FORMAT_VERSION,
    exportedAt: now.toISOString(),
    pages: Object.entries(savedPages ?? {}).map(([pageKey, record]) => ({
      pageKey,
      volumePercent: record?.volumePercent,
      titleSnapshot: record?.titleSnapshot,
      customName: record?.customName,
    })),
  };
}

/**
 * Extracts the raw entries array from parsed JSON, accepting both this
 * extension's own export shape ({pages: [...]}) and a bare array, so a
 * hand-edited or externally-assembled list still imports. Returns null for
 * anything else (including a shape with no usable array at all).
 */
export function extractRawImportEntries(parsed) {
  if (Array.isArray(parsed?.pages)) return parsed.pages;
  if (Array.isArray(parsed)) return parsed;
  return null;
}

/**
 * Filters and reshapes raw (untrusted, externally-authored) import entries
 * into exactly the payload shape IMPORT_SAVED_PAGES accepts. Only checks
 * basic type shape here - pageKey canonicalization, volume clamping, and
 * metadata sanitization/length limits are the service worker's job (see
 * handleImportSavedPages in service-worker.js), exactly like every other
 * saved-page mutation never trusts a client-supplied value as final.
 *
 * `maxCount` bounds the result so an oversized file degrades to "import the
 * first N entries" locally, rather than the whole request being rejected
 * outright by the service worker's own IMPORT_SAVED_PAGES payload bound.
 */
export function sanitizeImportEntries(rawEntries, maxCount) {
  const list = Array.isArray(rawEntries) ? rawEntries : [];
  const shaped = list
    .filter((entry) => entry && typeof entry === 'object' && typeof entry.pageKey === 'string' && entry.pageKey.length > 0)
    .map((entry) => ({
      pageKey: entry.pageKey,
      volumePercent: typeof entry.volumePercent === 'number' ? entry.volumePercent : undefined,
      titleSnapshot: typeof entry.titleSnapshot === 'string' ? entry.titleSnapshot : undefined,
      customName: typeof entry.customName === 'string' ? entry.customName : undefined,
    }));
  const entries = typeof maxCount === 'number' ? shaped.slice(0, maxCount) : shaped;
  return { entries, totalRawCount: list.length, droppedCount: list.length - entries.length };
}
