// Pure, DOM-light controller for the popup's "Add URL manually" modal. The
// modal element's `hidden` attribute is the single, authoritative source of
// visibility state - this controller only ever flips that boolean; it never
// touches CSS classes or styles (popup.css's `[hidden] { display: none
// !important }` rule turns `hidden` into actual invisibility). Extracted out
// of popup.js so the open/close/save/escape/overlay transitions can be
// tested deterministically under plain Node, without a real DOM.
//
// `modal` need only be an object with a settable boolean `hidden` property -
// a real HTMLElement in the popup, a tiny fake in tests. It starts hidden
// (the popup's static HTML carries the `hidden` attribute, and this
// controller never opens it on construction), so closing and reopening the
// Chrome popup can never leave it visible by default.

export function createManualAddModalController({ modal, resetFields, submit, onClosed }) {
  function open() {
    // Reopening resets stale field/error text before showing.
    resetFields();
    modal.hidden = false;
  }

  function close() {
    modal.hidden = true;
    if (typeof onClosed === 'function') onClosed();
  }

  /**
   * Runs the caller-provided submit (which validates, performs the storage
   * write, and sets any error text itself) and closes ONLY on a successful
   * result. A failed validation or failed save keeps the modal open with its
   * error shown. Returns the submit result for callers/tests.
   */
  async function save() {
    const result = await submit();
    if (result && result.ok) {
      close();
    }
    return result;
  }

  /** Escape closes the modal, but only when it is actually open. */
  function onEscape() {
    if (!modal.hidden) close();
  }

  /**
   * A pointer/click whose target is the overlay backdrop itself closes the
   * modal; a click whose target is anything inside the modal panel does not.
   * The caller passes the event's target and the inner panel element.
   */
  function onOverlayPointerDown(target, panel) {
    if (modal.hidden) return;
    if (target === panel || (panel && typeof panel.contains === 'function' && panel.contains(target))) {
      return; // click landed inside the panel - keep the modal open
    }
    close();
  }

  return {
    open,
    close,
    save,
    onEscape,
    onOverlayPointerDown,
    isOpen: () => !modal.hidden,
  };
}
