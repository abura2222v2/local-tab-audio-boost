// Pure, DOM-free, network-free saved-page metadata and display-label logic
// (schema 6). Nothing in this module performs, schedules, or enables any kind
// of network access: no title lookup, no favicon, no metadata service, no
// content script. Every display name is derived ONLY from data already stored
// locally (customName / titleSnapshot) or from the pageKey's own text.
//
// A schema-6 saved-page record contains:
//   { volumePercent: integer 0-300, titleSnapshot: string, customName: string,
//     matchMode?: 'page'|'path'|'site' }
// A missing matchMode deliberately means the legacy/default 'exact' mode, so
// existing stored records remain valid without a migration or rewrite.
//
//  - volumePercent is the only field that affects audio;
//  - titleSnapshot is a local snapshot of the tab's title, taken by the
//    service worker at "Add this page" time (never supplied by the popup);
//  - customName is an optional user override, set only via Rename or the
//    "Add URL manually" name field.
// Display metadata never affects matching. matchMode is the only optional
// field that broadens how the stored canonical pageKey is interpreted.

import {
  MAX_TITLE_SNAPSHOT_LENGTH,
  MAX_CUSTOM_NAME_LENGTH,
  MIN_GAIN_PERCENT,
  MAX_GAIN_PERCENT,
  SAVED_PAGE_MATCH_MODES,
} from './constants.js';
import { normalizeSavedPageMatchMode } from './saved-page-rules.js';

// Control characters (C0 and C1, including DEL) are stripped from every stored
// display string, so a title containing newlines/escapes can never corrupt the
// rendered list. Built from explicit code-point ranges rather than a pattern
// literal, since the audit forbids constructed matching logic outside
// shared/urls.js.
function isControlCharacter(codePoint) {
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

/**
 * Shared sanitization for both local display strings: strip control
 * characters, collapse every run of whitespace into a single space, trim, and
 * hard-limit the length. Anything unusable (non-string, empty after cleaning)
 * becomes the empty string - never null/undefined, so a record's fields always
 * have a predictable type.
 */
function sanitizeDisplayString(value, maxLength) {
  if (typeof value !== 'string') return '';
  let out = '';
  let pendingSpace = false;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (isControlCharacter(codePoint)) {
      // A control character behaves like whitespace rather than joining the
      // two surrounding words together.
      pendingSpace = out.length > 0;
      continue;
    }
    if (character.trim() === '') {
      // Any Unicode whitespace (space, tab, newline, NBSP, ...) collapses to one space.
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += character;
  }
  out = out.trim();
  if (out.length > maxLength) {
    out = out.slice(0, maxLength).trim();
  }
  return out;
}

/** Sanitizes a locally-read tab title into a storable titleSnapshot. */
export function sanitizeTitleSnapshot(value) {
  return sanitizeDisplayString(value, MAX_TITLE_SNAPSHOT_LENGTH);
}

/** Sanitizes a user-entered custom name. An empty result clears the override. */
export function sanitizeCustomName(value) {
  return sanitizeDisplayString(value, MAX_CUSTOM_NAME_LENGTH);
}

function isValidVolumePercent(value) {
  return Number.isInteger(value) && value >= MIN_GAIN_PERCENT && value <= MAX_GAIN_PERCENT;
}

/**
 * Builds a well-formed schema-6 record from arbitrary parts. Metadata is
 * always sanitized; an invalid volume yields null so the caller can drop the
 * whole record rather than store a half-valid one.
 */
export function createSavedPageRecord({ volumePercent, titleSnapshot = '', customName = '', matchMode } = {}) {
  if (!isValidVolumePercent(volumePercent)) return null;
  const record = {
    volumePercent,
    titleSnapshot: sanitizeTitleSnapshot(titleSnapshot),
    customName: sanitizeCustomName(customName),
  };
  const normalizedMode = normalizeSavedPageMatchMode(matchMode);
  if (normalizedMode !== SAVED_PAGE_MATCH_MODES.EXACT) record.matchMode = normalizedMode;
  return record;
}

/**
 * Normalizes ONE stored saved-page value into a schema-6 record, or null if it
 * is unusable. Accepts both representations so migration and defensive reads
 * share exactly one implementation:
 *
 *  - a bare number (schema 5)  -> { volumePercent, titleSnapshot: '', customName: '' }
 *  - a schema-6 object         -> validated + sanitized, unknown properties dropped
 *
 * Unrecognized properties are never carried through: the returned record is
 * rebuilt from only the known fields, so nothing a malformed or
 * hostile storage value contains can survive into the runtime representation.
 * A missing/invalid metadata field becomes the empty string; an out-of-range
 * or non-integer volume rejects the whole record (matching schema 5's existing
 * contract, where such an entry was dropped rather than clamped).
 */
export function normalizeSavedPageRecord(value) {
  if (typeof value === 'number') {
    return createSavedPageRecord({ volumePercent: value, titleSnapshot: '', customName: '' });
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return createSavedPageRecord({
    volumePercent: value.volumePercent,
    titleSnapshot: value.titleSnapshot,
    customName: value.customName,
    matchMode: value.matchMode,
  });
}

// Path segments that carry no useful label on their own - if the last segment
// is one of these, the previous meaningful segment is preferred.
const UNINFORMATIVE_SEGMENTS = new Set(['index', 'index.html', 'index.htm', 'index.php', 'default', 'home', '']);

// Simple trailing file extensions worth dropping from a derived label.
const STRIPPABLE_EXTENSIONS = new Set(['html', 'htm', 'php', 'aspx', 'asp', 'jsp', 'shtml']);

/** Safely percent-decodes text; malformed escapes are left exactly as they were. */
export function safeDecode(text) {
  if (typeof text !== 'string') return '';
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function stripTrailingExtension(segment) {
  const dot = segment.lastIndexOf('.');
  if (dot <= 0) return segment;
  const extension = segment.slice(dot + 1).toLowerCase();
  if (!STRIPPABLE_EXTENSIONS.has(extension)) return segment;
  return segment.slice(0, dot);
}

/** Turns separator runs (-, _, +, whitespace) into single spaces... but keeps hyphenated slugs readable. */
function tidyLabelSegment(segment) {
  let out = '';
  let pendingSpace = false;
  for (const character of segment) {
    if (character === '_' || character === '+' || character.trim() === '') {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      out += ' ';
      pendingSpace = false;
    }
    out += character;
  }
  return out.trim();
}

/**
 * Deterministic, purely local fallback label for a pageKey, used when a saved
 * page has neither a customName nor a titleSnapshot. Derived entirely from the
 * URL's own text - it never fetches the page, loads a favicon, or consults any
 * external service.
 *
 *   https://www.youtube.com/watch?v=abc  -> "youtube.com · watch"
 *   https://stream.example/series/thriller/last-candidate.html
 *                                        -> "stream.example · last-candidate"
 *   https://example.com/                 -> "example.com"
 *
 * The leading "www." is removed from the DISPLAYED hostname only; the stored
 * pageKey is never altered by this function.
 */
export function buildFallbackLabel(pageKey) {
  if (typeof pageKey !== 'string' || pageKey.length === 0) return '';
  let url;
  try {
    url = new URL(pageKey);
  } catch {
    return pageKey;
  }

  let host = url.hostname;
  if (host.startsWith('www.')) host = host.slice(4);

  const segments = url.pathname
    .split('/')
    .map((segment) => safeDecode(segment).trim())
    .filter((segment) => segment.length > 0);

  // Prefer the last meaningful segment, skipping uninformative ones.
  let label = '';
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const candidate = segments[index];
    if (UNINFORMATIVE_SEGMENTS.has(candidate.toLowerCase())) continue;
    label = candidate;
    break;
  }

  if (label) {
    label = tidyLabelSegment(stripTrailingExtension(label));
  }

  return label ? `${host} · ${label}` : host;
}

/**
 * The single display-name rule, in priority order:
 *   1. customName    (when non-empty after trimming)
 *   2. titleSnapshot (when non-empty after trimming)
 *   3. a locally derived fallback label from the pageKey
 * Always returns a non-empty string for a usable pageKey.
 */
export function getDisplayName(pageKey, record) {
  const customName = typeof record?.customName === 'string' ? record.customName.trim() : '';
  if (customName) return customName;
  const titleSnapshot = typeof record?.titleSnapshot === 'string' ? record.titleSnapshot.trim() : '';
  if (titleSnapshot) return titleSnapshot;
  return buildFallbackLabel(pageKey);
}
