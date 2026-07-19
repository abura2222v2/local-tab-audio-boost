import { TARGETS, MESSAGE_TYPES, MIN_GAIN_PERCENT, MAX_GAIN_PERCENT } from '../shared/constants.js';
import { registerMessageHandler, sendMessage, validateServiceWorkerOriginatedSender } from '../shared/messages.js';
import { createPopupController } from '../shared/popup-controller.js';
import { createManualAddModalController } from '../shared/manual-add-modal.js';

const els = {
  pageUrl: document.getElementById('page-url'),
  statusLine: document.getElementById('status-line'),
  sliderArea: document.getElementById('slider-area'),
  percentDisplay: document.getElementById('percent-display'),
  slider: document.getElementById('gain-slider'),
  controls: document.querySelector('.popup__controls'),
  addButton: document.getElementById('add-button'),
  manualAddButton: document.getElementById('manual-add-button'),
  savedPagesButton: document.getElementById('saved-pages-button'),
  toggleButton: document.getElementById('toggle-button'),
  messageArea: document.getElementById('message-area'),
  manualAddOverlay: document.getElementById('manual-add-overlay'),
  manualModalPanel: document.querySelector('#manual-add-overlay .popup__modal'),
  manualUrlInput: document.getElementById('manual-url-input'),
  manualVolumeInput: document.getElementById('manual-volume-input'),
  manualVolumeDisplay: document.getElementById('manual-volume-display'),
  manualAddError: document.getElementById('manual-add-error'),
  manualAddCancel: document.getElementById('manual-add-cancel'),
  manualAddSave: document.getElementById('manual-add-save'),
};

let currentTabId = null;
let currentPageKey = null;
let currentSaved = false;
let currentCaptureState = 'inactive';
let busy = false;

function setMessage(text, isError = false) {
  els.messageArea.textContent = text ?? '';
  els.messageArea.classList.toggle('error', Boolean(isError));
}

function setBusy(isBusy) {
  busy = isBusy;
  document.body.classList.toggle('busy', isBusy);
}

// The DOM-free orchestration of slider-driven start + live gain lives in
// shared/popup-controller.js (and its own deterministic tests). This popup
// is a thin adapter: it wires DOM events to the controller and lends the
// controller its message-sending and slider-display primitives.
const controller = createPopupController({
  startCapture: (payload) => sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.START_CAPTURE, payload),
  setLiveGain: ({ tabId, gainPercent, operationId }) =>
    sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.SET_TAB_GAIN, {
      tabId,
      gainPercent,
      expectedOperationId: operationId,
    }),
  persistVolume: ({ tabId, gainPercent, operationId }) =>
    sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.PERSIST_PAGE_VOLUME, {
      tabId,
      gainPercent,
      expectedOperationId: operationId,
    }),
  refresh: () => refresh(),
  setSliderDisplay: (value) => {
    els.slider.value = String(value);
    els.percentDisplay.textContent = `${value}%`;
  },
});

/** Renders the button/status chrome. The slider value + percent are owned by the controller. */
function renderChrome(state) {
  if (state.restricted) {
    currentPageKey = null;
    currentSaved = false;
    currentCaptureState = 'inactive';
    els.pageUrl.textContent = 'This page cannot be boosted';
    els.pageUrl.title = '';
    els.statusLine.textContent = state.errorMessage || 'Unsupported page.';
    els.sliderArea.hidden = true;
    els.controls.hidden = true;
    return;
  }

  els.sliderArea.hidden = false;
  els.controls.hidden = false;

  currentPageKey = state.pageKey ?? null;
  currentSaved = Boolean(state.saved);
  currentCaptureState = state.state;

  // The main slider always works on any supported page - never disabled
  // merely because a page is unsaved or a session is not yet active.
  els.slider.disabled = false;

  els.pageUrl.textContent = state.displayUrl ?? (state.state === 'resolving' ? 'Loading…' : '');
  els.pageUrl.title = state.displayUrl ?? '';

  els.manualAddButton.disabled = busy;
  els.savedPagesButton.disabled = busy;
  els.addButton.hidden = currentSaved;
  els.addButton.disabled = busy;

  if (state.state === 'active') {
    els.statusLine.textContent = 'Boosting active';
    els.toggleButton.textContent = 'Disable boosting';
    els.toggleButton.disabled = busy;
  } else if (state.state === 'starting' || state.state === 'resolving') {
    els.statusLine.textContent = 'Starting…';
    els.toggleButton.textContent = 'Starting…';
    els.toggleButton.disabled = true;
  } else {
    els.statusLine.textContent = currentSaved ? 'Saved - not currently boosting' : 'Not currently boosting';
    els.toggleButton.textContent = 'Enable boosting';
    els.toggleButton.disabled = busy;
  }
}

function applyState(state) {
  // Slider value / percent + pending-desired reconciliation first, then the
  // button/status chrome (which reads the same state).
  controller.setServerState(state);
  renderChrome(state);
}

async function refresh() {
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.GET_TAB_STATE, { tabId: currentTabId });
  if (!response.ok) {
    setMessage(response.error?.message ?? 'Something went wrong.', true);
    return;
  }
  setMessage('');
  applyState(response.data);
}

async function withBusy(action) {
  if (busy || currentTabId === null) return;
  setBusy(true);
  try {
    const response = await action();
    if (response && !response.ok) {
      setMessage(response.error?.message ?? 'Something went wrong.', true);
    } else {
      setMessage('');
    }
  } finally {
    setBusy(false);
    await refresh();
  }
}

els.slider.addEventListener('input', () => {
  controller.onSliderInput(Number(els.slider.value));
});

els.slider.addEventListener('change', () => {
  controller.onSliderChange(Number(els.slider.value));
});

els.addButton.addEventListener('click', () => {
  withBusy(() =>
    sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.ADD_CURRENT_PAGE, {
      tabId: currentTabId,
      expectedPageKey: currentPageKey,
      gainPercent: Number(els.slider.value),
    })
  );
});

els.toggleButton.addEventListener('click', () => {
  withBusy(() => {
    if (currentCaptureState === 'active') {
      return sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.STOP_CAPTURE, { tabId: currentTabId });
    }
    return controller.onEnableClick();
  });
});

els.savedPagesButton.addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

// --- Add URL manually modal ---
//
// The overlay's `hidden` attribute is the authoritative visibility state
// (popup.css turns it into `display: none !important`). The pure controller
// in shared/manual-add-modal.js owns the open/close/save/escape/overlay
// transitions; this popup only wires DOM events to it and provides the
// field-reset and submit behavior. The modal is NEVER opened at startup - it
// starts hidden via the static HTML `hidden` attribute and opens only from
// the "Add URL manually" button below.
const manualModal = createManualAddModalController({
  modal: els.manualAddOverlay,
  resetFields: () => {
    els.manualUrlInput.value = '';
    els.manualVolumeInput.value = '100';
    els.manualVolumeDisplay.textContent = '100%';
    els.manualAddError.textContent = ''; // reopening always clears stale error text
  },
  submit: async () => {
    const rawUrl = els.manualUrlInput.value.trim();
    els.manualAddError.textContent = '';
    if (!rawUrl) {
      els.manualAddError.textContent = 'Enter a URL.';
      return { ok: false };
    }
    // Saving never opens the page, never captures a tab, and never grants a
    // domain-wide permission - it is a storage-only write, validated and
    // performed exclusively by the service worker.
    const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.ADD_PAGE_MANUAL, {
      rawUrl,
      gainPercent: Number(els.manualVolumeInput.value),
    });
    if (!response.ok) {
      els.manualAddError.textContent = response.error?.message ?? 'That URL could not be added.';
      return { ok: false };
    }
    await refresh();
    return { ok: true };
  },
});

els.manualAddButton.addEventListener('click', () => {
  manualModal.open();
  els.manualUrlInput.focus();
});
els.manualAddCancel.addEventListener('click', () => manualModal.close());
els.manualAddSave.addEventListener('click', () => manualModal.save());

els.manualVolumeInput.addEventListener('input', () => {
  els.manualVolumeDisplay.textContent = `${els.manualVolumeInput.value}%`;
});

// Escape closes the modal (only while it is open).
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') manualModal.onEscape();
});

// A click on the overlay backdrop closes the modal; a click inside the modal
// panel does not.
els.manualAddOverlay.addEventListener('mousedown', (event) => {
  manualModal.onOverlayPointerDown(event.target, els.manualModalPanel);
});

window.addEventListener('pagehide', () => controller.flushFallback());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') controller.flushFallback();
});

async function handlePopupMessage(message) {
  if (message.type === MESSAGE_TYPES.TAB_STATE_CHANGED && message.payload?.tabId === currentTabId) {
    applyState(message.payload);
  } else if (message.type === MESSAGE_TYPES.SAVED_PAGE_CHANGED && message.payload?.pageKey === currentPageKey) {
    // A Saved-pages row for THIS exact page changed its stored value. Refresh
    // so an inactive popup shows the new saved default (an active tab already
    // got its live TAB_STATE_CHANGED above). Exact-page-scoped by the pageKey
    // equality check; never starts capture.
    refresh();
  }
  return { ok: true, data: {} };
}

// Only the service worker ever sends a message addressed to this popup -
// see validateServiceWorkerOriginatedSender's own doc comment in
// shared/messages.js for exactly what is and isn't trusted here.
registerMessageHandler(TARGETS.POPUP, handlePopupMessage, { validateSender: validateServiceWorkerOriginatedSender });

// Drive the slider ranges from the single MAX_GAIN_PERCENT constant rather
// than a separate hard-coded runtime limit (the HTML max is a static
// fallback only).
els.slider.min = String(MIN_GAIN_PERCENT);
els.slider.max = String(MAX_GAIN_PERCENT);
els.manualVolumeInput.min = String(MIN_GAIN_PERCENT);
els.manualVolumeInput.max = String(MAX_GAIN_PERCENT);

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== 'number') {
    setMessage('No active tab found.', true);
    return;
  }
  currentTabId = tab.id;
  await refresh();
}

init();
