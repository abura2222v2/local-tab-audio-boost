// Regression tests for the "Clear all" confirmation visibility bug (it was
// permanently on screen). Two layers, zero dependencies:
//  - behavioral: the pure shared/clear-confirm.js controller, driven against
//    tiny fake elements (just `{ hidden }`), no real DOM;
//  - source-inspection: the actual options.html / options.css / options.js.
//
// The bug mirrored the earlier popup modal bug: options.css's
// `.options__clear-confirm { display: flex }` (an author rule) overrode the
// browser default `[hidden] { display: none }`, so the confirmation stayed
// visible even with its `hidden` attribute set. The fix is an authoritative
// `[hidden] { display: none !important }` plus `hidden` as the source of truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClearConfirmController } from '../shared/clear-confirm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function makeController({ clearResult = { ok: true } } = {}) {
  // Both start exactly like the static HTML: confirmation hidden, button shown.
  const confirmEl = { hidden: true };
  const clearButtonEl = { hidden: false };
  const errors = [];
  let performCalls = 0;
  const controller = createClearConfirmController({
    confirmEl,
    clearButtonEl,
    performClear: async () => {
      performCalls += 1;
      return clearResult;
    },
    showError: (message) => errors.push(message),
  });
  return { controller, confirmEl, clearButtonEl, errors, performCalls: () => performCalls };
}

// ===========================================================================
// Behavioral (pure controller)
// ===========================================================================

test('clear-confirm: starts hidden on construction (never auto-shown)', () => {
  const { controller, confirmEl } = makeController();
  assert.equal(confirmEl.hidden, true);
  assert.equal(controller.isOpen(), false);
});

test('clear-confirm: show() reveals the confirmation and hides the Clear-all button', () => {
  const { controller, confirmEl, clearButtonEl } = makeController();
  controller.show();
  assert.equal(confirmEl.hidden, false);
  assert.equal(clearButtonEl.hidden, true);
  assert.equal(controller.isOpen(), true);
});

test('clear-confirm: hide() (Cancel) hides the confirmation and restores the button', () => {
  const { controller, confirmEl, clearButtonEl } = makeController();
  controller.show();
  controller.hide();
  assert.equal(confirmEl.hidden, true);
  assert.equal(clearButtonEl.hidden, false);
});

test('clear-confirm: a successful confirm() hides it', async () => {
  const { controller, confirmEl, performCalls } = makeController({ clearResult: { ok: true } });
  controller.show();
  const result = await controller.confirm();
  assert.equal(performCalls(), 1);
  assert.deepEqual(result, { ok: true });
  assert.equal(confirmEl.hidden, true, 'a successful clear hides the confirmation');
});

test('clear-confirm: a FAILED confirm() leaves it visible and surfaces the real error', async () => {
  const { controller, confirmEl, errors } = makeController({
    clearResult: { ok: false, error: { code: 'INTERNAL_ERROR', message: 'disk on fire' } },
  });
  controller.show();
  const result = await controller.confirm();
  assert.equal(result.ok, false);
  assert.equal(confirmEl.hidden, false, 'a failed clear leaves the confirmation visible');
  assert.deepEqual(errors, ['disk on fire'], 'the real error message is shown');
});

test('clear-confirm: Escape hides it while open, and is a harmless no-op while closed', () => {
  const { controller, confirmEl } = makeController();
  controller.onEscape(); // closed -> nothing happens
  assert.equal(confirmEl.hidden, true);

  controller.show();
  controller.onEscape(); // open -> closes
  assert.equal(confirmEl.hidden, true);
});

// ===========================================================================
// Source-inspection of the actual options files
// ===========================================================================

test('source: the Clear-all confirmation carries the hidden attribute in options.html', () => {
  const html = read('options/options.html');
  assert.match(html, /id="clear-confirm"[^>]*\shidden(\s|>)/, 'the confirmation div starts with `hidden`');
});

test('source: exactly one Clear-all confirmation panel exists (no duplicates)', () => {
  const html = read('options/options.html');
  const panels = html.match(/id="clear-confirm"/g) || [];
  assert.equal(panels.length, 1, 'a single confirmation panel');
});

test('source: options.css has an effective [hidden] rule with display:none and !important', () => {
  const css = stripCssComments(read('options/options.css'));
  const hiddenBlocks = css.match(/[^{}]*\[hidden\][^{}]*\{[^}]*\}/g) || [];
  assert.ok(hiddenBlocks.length >= 1, 'at least one [hidden] rule exists');

  const normalized = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  const hasEffectiveHide = hiddenBlocks.some((b) => /display\s*:\s*none\s*!important/.test(normalized(b)));
  assert.ok(hasEffectiveHide, '[hidden] { display: none !important } is present');

  const contradicts = hiddenBlocks.some((b) =>
    /display\s*:\s*(flex|block|grid|inline|inline-block|inline-flex)\b/i.test(b)
  );
  assert.equal(contradicts, false, 'no [hidden] rule sets a visible display');
});

test('source: the !important is genuinely required - .options__clear-confirm sets display:flex for the visible state', () => {
  const css = stripCssComments(read('options/options.css'));
  const block = (css.match(/\.options__clear-confirm\s*\{[^}]*\}/) || [''])[0];
  assert.match(block, /display\s*:\s*flex/i, 'the visible confirmation uses display:flex, so hide must use !important');
});

test('source: options.js never auto-shows the confirmation at startup', () => {
  const js = read('options/options.js');
  // No ad-hoc `clearConfirm.hidden = false` anywhere - all visibility flows
  // through the controller (which owns the hidden state).
  assert.equal(/clearConfirm\.hidden\s*=\s*false/.test(js), false, 'no ad-hoc hidden=false on the confirmation');
  // The only show() call is wired to the Clear-all button's click handler.
  const showCalls = js.match(/clearConfirm\.show\(\)/g) || [];
  assert.equal(showCalls.length, 1, 'exactly one clearConfirm.show() call site');
  assert.match(
    js,
    /clearButton\.addEventListener\(\s*'click'\s*,\s*\(\)\s*=>\s*clearConfirm\.show\(\)/,
    'show() is wired to the Clear-all button click'
  );
});

test('source: options.js wires Cancel, Escape, and confirm to the controller', () => {
  const js = read('options/options.js');
  assert.match(js, /clearConfirmCancel\.addEventListener\(\s*'click'\s*,\s*\(\)\s*=>\s*clearConfirm\.hide\(\)/, 'Cancel -> hide');
  assert.match(js, /key\s*===\s*'Escape'\s*\)\s*clearConfirm\.onEscape\(\)/, 'Escape -> onEscape');
  assert.match(js, /clearConfirm\.confirm\(\)/, 'Yes -> confirm');
});
