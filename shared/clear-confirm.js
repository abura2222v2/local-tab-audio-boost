// Pure, DOM-free controller for the Saved-pages "Clear all" confirmation
// step. Extracted out of options.js so its open/cancel/confirm/escape
// transitions can be unit-tested deterministically under plain Node, without
// a DOM - and so the "confirmation is hidden until explicitly requested" rule
// is locked in behaviorally, not only by inspecting the HTML/CSS.
//
// `confirmEl`/`clearButtonEl` are the two elements whose `hidden` attribute is
// the authoritative visibility state (options.css turns `[hidden]` into
// `display: none !important`, so the confirmation is invisible whenever its
// `hidden` attribute is set, regardless of any layout `display` rule). The
// controller only ever toggles `.hidden`; it never uses ad-hoc inline styles.
//
// Transitions:
//  - starts hidden (the static HTML sets `hidden` on the confirmation);
//  - show(): reveals the confirmation, hides the "Clear all" button;
//  - hide(): hides the confirmation, restores the "Clear all" button;
//  - confirm(): runs the caller's async `performClear`; on success hides,
//    on failure LEAVES IT VISIBLE and surfaces the real error (so the user
//    can see what went wrong and retry / cancel);
//  - onEscape(): hides only while open (a harmless no-op while closed).

export function createClearConfirmController({ confirmEl, clearButtonEl, performClear, showError }) {
  function isOpen() {
    return confirmEl.hidden === false;
  }

  function show() {
    confirmEl.hidden = false;
    if (clearButtonEl) clearButtonEl.hidden = true;
  }

  function hide() {
    confirmEl.hidden = true;
    if (clearButtonEl) clearButtonEl.hidden = false;
  }

  async function confirm() {
    const result = await performClear();
    if (!result || !result.ok) {
      // A failed clear keeps the confirmation visible and shows the real
      // error, rather than silently dismissing itself.
      if (showError) showError(result?.error?.message ?? 'Could not clear saved pages.');
      return result ?? { ok: false };
    }
    hide();
    return result;
  }

  function onEscape() {
    if (isOpen()) hide();
  }

  return { isOpen, show, hide, confirm, onEscape };
}
