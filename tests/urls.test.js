import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizePageKey, isRestrictedPageUrl } from '../shared/urls.js';

test('identical URL canonicalizes to itself', () => {
  const a = canonicalizePageKey('https://film.example/watch/movie-123');
  const b = canonicalizePageKey('https://film.example/watch/movie-123');
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(a.pageKey, b.pageKey);
});

test('different path produces a different key', () => {
  const a = canonicalizePageKey('https://film.example/watch/movie-123');
  const b = canonicalizePageKey('https://film.example/watch/movie-456');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('different query string produces a different key', () => {
  const a = canonicalizePageKey('https://film.example/watch/movie-123');
  const b = canonicalizePageKey('https://film.example/watch/movie-123?episode=2');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('different query parameter order produces a different key', () => {
  const a = canonicalizePageKey('https://film.example/watch?a=1&b=2');
  const b = canonicalizePageKey('https://film.example/watch?b=2&a=1');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('different fragment produces a different key', () => {
  const a = canonicalizePageKey('https://film.example/watch/movie-123');
  const b = canonicalizePageKey('https://film.example/watch/movie-123#episode-2');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('different scheme produces a different key', () => {
  const a = canonicalizePageKey('https://film.example/watch/movie-123');
  const b = canonicalizePageKey('http://film.example/watch/movie-123');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('explicit default port matches implicit default port', () => {
  const a = canonicalizePageKey('https://film.example:443/watch');
  const b = canonicalizePageKey('https://film.example/watch');
  assert.equal(a.pageKey, b.pageKey);
});

test('non-default port remains distinct', () => {
  const a = canonicalizePageKey('https://film.example:8443/watch');
  const b = canonicalizePageKey('https://film.example/watch');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('hostname case normalizes', () => {
  const a = canonicalizePageKey('https://Film.EXAMPLE/watch');
  const b = canonicalizePageKey('https://film.example/watch');
  assert.equal(a.pageKey, b.pageKey);
});

test('path case remains distinct', () => {
  const a = canonicalizePageKey('https://film.example/Watch');
  const b = canonicalizePageKey('https://film.example/watch');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('trailing slash remains distinct', () => {
  const a = canonicalizePageKey('https://film.example/catalog');
  const b = canonicalizePageKey('https://film.example/catalog/');
  assert.notEqual(a.pageKey, b.pageKey);
});

test('embedded credentials are rejected', () => {
  const result = canonicalizePageKey('https://user:pass@film.example/watch');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'CREDENTIALS_IN_URL');
});

test('unsupported schemes are rejected', () => {
  const urls = [
    'chrome://extensions',
    'chrome-extension://abcdefghijklmnop/page.html',
    'about:blank',
    'file:///etc/passwd',
    'data:text/plain;base64,aGVsbG8=',
  ];
  for (const url of urls) {
    const result = canonicalizePageKey(url);
    assert.equal(result.ok, false, `expected ${url} to be rejected`);
  }
});

test('Chrome Web Store origin is rejected', () => {
  const result = canonicalizePageKey('https://chromewebstore.google.com/detail/example/abcdefg');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESTRICTED_PAGE');
});

test('legacy Chrome Web Store path is rejected', () => {
  const result = canonicalizePageKey('https://chrome.google.com/webstore/detail/example/abcdefg');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'RESTRICTED_PAGE');
});

test('malformed input is rejected', () => {
  const result = canonicalizePageKey('not a url');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'INVALID_URL');
});

test('isRestrictedPageUrl rejects non-URL input defensively', () => {
  assert.equal(isRestrictedPageUrl('https://example.com'), true);
});

test('isRestrictedPageUrl allows an ordinary https URL', () => {
  assert.equal(isRestrictedPageUrl(new URL('https://film.example/watch/movie-123')), false);
});
