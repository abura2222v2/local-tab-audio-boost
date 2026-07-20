// Pure, DOM-free selection view-model for the Saved pages view.
//
// Selection is TEMPORARY UI STATE that lives only inside an open Saved pages
// view. It is never persisted: nothing here writes storage, and no selection
// or search state is ever included in a schema-6 record. Closing the view
// discards it entirely.
//
// The tricky part this models explicitly: selection may survive a change of
// search query, so a selected page can be currently HIDDEN by the search.
// Bulk actions still apply to those hidden pages, so every count is reported
// separately (total / visible / hidden) and the delete confirmation states the
// hidden count out loud.

/** Adds every currently VISIBLE key to the selection, leaving hidden selection intact. */
export function selectAllVisible(selected, visibleKeys) {
  const next = new Set(selected);
  for (const key of visibleKeys) next.add(key);
  return next;
}

/** Removes every currently VISIBLE key from the selection, leaving hidden selection intact. */
export function deselectAllVisible(selected, visibleKeys) {
  const next = new Set(selected);
  for (const key of visibleKeys) next.delete(key);
  return next;
}

/** Toggles one row's selection. */
export function toggleSelection(selected, pageKey, isSelected) {
  const next = new Set(selected);
  if (isSelected) next.add(pageKey);
  else next.delete(pageKey);
  return next;
}

/** Clears the entire selection, visible and hidden alike. */
export function clearSelection() {
  return new Set();
}

/**
 * Drops any selected key that no longer exists in savedPages (e.g. it was
 * deleted in another view, or Clear all ran), so a stale selection can never
 * target a record that is already gone.
 */
export function pruneSelection(selected, savedPages) {
  const next = new Set();
  for (const key of selected) {
    if (Object.prototype.hasOwnProperty.call(savedPages ?? {}, key)) next.add(key);
  }
  return next;
}

/**
 * Header checkbox tri-state, computed over the VISIBLE rows only:
 *   'checked'       - every visible row is selected (and there is at least one)
 *   'unchecked'     - no visible row is selected (or nothing is visible)
 *   'indeterminate' - some but not all visible rows are selected
 */
export function headerCheckboxState(selected, visibleKeys) {
  const visible = Array.from(visibleKeys ?? []);
  if (visible.length === 0) return 'unchecked';
  let selectedVisible = 0;
  for (const key of visible) {
    if (selected.has(key)) selectedVisible += 1;
  }
  if (selectedVisible === 0) return 'unchecked';
  if (selectedVisible === visible.length) return 'checked';
  return 'indeterminate';
}

/**
 * Selection counts. `hidden` is the number of selected pages that exist but
 * are currently filtered out by the search - the number a destructive bulk
 * action must announce.
 */
export function selectionCounts(selected, visibleKeys) {
  const visibleSet = new Set(visibleKeys ?? []);
  let visible = 0;
  for (const key of selected) {
    if (visibleSet.has(key)) visible += 1;
  }
  const total = selected.size;
  return { total, visible, hidden: total - visible };
}

/** Human-readable selection summary, e.g. "Selected: 7 total, 3 visible, 4 hidden by search". */
export function describeSelection(counts) {
  if (counts.total === 0) return 'Selected: none';
  const parts = [`${counts.total} total`, `${counts.visible} visible`];
  if (counts.hidden > 0) parts.push(`${counts.hidden} hidden by search`);
  return `Selected: ${parts.join(', ')}`;
}

/** Confirmation text for Delete selected - always states the hidden count when non-zero. */
export function describeDeleteConfirmation(counts) {
  const lines = [`Delete ${counts.total} selected saved ${counts.total === 1 ? 'page' : 'pages'}?`];
  if (counts.hidden > 0) {
    lines.push(`${counts.hidden} selected ${counts.hidden === 1 ? 'page is' : 'pages are'} currently hidden by the search.`);
  }
  lines.push('Active boosting for these exact pages will be stopped.');
  return lines.join(' ');
}

/**
 * Folds a bulk operation's structured per-page results back into the
 * selection: a page that SUCCEEDED is removed from the selection, and a page
 * that FAILED stays selected so the user can retry it. A result for a page
 * that is not selected is ignored.
 */
export function applyBulkResultsToSelection(selected, results) {
  const next = new Set(selected);
  for (const result of results ?? []) {
    if (result && result.ok === true && typeof result.pageKey === 'string') {
      next.delete(result.pageKey);
    }
  }
  return next;
}

/** Summarizes a bulk result set, never reporting complete success when any page failed. */
export function summarizeBulkResults(results, { verb = 'Updated', suffix = '' } = {}) {
  const list = Array.isArray(results) ? results : [];
  const succeeded = list.filter((r) => r && r.ok === true).length;
  const failed = list.length - succeeded;
  const tail = suffix ? ` ${suffix}` : '';
  if (list.length === 0) return 'Nothing to do.';
  if (failed === 0) return `${verb} ${succeeded} ${succeeded === 1 ? 'page' : 'pages'}${tail}.`;
  if (succeeded === 0) return `No pages were changed. ${failed} ${failed === 1 ? 'page' : 'pages'} failed.`;
  return `${verb} ${succeeded} ${succeeded === 1 ? 'page' : 'pages'}${tail}. ${failed} ${failed === 1 ? 'page' : 'pages'} failed.`;
}
