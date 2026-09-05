// Deterministic, DOM-free tests for the Saved pages Export/Import view-model
// (shared/saved-pages-import.js). No network access anywhere in this module -
// these tests only ever exercise plain data transforms.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPORT_FORMAT,
  EXPORT_FORMAT_VERSION,
  buildExportPayload,
  extractRawImportEntries,
  sanitizeImportEntries,
} from '../shared/saved-pages-import.js';

const rec = (volumePercent = 100, titleSnapshot = '', customName = '') => ({ volumePercent, titleSnapshot, customName });

// ===========================================================================
// buildExportPayload
// ===========================================================================

test('buildExportPayload: serializes every saved page with its full record, and a fixed format/version', () => {
  const now = new Date('2026-01-02T03:04:05.000Z');
  const savedPages = {
    'https://a.example/': rec(150, 'Title A', 'Name A'),
    'https://b.example/': rec(200, '', ''),
  };
  const payload = buildExportPayload(savedPages, now);
  assert.equal(payload.format, EXPORT_FORMAT);
  assert.equal(payload.version, EXPORT_FORMAT_VERSION);
  assert.equal(payload.exportedAt, now.toISOString());
  assert.deepEqual(payload.pages, [
    { pageKey: 'https://a.example/', volumePercent: 150, titleSnapshot: 'Title A', customName: 'Name A' },
    { pageKey: 'https://b.example/', volumePercent: 200, titleSnapshot: '', customName: '' },
  ]);
});

test('buildExportPayload: an empty savedPages map exports an empty pages array, never throws', () => {
  const payload = buildExportPayload({});
  assert.deepEqual(payload.pages, []);
});

test('buildExportPayload: never mutates the input map', () => {
  const savedPages = { 'https://x.example/': rec(150) };
  const before = JSON.stringify(savedPages);
  buildExportPayload(savedPages);
  assert.equal(JSON.stringify(savedPages), before);
});

// ===========================================================================
// extractRawImportEntries
// ===========================================================================

test('extractRawImportEntries: accepts this extension\'s own export shape ({pages: [...]})', () => {
  const entries = [{ pageKey: 'https://a.example/' }];
  assert.equal(extractRawImportEntries({ format: EXPORT_FORMAT, pages: entries }), entries);
});

test('extractRawImportEntries: accepts a bare array, for a hand-edited or externally-assembled list', () => {
  const entries = [{ pageKey: 'https://a.example/' }];
  assert.equal(extractRawImportEntries(entries), entries);
});

test('extractRawImportEntries: rejects anything with no usable array', () => {
  assert.equal(extractRawImportEntries({}), null);
  assert.equal(extractRawImportEntries({ pages: 'not an array' }), null);
  assert.equal(extractRawImportEntries(null), null);
  assert.equal(extractRawImportEntries(undefined), null);
  assert.equal(extractRawImportEntries('a string'), null);
  assert.equal(extractRawImportEntries(42), null);
});

// ===========================================================================
// sanitizeImportEntries
// ===========================================================================

test('sanitizeImportEntries: reshapes a well-formed entry, keeping only the recognized fields', () => {
  const raw = [{ pageKey: 'https://a.example/', volumePercent: 200, titleSnapshot: 'T', customName: 'N', extra: 'dropped' }];
  const { entries, totalRawCount, droppedCount } = sanitizeImportEntries(raw, 100);
  assert.deepEqual(entries, [{ pageKey: 'https://a.example/', volumePercent: 200, titleSnapshot: 'T', customName: 'N' }]);
  assert.equal(totalRawCount, 1);
  assert.equal(droppedCount, 0);
  assert.equal('extra' in entries[0], false, 'an unrecognized field is never carried through');
});

test('sanitizeImportEntries: a minimal entry (pageKey only) keeps the optional fields undefined, never defaulted here', () => {
  const { entries } = sanitizeImportEntries([{ pageKey: 'https://a.example/' }], 100);
  assert.equal(entries[0].pageKey, 'https://a.example/');
  assert.equal(entries[0].volumePercent, undefined);
  assert.equal(entries[0].titleSnapshot, undefined);
  assert.equal(entries[0].customName, undefined);
});

test('sanitizeImportEntries: drops entries with no usable pageKey, without throwing', () => {
  const raw = [
    { pageKey: 'https://good.example/' },
    {},
    { pageKey: '' },
    { pageKey: 123 },
    null,
    'not an object',
    { pageKey: 'https://also-good.example/' },
  ];
  const { entries, totalRawCount, droppedCount } = sanitizeImportEntries(raw, 100);
  assert.deepEqual(
    entries.map((e) => e.pageKey),
    ['https://good.example/', 'https://also-good.example/']
  );
  assert.equal(totalRawCount, 7);
  assert.equal(droppedCount, 5);
});

test('sanitizeImportEntries: mistyped optional fields are dropped rather than passed through', () => {
  const raw = [{ pageKey: 'https://a.example/', volumePercent: '200', titleSnapshot: 42, customName: null }];
  const { entries } = sanitizeImportEntries(raw, 100);
  assert.equal(entries[0].volumePercent, undefined);
  assert.equal(entries[0].titleSnapshot, undefined);
  assert.equal(entries[0].customName, undefined);
});

test('sanitizeImportEntries: bounds the result to maxCount, reporting how many were dropped by the cap', () => {
  const raw = Array.from({ length: 5 }, (_, i) => ({ pageKey: `https://bulk.example/${i}` }));
  const { entries, totalRawCount, droppedCount } = sanitizeImportEntries(raw, 3);
  assert.equal(entries.length, 3);
  assert.equal(totalRawCount, 5);
  assert.equal(droppedCount, 2);
  assert.deepEqual(
    entries.map((e) => e.pageKey),
    ['https://bulk.example/0', 'https://bulk.example/1', 'https://bulk.example/2']
  );
});

test('sanitizeImportEntries: a non-array input is treated as empty, never throws', () => {
  assert.deepEqual(sanitizeImportEntries(null, 100), { entries: [], totalRawCount: 0, droppedCount: 0 });
  assert.deepEqual(sanitizeImportEntries(undefined, 100), { entries: [], totalRawCount: 0, droppedCount: 0 });
  assert.deepEqual(sanitizeImportEntries('not an array', 100), { entries: [], totalRawCount: 0, droppedCount: 0 });
});

test('sanitizeImportEntries: never mutates the input array', () => {
  const raw = [{ pageKey: 'https://a.example/', extra: 'x' }];
  const snapshot = JSON.stringify(raw);
  sanitizeImportEntries(raw, 100);
  assert.equal(JSON.stringify(raw), snapshot);
});
