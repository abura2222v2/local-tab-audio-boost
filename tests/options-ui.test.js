// Structural tests for the Saved pages view's action labels and its
// collapsed destructive section.
//
// The behavioral halves of these guarantees live elsewhere and are exercised
// against real code rather than source text:
//  - what "Deselect all" actually does to a selection -> saved-pages-view-model tests;
//  - what Delete selected / Clear all do to storage and to live sessions ->
//    service-worker-logic tests;
//  - the clear-all confirmation transitions -> options-clear-confirm tests.
// This file covers what only the markup and stylesheet can express: the label
// the user reads, and the fact that the destructive block starts collapsed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

const html = () => read('options/options.html');
const js = () => read('options/options.js');

// ===========================================================================
// Action labels
// ===========================================================================

test('ui #1: the deselect control is labelled "Deselect all"', () => {
  const markup = html();
  const button = (markup.match(/<button id="clear-selection"[\s\S]*?<\/button>/) || [''])[0];
  assert.ok(button.length > 0, 'the deselect button exists');
  assert.match(button, /Deselect all/, 'its visible text is "Deselect all"');
  assert.equal(/Clear selection/.test(markup), false, 'the old "Clear selection" label is gone everywhere');
});

test('ui: the three destructive/selection actions stay distinct and separately labelled', () => {
  const markup = html();
  assert.match(markup, /<button id="delete-selected"[\s\S]*?Delete selected[\s\S]*?<\/button>/, 'Delete selected exists');
  assert.match(markup, /<button id="clear-selection"[\s\S]*?Deselect all[\s\S]*?<\/button>/, 'Deselect all exists');
  assert.match(markup, /<button id="clear-button"[\s\S]*?Clear all saved pages[\s\S]*?<\/button>/, 'Clear all saved pages exists');
  // Delete selected must never be renamed into the clear-all wording.
  const deleteSelected = (markup.match(/<button id="delete-selected"[\s\S]*?<\/button>/) || [''])[0];
  assert.equal(/Clear all/.test(deleteSelected), false, 'Delete selected is not relabelled "Clear all"');
});

test('ui #3/#4/#5: the deselect handler only changes selection - no delete, no volume, no capture message', () => {
  const source = js();
  const handler = (source.match(/els\.clearSelection\.addEventListener\('click',[\s\S]*?\n\}\);/) || [''])[0];
  assert.ok(handler.length > 0, 'the deselect click handler was found');
  assert.match(handler, /clearSelection\(\)/, 'it clears the selection set');
  for (const forbidden of ['DELETE_SELECTED_SAVED_PAGES', 'REMOVE_SAVED_PAGE', 'CLEAR_SAVED_PAGES', 'RESET_SELECTED', 'SET_TAB_GAIN', 'STOP_CAPTURE', 'UPDATE_SAVED_PAGE_VOLUME']) {
    assert.equal(handler.includes(forbidden), false, `deselect must not send ${forbidden}`);
  }
  assert.equal(/sendMessage\(/.test(handler), false, 'deselect sends no message at all - it is pure view state');
});

// ===========================================================================
// Collapsed destructive section
// ===========================================================================

test('ui #8: the destructive section is a native <details> that starts collapsed', () => {
  const markup = html();
  const details = (markup.match(/<details id="destructive-section"[\s\S]*?<\/details>/) || [''])[0];
  assert.ok(details.length > 0, 'the destructive section exists as <details>');

  const openingTag = (details.match(/<details[^>]*>/) || [''])[0];
  assert.equal(/\bopen\b/.test(openingTag), false, 'it has no `open` attribute, so it renders collapsed');
  assert.equal(/\.open\s*=\s*true/.test(js()), false, 'no script force-opens it');
  assert.equal(/destructiveSection\.open/.test(js()), false, 'the expanded state is never scripted or restored');
});

test('ui #9: expanding reveals the explanation and the Clear-all button, both inside the section', () => {
  const details = (html().match(/<details id="destructive-section"[\s\S]*?<\/details>/) || [''])[0];
  assert.match(details, /<summary[^>]*>\s*Delete all saved pages\s*<\/summary>/, 'the summary states what it affects');
  assert.match(details, /every<\/strong> saved page/, 'the explanation says it removes every saved page');
  assert.match(details, /hidden by the\s+current search/, 'it warns that hidden pages are included');
  assert.match(details, /not selected/, 'it warns that unselected pages are included');
  assert.match(details, /id="clear-button"/, 'the destructive button lives inside the collapsed section');
  assert.match(details, /id="clear-confirm"/, 'so does its confirmation');
});

test('ui: the expanded state is never persisted', () => {
  const source = js();
  assert.equal(/destructive[^\n]*storage/i.test(source), false, 'no storage write for the disclosure state');
  assert.equal(/localStorage/.test(source), false, 'no localStorage anywhere in the options view');
});

test('ui: the Clear-all action appears exactly once (never duplicated outside the section)', () => {
  const markup = html();
  assert.equal((markup.match(/id="clear-button"/g) || []).length, 1);
  assert.equal((markup.match(/id="clear-confirm"/g) || []).length, 1);
  assert.equal((markup.match(/Clear all saved pages/g) || []).length, 1);
});

// ===========================================================================
// Confirmation visibility
// ===========================================================================

test('ui #10: the clear-all confirmation starts hidden in the markup', () => {
  assert.match(html(), /id="clear-confirm"[^>]*\shidden(\s|>)/);
});

test('ui #19: the effective [hidden] rule still wins over every author display rule', () => {
  const css = stripCssComments(read('options/options.css'));
  const hiddenBlocks = css.match(/[^{}]*\[hidden\][^{}]*\{[^}]*\}/g) || [];
  assert.ok(hiddenBlocks.length >= 1, 'a [hidden] rule exists');
  assert.ok(
    hiddenBlocks.some((b) => /display\s*:\s*none\s*!important/i.test(b)),
    '[hidden] { display: none !important } is present'
  );
  assert.equal(
    hiddenBlocks.some((b) => /display\s*:\s*(flex|block|grid|inline|inline-block|inline-flex)\b/i.test(b)),
    false,
    'no [hidden] rule sets a visible display'
  );

  // Any rule that gives a confirmation panel a visible display must be beaten
  // by the !important hide above - that is the whole reason it is !important.
  const confirmBlock = (css.match(/\.options__confirm\s*\{[^}]*\}/) || [''])[0];
  assert.match(confirmBlock, /display\s*:\s*flex/i, 'the visible confirmation state uses display:flex');
});

test('ui: the status line is a live region that is not error-only', () => {
  const markup = html();
  assert.match(markup, /id="status-line"[^>]*aria-live="polite"/, 'it starts as a polite live region');
  assert.match(markup, /id="status-line"[^>]*role="status"/, 'it is a status region');
  // Errors raise it to assertive at runtime.
  assert.match(js(), /aria-live'?,\s*kind === 'error' \? 'assertive' : 'polite'/);
});

test('ui: bulk buttons are disabled while nothing is selected', () => {
  const markup = html();
  for (const id of ['reset-selected', 'delete-selected', 'clear-selection']) {
    const button = (markup.match(new RegExp(`<button id="${id}"[\\s\\S]*?</button>`)) || [''])[0];
    assert.match(button, /\sdisabled/, `${id} starts disabled`);
  }
  assert.match(js(), /els\.clearSelection\.disabled = nothingSelected/, 'and is re-enabled only when something is selected');
});

test('import: oversized files are rejected before their contents are read or parsed', () => {
  const js = read('options/options.js');
  const sizeCheck = js.indexOf('file.size > MAX_IMPORT_FILE_BYTES');
  const fileRead = js.indexOf('await file.text()');
  assert.ok(sizeCheck >= 0, 'the import path has an explicit file-size bound');
  assert.ok(fileRead > sizeCheck, 'the bound is enforced before File.text() allocates the contents');
});

test('import: the final outcome keeps the skipped-entry count visible', () => {
  const js = read('options/options.js');
  assert.match(js, /const skippedMessage\s*=/);
  assert.match(js, /reportBulkOutcome\(results,\s*\{\s*verb:\s*'Imported'\s*\},\s*skippedMessage\)/);
});

test('import: lists larger than one message are sent in bounded batches instead of truncated', () => {
  const js = read('options/options.js');
  assert.match(js, /offset\s*\+=\s*MAX_BULK_PAGE_KEYS/);
  assert.match(js, /entries\.slice\(offset,\s*offset\s*\+\s*MAX_BULK_PAGE_KEYS\)/);
  assert.doesNotMatch(js, /sanitizeImportEntries\(rawEntries,\s*MAX_BULK_PAGE_KEYS\)/);
});

test('saved rules: the options page has a direct URL form with all four matching scopes', () => {
  const markup = html();
  assert.match(markup, /id="add-rule-form"/);
  assert.match(markup, /id="add-url-input"[^>]*type="url"/);
  for (const mode of ['exact', 'page', 'path', 'site']) {
    assert.match(markup, new RegExp(`<option value="${mode}">`));
  }
});

test('saved rules: submitting the options form sends its selected match mode without opening the URL', () => {
  const source = js();
  assert.match(source, /els\.addRuleForm\.addEventListener\('submit'/);
  assert.match(source, /matchMode:\s*els\.addScopeSelect\.value/);
  assert.match(source, /MESSAGE_TYPES\.ADD_PAGE_MANUAL/);
  assert.doesNotMatch(source, /window\.open|chrome\.tabs\.create/);
});
