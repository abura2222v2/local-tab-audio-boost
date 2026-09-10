// Pure, DOM-free, entirely LOCAL saved-pages search. No network access of any
// kind: this module only ever reads text that is already stored locally (the
// pageKey and its schema-6 record) - there is no online search, no suggestion
// service, no fuzzy-matching library, and no edit-distance scoring.
//
// Semantics: TOKENIZED AND.
//   - the query is normalized and split into tokens on whitespace and URL
//     punctuation;
//   - a saved page matches when EVERY token appears somewhere in that page's
//     combined normalized searchable text;
//   - token ORDER does not matter, and tokens need not be adjacent, so
//     "stream candidate" matches a page whose hostname supplies "stream" and
//     whose path supplies "kandidat".
//
// Search only decides which rows are VISIBLE. It never changes exact-page
// audio semantics, never widens matching to a whole domain, and never alters
// the stored pageKey - the exact canonical key is always preserved separately
// from the normalized text derived from it.

import { getDisplayName, buildFallbackLabel, safeDecode } from './saved-page-metadata.js';

// Characters treated as token boundaries in addition to whitespace: URL
// structure and common word separators, so "youtube.com/watch?v=abc" yields
// the tokens youtube, com, watch, v, abc.
const SEPARATORS = new Set(['/', '.', '-', '_', '?', '&', '=', '#', ':', '%', '+', ',', ';', '~', '(', ')', '[', ']', '"', "'", '|', '@', '!', '*', '<', '>', '{', '}', '\\']);

/**
 * Local text normalization: Unicode NFKC (so compatibility/full-width forms
 * and composed accents compare equal), lowercased, trimmed. Applied to both
 * the query and every searchable field, so matching is case- and
 * form-insensitive.
 */
export function normalizeSearchText(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  let normalized = value;
  try {
    normalized = value.normalize('NFKC');
  } catch {
    // An environment without full Unicode normalization still searches, just
    // without form folding.
  }
  return normalized.toLowerCase().trim();
}

/** Splits already-normalized text into tokens on whitespace + URL separators. */
function splitIntoTokens(normalizedText) {
  const tokens = [];
  let current = '';
  for (const character of normalizedText) {
    if (SEPARATORS.has(character) || character.trim() === '') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Normalizes and tokenizes a user query. An empty/whitespace-only query yields
 * an empty token list, which every record matches (the whole list stays
 * visible).
 */
export function tokenizeQuery(query) {
  return splitIntoTokens(normalizeSearchText(query));
}

/**
 * Memoizes buildSearchableText's result per record object: URL parsing plus
 * NFKC normalization is real work, and options.js recomputes it on every
 * keystroke in the search box for every saved page even though `savedPages`
 * (and therefore each individual record) does not change while the user is
 * simply typing a query. Keyed by the record object's identity (a WeakMap
 * needs no manual eviction - an entry vanishes with its record), with the
 * pageKey re-checked on hit as a defense-in-depth guard against a record
 * object ever being reused for a different key. A cache miss (new/changed
 * record, e.g. after rename or a volume update) transparently recomputes.
 */
const searchableTextCache = new WeakMap();

/**
 * The combined, normalized searchable text for one saved page. Deliberately
 * includes BOTH the raw pageKey and a safely percent-decoded form of it, plus
 * the URL's structural parts broken out, so a token can match text that only
 * appears in encoded or decoded form.
 *
 * Searchable fields: customName, titleSnapshot, the generated fallback label,
 * hostname, the raw full pageKey, the decoded pageKey, pathname, query string,
 * and fragment.
 */
export function buildSearchableText(pageKey, record) {
  const cacheable = record !== null && typeof record === 'object';
  if (cacheable) {
    const cached = searchableTextCache.get(record);
    if (cached && cached.pageKey === pageKey) return cached.text;
  }
  const text = computeSearchableText(pageKey, record);
  if (cacheable) searchableTextCache.set(record, { pageKey, text });
  return text;
}

function computeSearchableText(pageKey, record) {
  const parts = [];
  const push = (value) => {
    if (typeof value === 'string' && value.length > 0) parts.push(value);
  };

  push(record?.customName);
  push(record?.titleSnapshot);
  push(buildFallbackLabel(pageKey));
  push(pageKey);
  push(safeDecode(pageKey));

  try {
    const url = new URL(pageKey);
    push(url.hostname);
    // The hostname without a leading "www." as well, so "youtube" matches
    // "www.youtube.com" through either form.
    if (url.hostname.startsWith('www.')) push(url.hostname.slice(4));
    push(url.pathname);
    push(safeDecode(url.pathname));
    push(url.search);
    push(safeDecode(url.search));
    push(url.hash);
    push(safeDecode(url.hash));
    push(url.protocol);
    push(url.port);
  } catch {
    // A pageKey that will not parse still searches through its raw text above.
  }

  return normalizeSearchText(parts.join(' '));
}

/**
 * True when EVERY token appears somewhere in this page's searchable text.
 * An empty token list matches everything.
 */
export function matchesTokens(pageKey, record, tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return true;
  const haystack = buildSearchableText(pageKey, record);
  return tokens.every((token) => haystack.includes(token));
}

/** Convenience wrapper: tokenizes `query` and tests one record against it. */
export function matchesSavedPage(pageKey, record, query) {
  return matchesTokens(pageKey, record, tokenizeQuery(query));
}

/**
 * Filters a schema-6 savedPages map down to the pageKeys matching `query`,
 * returned in a stable order: by display name, then by exact pageKey, so the
 * rendered list never reshuffles between identical renders. The exact pageKeys
 * themselves are returned untouched.
 */
export function filterSavedPageKeys(savedPages, query) {
  const tokens = tokenizeQuery(query);
  const entries = Object.entries(savedPages ?? {}).filter(([pageKey, record]) => matchesTokens(pageKey, record, tokens));
  entries.sort(([keyA, recordA], [keyB, recordB]) => {
    const nameA = getDisplayName(keyA, recordA).toLowerCase();
    const nameB = getDisplayName(keyB, recordB).toLowerCase();
    if (nameA !== nameB) return nameA < nameB ? -1 : 1;
    return keyA < keyB ? -1 : keyA > keyB ? 1 : 0;
  });
  return entries.map(([pageKey]) => pageKey);
}
