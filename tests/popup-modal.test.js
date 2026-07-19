// Regression tests for the "Add URL manually" modal visibility bug.
//
// The bug: popup.css's `.popup__overlay { display: flex }` (an author rule)
// overrode the browser's default `[hidden] { display: none }`, so the modal
// stayed on screen even when its `hidden` attribute was set - it appeared at
// popup startup and could not be closed. These tests lock in both the CSS
// fix (an authoritative `[hidden] { display: none !important }` rule) and the
// popup's open/close/save/escape/overlay behavior, so the bug cannot return.
//
// Two layers, zero dependencies:
//  - behavioral: the pure shared/manual-add-modal.js controller, driven
//    against a tiny fake modal element (just `{ hidden }`), no real DOM;
//  - source-inspection: the actual popup.html / popup.css / popup.js files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createManualAddModalController } from '../shared/manual-add-modal.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');
// Strip /* ... */ comments so selector/rule matching never trips over
// example CSS quoted inside a comment.
const stripCssComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

function makeController({ submitResult = { ok: true } } = {}) {
  const modal = { hidden: true }; // starts hidden, exactly like the static HTML
  const calls = { resetFields: 0, submit: 0, onClosed: 0 };
  const controller = createManualAddModalController({
    modal,
    resetFields: () => {
      calls.resetFields += 1;
    },
    submit: async () => {
      calls.submit += 1;
      return submitResult;
    },
    onClosed: () => {
      calls.onClosed += 1;
    },
  });
  return { controller, modal, calls };
}

// ===========================================================================
// Behavioral (pure controller)
// ===========================================================================

test('modal: starts hidden on construction (never auto-opened)', () => {
  const { controller, modal } = makeController();
  assert.equal(modal.hidden, true);
  assert.equal(controller.isOpen(), false);
});

test('modal: open() shows it and resets the fields (stale error cleared) first', () => {
  const { controller, modal, calls } = makeController();
  controller.open();
  assert.equal(modal.hidden, false);
  assert.equal(controller.isOpen(), true);
  assert.equal(calls.resetFields, 1, 'fields (incl. error text) are reset on every open');
});

test('modal: reopening always re-runs the field reset (no stale error carries over)', () => {
  const { controller, calls } = makeController();
  controller.open();
  controller.close();
  controller.open();
  assert.equal(calls.resetFields, 2);
});

test('modal: Cancel (close) always hides it', () => {
  const { controller, modal } = makeController();
  controller.open();
  controller.close();
  assert.equal(modal.hidden, true);
  assert.equal(controller.isOpen(), false);
});

test('modal: a successful Save closes it', async () => {
  const { controller, modal, calls } = makeController({ submitResult: { ok: true } });
  controller.open();
  const result = await controller.save();
  assert.equal(calls.submit, 1);
  assert.deepEqual(result, { ok: true });
  assert.equal(modal.hidden, true, 'a successful save closes the modal');
});

test('modal: a failed Save keeps it open', async () => {
  const { controller, modal } = makeController({ submitResult: { ok: false } });
  controller.open();
  const result = await controller.save();
  assert.deepEqual(result, { ok: false });
  assert.equal(modal.hidden, false, 'a failed save leaves the modal open so the error is visible');
  assert.equal(controller.isOpen(), true);
});

test('modal: Escape closes it while open, and is a harmless no-op while closed', () => {
  const { controller, modal, calls } = makeController();
  controller.onEscape(); // closed -> nothing happens
  assert.equal(modal.hidden, true);
  assert.equal(calls.onClosed, 0);

  controller.open();
  controller.onEscape(); // open -> closes
  assert.equal(modal.hidden, true);
  assert.equal(calls.onClosed, 1);
});

test('modal: a click on the overlay backdrop closes it; a click on/inside the panel does not', () => {
  const { controller, modal } = makeController();
  const overlay = modal; // the overlay element the pointer handler is bound to
  const panel = { contains: (t) => t === panel || t === 'inner-child' };

  // Click inside the panel (target is the panel itself) -> stays open.
  controller.open();
  controller.onOverlayPointerDown(panel, panel);
  assert.equal(modal.hidden, false, 'clicking the panel does not close');

  // Click on a descendant inside the panel -> stays open.
  controller.onOverlayPointerDown('inner-child', panel);
  assert.equal(modal.hidden, false, 'clicking inside the panel does not close');

  // Click on the overlay backdrop itself -> closes.
  controller.onOverlayPointerDown(overlay, panel);
  assert.equal(modal.hidden, true, 'clicking the backdrop closes');
});

test('modal: overlay clicks are ignored while it is already closed', () => {
  const { controller, modal, calls } = makeController();
  controller.onOverlayPointerDown(modal, { contains: () => false });
  assert.equal(modal.hidden, true);
  assert.equal(calls.onClosed, 0);
});

// ===========================================================================
// Source-inspection of the actual popup files
// ===========================================================================

test('source: the modal overlay element carries the hidden attribute in popup.html', () => {
  const html = read('popup/popup.html');
  // The overlay div starts with `hidden` (authoritative initial state).
  assert.match(html, /id="manual-add-overlay"[^>]*\shidden(\s|>)/);
});

test('source: popup.css has an effective [hidden] rule with display:none and !important', () => {
  const css = stripCssComments(read('popup/popup.css'));
  // Every rule block whose selector references [hidden].
  const hiddenBlocks = css.match(/[^{}]*\[hidden\][^{}]*\{[^}]*\}/g) || [];
  assert.ok(hiddenBlocks.length >= 1, 'at least one [hidden] rule exists');

  const normalized = (s) => s.replace(/\s+/g, ' ').toLowerCase();
  // At least one [hidden] rule sets display:none !important.
  const hasEffectiveHide = hiddenBlocks.some((b) => {
    const body = normalized(b);
    return /display\s*:\s*none\s*!important/.test(body);
  });
  assert.ok(hasEffectiveHide, '[hidden] { display: none !important } is present');

  // No [hidden] rule may set a VISIBLE display (would contradict the hide).
  const contradicts = hiddenBlocks.some((b) => /display\s*:\s*(flex|block|grid|inline|inline-block|inline-flex)\b/i.test(b));
  assert.equal(contradicts, false, 'no [hidden] rule sets a visible display');
});

test('source: the !important is genuinely required - .popup__overlay sets display:flex for the visible state', () => {
  const css = stripCssComments(read('popup/popup.css'));
  const overlayBlock = (css.match(/\.popup__overlay\s*\{[^}]*\}/) || [''])[0];
  assert.match(overlayBlock, /display\s*:\s*flex/i, 'the visible overlay state uses display:flex, so hide must use !important');
});

test('source: exactly one [hidden] display rule remains (no duplicate/contradictory selectors)', () => {
  const css = stripCssComments(read('popup/popup.css'));
  const hiddenBlocks = (css.match(/[^{}]*\[hidden\][^{}]*\{[^}]*\}/g) || []).filter((b) => /display\s*:/i.test(b));
  assert.equal(hiddenBlocks.length, 1, 'a single, authoritative [hidden] display rule');
});

test('source: popup.js opens the modal ONLY from the "Add URL manually" button, never at startup', () => {
  const js = read('popup/popup.js');
  // The overlay is never opened by directly poking .hidden = false anywhere;
  // all visibility flows through the controller (which owns modal.hidden).
  assert.equal(/manualAddOverlay\.hidden\s*=\s*false/.test(js), false, 'no ad-hoc hidden=false on the overlay');
  // The only open() call is wired to the manual-add button's click handler.
  const openCalls = js.match(/manualModal\.open\(\)/g) || [];
  assert.equal(openCalls.length, 1, 'exactly one manualModal.open() call site');
  assert.match(
    js,
    /manualAddButton\.addEventListener\(\s*'click'\s*,\s*\(\)\s*=>\s*\{[^}]*manualModal\.open\(\)/,
    'the open() call is inside the manual-add button click handler'
  );
  // No startup/init code opens the modal.
  const initBody = (js.match(/async function init\(\)\s*\{[\s\S]*?\n\}/) || [''])[0];
  assert.equal(/manualModal\.open\(\)/.test(initBody), false, 'init() never opens the modal');
});

test('source: popup.js wires Cancel, Save, Escape, and overlay-backdrop to the controller', () => {
  const js = read('popup/popup.js');
  assert.match(js, /manualAddCancel\.addEventListener\(\s*'click'\s*,\s*\(\)\s*=>\s*manualModal\.close\(\)\s*\)/, 'Cancel -> close');
  assert.match(js, /manualAddSave\.addEventListener\(\s*'click'\s*,\s*\(\)\s*=>\s*manualModal\.save\(\)\s*\)/, 'Save -> save (controller closes only on ok)');
  assert.match(js, /key\s*===\s*'Escape'\s*\)\s*manualModal\.onEscape\(\)/, 'Escape -> onEscape');
  assert.match(js, /manualAddOverlay\.addEventListener\(\s*'mousedown'[\s\S]*manualModal\.onOverlayPointerDown/, 'overlay mousedown -> onOverlayPointerDown');
});

test('source: popup.js resetFields clears the stale error text on open', () => {
  const js = read('popup/popup.js');
  assert.match(js, /resetFields:\s*\(\)\s*=>\s*\{[\s\S]*manualAddError\.textContent\s*=\s*''/, 'resetFields clears the error text');
});

test('source: the submit path returns {ok:false} on validation/save failure (so the controller keeps the modal open)', () => {
  const js = read('popup/popup.js');
  const submitBlock = (js.match(/submit:\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\n  \},/) || [''])[0];
  assert.ok(submitBlock.length > 0, 'submit callback found');
  assert.match(submitBlock, /return\s*\{\s*ok:\s*false\s*\}/, 'empty-URL / failed-save paths return ok:false');
  assert.match(submitBlock, /return\s*\{\s*ok:\s*true\s*\}/, 'success path returns ok:true');
});
