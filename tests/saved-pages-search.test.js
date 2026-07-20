// Deterministic, DOM-free tests for the entirely LOCAL saved-pages search.
// See shared/saved-pages-search.js: tokenized AND semantics over a combined
// normalized text built from customName, titleSnapshot, the generated fallback
// label, hostname, the raw pageKey, the decoded pageKey, pathname, query, and
// fragment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSearchText,
  tokenizeQuery,
  buildSearchableText,
  matchesSavedPage,
  filterSavedPageKeys,
} from '../shared/saved-pages-search.js';

const rec = (volumePercent = 100, titleSnapshot = '', customName = '') => ({ volumePercent, titleSnapshot, customName });

const YOUTUBE = 'https://www.youtube.com/watch?v=abc';
const REZKA = 'https://rezka.ag/series/thriller/19546-posledniy-kandidat-2016.html';
const PLAIN = 'https://example.com/';

const PAGES = {
  [YOUTUBE]: rec(100),
  [REZKA]: rec(209),
  [PLAIN]: rec(150),
};

// ===========================================================================
// Normalization + tokenization
// ===========================================================================

test('search: normalization lowercases, trims, and applies Unicode NFKC', () => {
  assert.equal(normalizeSearchText('  HeLLo  '), 'hello');
  // Full-width characters fold to ASCII under NFKC.
  assert.equal(normalizeSearchText('ＹＯＵＴＵＢＥ'), 'youtube');
  // A composed vs. decomposed accent compares equal after normalization.
  assert.equal(normalizeSearchText('café'), normalizeSearchText('café'));
});

test('search: the query tokenizes on whitespace and URL separators', () => {
  assert.deepEqual(tokenizeQuery('rezka kandidat'), ['rezka', 'kandidat']);
  assert.deepEqual(tokenizeQuery('youtube.com/watch'), ['youtube', 'com', 'watch']);
  assert.deepEqual(tokenizeQuery('a-b_c?d=e#f'), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(tokenizeQuery('   '), []);
  assert.deepEqual(tokenizeQuery(''), []);
});

test('search: the searchable text covers name, title, host, path, query, and fragment', () => {
  const pageKey = 'https://a.example/some/path?episode=2#chapter-3';
  const text = buildSearchableText(pageKey, rec(100, 'Snapshot Title', 'Custom Name'));
  for (const needle of ['custom name', 'snapshot title', 'a.example', 'some', 'path', 'episode', '2', 'chapter-3']) {
    assert.ok(text.includes(needle), `searchable text should contain "${needle}"`);
  }
});

// ===========================================================================
// Matching semantics
// ===========================================================================

test('search #20: "youtube" matches youtube.com', () => {
  assert.deepEqual(filterSavedPageKeys(PAGES, 'youtube'), [YOUTUBE]);
});

test('search #21: a word in the MIDDLE of a URL matches', () => {
  assert.deepEqual(filterSavedPageKeys(PAGES, 'thriller'), [REZKA]);
  assert.deepEqual(filterSavedPageKeys(PAGES, 'series'), [REZKA]);
});

test('search #22: "rezka kandidat" matches when the tokens come from SEPARATE fields', () => {
  // "rezka" is only in the hostname; "kandidat" is only in the path slug.
  assert.deepEqual(filterSavedPageKeys(PAGES, 'rezka kandidat'), [REZKA]);
});

test('search #23: matching is case-insensitive', () => {
  assert.deepEqual(filterSavedPageKeys(PAGES, 'YOUTUBE'), [YOUTUBE]);
  assert.deepEqual(filterSavedPageKeys(PAGES, 'ReZkA KaNdIdAt'), [REZKA]);
});

test('search #24: Unicode normalization lets differently-composed text match', () => {
  const pageKey = 'https://a.example/page';
  const record = rec(100, 'Café Noir'); // composed é
  assert.equal(matchesSavedPage(pageKey, record, 'café'), true, 'decomposed query matches composed title');
  assert.equal(matchesSavedPage(pageKey, record, 'CAFÉ'), true);
});

test('search #25: percent-decoded text can match safely', () => {
  const pageKey = 'https://a.example/caf%C3%A9/menu';
  const record = rec(100);
  assert.equal(matchesSavedPage(pageKey, record, 'café'), true, 'the decoded form matches');
  assert.equal(matchesSavedPage(pageKey, record, 'c3'), true, 'the raw encoded form still matches too');
  // A malformed escape must not throw.
  assert.equal(matchesSavedPage('https://a.example/bad%zz', record, 'bad'), true);
});

test('search #26: token ORDER does not matter', () => {
  assert.deepEqual(filterSavedPageKeys(PAGES, 'kandidat rezka'), [REZKA]);
  assert.deepEqual(filterSavedPageKeys(PAGES, 'rezka kandidat'), [REZKA]);
});

test('search #27: missing ONE required token means no match (AND, not OR)', () => {
  assert.deepEqual(filterSavedPageKeys(PAGES, 'rezka nosuchtoken'), []);
  assert.deepEqual(filterSavedPageKeys(PAGES, 'youtube rezka'), [], 'no single page contains both');
});

test('search #28: the query string and fragment are searchable', () => {
  const pageKey = 'https://a.example/watch?episode=2#chapter-3';
  const pages = { [pageKey]: rec(100) };
  assert.deepEqual(filterSavedPageKeys(pages, 'episode'), [pageKey]);
  assert.deepEqual(filterSavedPageKeys(pages, '2'), [pageKey]);
  assert.deepEqual(filterSavedPageKeys(pages, 'chapter'), [pageKey]);
});

test('search #29: searching never alters the exact pageKey', () => {
  const pages = { ...PAGES };
  const keysBefore = Object.keys(pages);
  const results = filterSavedPageKeys(pages, 'rezka');
  assert.deepEqual(Object.keys(pages), keysBefore, 'the input map is untouched');
  assert.equal(results[0], REZKA, 'the returned key is the exact original string');
  assert.equal(results[0].length, REZKA.length);
});

test('search #30: an empty (or whitespace-only) query shows every record', () => {
  assert.equal(filterSavedPageKeys(PAGES, '').length, 3);
  assert.equal(filterSavedPageKeys(PAGES, '   ').length, 3);
  assert.equal(filterSavedPageKeys(PAGES, undefined).length, 3);
});

test('search: customName and titleSnapshot are searchable', () => {
  const pageKey = 'https://opaque.example/x9q1';
  const pages = { [pageKey]: rec(100, 'Documentary Night', 'Movie Marathon') };
  assert.deepEqual(filterSavedPageKeys(pages, 'documentary'), [pageKey], 'titleSnapshot is searchable');
  assert.deepEqual(filterSavedPageKeys(pages, 'marathon'), [pageKey], 'customName is searchable');
  assert.deepEqual(filterSavedPageKeys(pages, 'marathon documentary'), [pageKey], 'tokens across both fields');
});

test('search: exact-page distinctness is preserved - same host, different path', () => {
  const a = 'https://same.example/alpha';
  const b = 'https://same.example/beta';
  const pages = { [a]: rec(100), [b]: rec(100) };
  assert.deepEqual(filterSavedPageKeys(pages, 'alpha'), [a]);
  assert.deepEqual(filterSavedPageKeys(pages, 'beta'), [b]);
  assert.equal(filterSavedPageKeys(pages, 'same.example').length, 2);
});

test('search: results are returned in a stable, deterministic order', () => {
  const first = filterSavedPageKeys(PAGES, '');
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(filterSavedPageKeys(PAGES, ''), first);
  }
});

test('search: a malformed pageKey still searches through its raw text without throwing', () => {
  const pages = { 'not a url': rec(100) };
  assert.deepEqual(filterSavedPageKeys(pages, 'not'), ['not a url']);
});
