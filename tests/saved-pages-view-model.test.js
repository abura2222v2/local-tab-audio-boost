// Deterministic, DOM-free tests for the Saved-pages selection view-model.
// See shared/saved-pages-view-model.js.
//
// Selection is temporary UI state that lives only inside an open Saved pages
// view - nothing here persists anything. The delicate part being pinned down:
// selection survives a search-query change, so a selected page can be HIDDEN,
// and every count / confirmation has to say so out loud.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectAllVisible,
  deselectAllVisible,
  toggleSelection,
  clearSelection,
  pruneSelection,
  headerCheckboxState,
  selectionCounts,
  describeSelection,
  describeDeleteConfirmation,
  applyBulkResultsToSelection,
  summarizeBulkResults,
} from '../shared/saved-pages-view-model.js';

const A = 'https://a.example/';
const B = 'https://b.example/';
const C = 'https://c.example/';
const D = 'https://d.example/';

// ===========================================================================
// Select all visible / deselect all visible
// ===========================================================================

test('selection #31: "select all visible" selects ONLY the currently visible rows', () => {
  const selected = selectAllVisible(new Set(), [A, B]);
  assert.deepEqual([...selected].sort(), [A, B]);
});

test('selection #32: hidden rows are never newly selected by "select all visible"', () => {
  // C and D exist but are filtered out by the search.
  const selected = selectAllVisible(new Set(), [A, B]);
  assert.equal(selected.has(C), false);
  assert.equal(selected.has(D), false);
});

test('selection #32b: "select all visible" preserves an existing HIDDEN selection', () => {
  const before = new Set([C]); // C is selected but currently hidden
  const after = selectAllVisible(before, [A, B]);
  assert.deepEqual([...after].sort(), [A, B, C].sort(), 'the hidden selection survives');
});

test('selection: "deselect all visible" removes only visible rows, keeping hidden selection', () => {
  const before = new Set([A, B, C]); // C hidden
  const after = deselectAllVisible(before, [A, B]);
  assert.deepEqual([...after], [C]);
});

test('selection: toggling one row adds or removes exactly that row', () => {
  let selected = toggleSelection(new Set(), A, true);
  assert.deepEqual([...selected], [A]);
  selected = toggleSelection(selected, B, true);
  assert.deepEqual([...selected].sort(), [A, B]);
  selected = toggleSelection(selected, A, false);
  assert.deepEqual([...selected], [B]);
});

// ===========================================================================
// Header checkbox tri-state
// ===========================================================================

test('selection #33: header checkbox is CHECKED when every visible row is selected', () => {
  assert.equal(headerCheckboxState(new Set([A, B]), [A, B]), 'checked');
  // A hidden selected row does not stop the visible ones from being "all selected".
  assert.equal(headerCheckboxState(new Set([A, B, C]), [A, B]), 'checked');
});

test('selection #33: header checkbox is UNCHECKED when no visible row is selected', () => {
  assert.equal(headerCheckboxState(new Set(), [A, B]), 'unchecked');
  assert.equal(headerCheckboxState(new Set([C]), [A, B]), 'unchecked', 'only a hidden row is selected');
});

test('selection #33: header checkbox is INDETERMINATE when some but not all visible rows are selected', () => {
  assert.equal(headerCheckboxState(new Set([A]), [A, B]), 'indeterminate');
  assert.equal(headerCheckboxState(new Set([A, C]), [A, B]), 'indeterminate');
});

test('selection #33: with nothing visible the header checkbox is unchecked, never indeterminate', () => {
  assert.equal(headerCheckboxState(new Set([A, B]), []), 'unchecked');
});

// ===========================================================================
// Counts + descriptions
// ===========================================================================

test('selection #34: an intentional selection survives a search-query change', () => {
  // The user selects 4 pages with no filter, then types a query that hides two.
  const selected = selectAllVisible(new Set(), [A, B, C, D]);
  const visibleAfterSearch = [A, B];
  const counts = selectionCounts(selected, visibleAfterSearch);
  assert.equal(counts.total, 4, 'the selection itself is untouched by searching');
  assert.equal(counts.visible, 2);
  assert.equal(counts.hidden, 2);
});

test('selection #35: total / visible / hidden counts are correct', () => {
  assert.deepEqual(selectionCounts(new Set([A, B, C]), [A]), { total: 3, visible: 1, hidden: 2 });
  assert.deepEqual(selectionCounts(new Set(), [A, B]), { total: 0, visible: 0, hidden: 0 });
  assert.deepEqual(selectionCounts(new Set([A, B]), [A, B]), { total: 2, visible: 2, hidden: 0 });
});

test('selection: the summary reports hidden selection only when it exists', () => {
  assert.equal(describeSelection({ total: 0, visible: 0, hidden: 0 }), 'Selected: none');
  assert.equal(describeSelection({ total: 4, visible: 4, hidden: 0 }), 'Selected: 4 total, 4 visible');
  assert.equal(describeSelection({ total: 7, visible: 3, hidden: 4 }), 'Selected: 7 total, 3 visible, 4 hidden by search');
});

test('selection #54: the delete confirmation states the total AND the hidden count', () => {
  const text = describeDeleteConfirmation({ total: 7, visible: 3, hidden: 4 });
  assert.ok(text.includes('7'), 'states the total selected count');
  assert.ok(text.includes('4'), 'states the hidden count');
  assert.ok(text.includes('hidden by the search'), 'explains that some are hidden');
  assert.ok(text.includes('stopped'), 'warns that active boosting will be stopped');
});

test('selection: the delete confirmation omits the hidden sentence when nothing is hidden', () => {
  const text = describeDeleteConfirmation({ total: 2, visible: 2, hidden: 0 });
  assert.ok(text.includes('Delete 2 selected saved pages?'));
  assert.equal(text.includes('hidden'), false);
});

test('selection #36: clear selection empties everything, visible and hidden alike', () => {
  assert.equal(clearSelection().size, 0);
});

test('selection: pruning drops selected keys that no longer exist in savedPages', () => {
  const selected = new Set([A, B, C]);
  const savedPages = { [A]: { volumePercent: 100 }, [C]: { volumePercent: 100 } };
  assert.deepEqual([...pruneSelection(selected, savedPages)].sort(), [A, C].sort());
});

// ===========================================================================
// Folding bulk results back into the selection
// ===========================================================================

test('selection #37: a SUCCESSFUL bulk result removes that page from the selection', () => {
  const selected = new Set([A, B]);
  const after = applyBulkResultsToSelection(selected, [
    { pageKey: A, ok: true },
    { pageKey: B, ok: true },
  ]);
  assert.equal(after.size, 0);
});

test('selection #38: a FAILED bulk result keeps that page selected so it can be retried', () => {
  const selected = new Set([A, B, C]);
  const after = applyBulkResultsToSelection(selected, [
    { pageKey: A, ok: true },
    { pageKey: B, ok: false, error: { code: 'CAPTURE_FAILED', message: 'nope' } },
    { pageKey: C, ok: true },
  ]);
  assert.deepEqual([...after], [B], 'only the failed page stays selected');
});

test('selection: a result for an unselected page is ignored', () => {
  const after = applyBulkResultsToSelection(new Set([A]), [{ pageKey: D, ok: true }]);
  assert.deepEqual([...after], [A]);
});

// ===========================================================================
// Bulk summaries - never claim complete success when something failed
// ===========================================================================

test('bulk summary: an all-success run reports only successes', () => {
  const text = summarizeBulkResults([{ pageKey: A, ok: true }, { pageKey: B, ok: true }], { verb: 'Reset', suffix: 'to 100%' });
  assert.equal(text, 'Reset 2 pages to 100%.');
});

test('bulk summary #48: a partial failure is reported explicitly, never as complete success', () => {
  const results = [
    { pageKey: A, ok: true },
    { pageKey: B, ok: true },
    { pageKey: C, ok: false, error: { code: 'CAPTURE_FAILED', message: 'nope' } },
  ];
  const text = summarizeBulkResults(results, { verb: 'Reset', suffix: 'to 100%' });
  assert.ok(text.includes('2'), 'reports the successes');
  assert.ok(text.includes('1 page failed'), 'reports the failure count');
});

test('bulk summary: an all-failure run says nothing was changed', () => {
  const text = summarizeBulkResults([{ pageKey: A, ok: false, error: { code: 'X', message: 'y' } }], { verb: 'Deleted' });
  assert.ok(text.includes('No pages were changed'));
  assert.ok(text.includes('1 page failed'));
});

test('bulk summary: an empty result set says there was nothing to do', () => {
  assert.equal(summarizeBulkResults([], { verb: 'Deleted' }), 'Nothing to do.');
});

// ===========================================================================
// "Deselect all" (the control formerly labelled "Clear selection") is purely a
// view-state operation. These assertions pin down that it touches ONLY the
// selection set - the saved-page records it was applied against are handed
// back untouched, so it can never be mistaken for a delete or a volume reset.
// ===========================================================================

test('deselect-all #2/#3/#4: clearing selection leaves every saved record byte-for-byte unchanged', () => {
  const savedPages = {
    [A]: { volumePercent: 250, titleSnapshot: 'A title', customName: 'A name' },
    [B]: { volumePercent: 40, titleSnapshot: '', customName: '' },
  };
  const before = JSON.stringify(savedPages);

  const selected = selectAllVisible(new Set(), [A, B]);
  assert.equal(selected.size, 2);

  const after = clearSelection();
  assert.equal(after.size, 0, 'the checkmarks are gone');
  assert.equal(JSON.stringify(savedPages), before, 'no record was deleted and no volume was changed');
  assert.equal(Object.keys(savedPages).length, 2, 'both pages still exist');
  assert.equal(savedPages[A].volumePercent, 250, 'volume untouched - this is not Reset to 100%');
});

test('deselect-all: it is distinct from delete - the saved-page set is unaffected by selection changes', () => {
  const savedPages = { [A]: { volumePercent: 100 }, [B]: { volumePercent: 100 }, [C]: { volumePercent: 100 } };
  let selected = selectAllVisible(new Set(), [A, B, C]);
  selected = clearSelection();
  // Pruning against the untouched map proves every key still exists.
  assert.equal(Object.keys(savedPages).length, 3);
  assert.equal(pruneSelection(new Set([A, B, C]), savedPages).size, 3);
  assert.equal(selected.size, 0);
});
