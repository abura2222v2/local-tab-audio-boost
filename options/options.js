// Saved-pages management only - view, per-row volume, delete, clear all.
// Adding a new saved page happens exclusively from the popup ("Add this
// page" / "Add URL manually"); this view never opens the page it lists,
// never captures a tab, and never grants a domain-wide permission. Every
// read and write goes through the service worker; this file never calls
// chrome.storage.local directly.

import { TARGETS, MESSAGE_TYPES, MIN_GAIN_PERCENT, MAX_GAIN_PERCENT } from '../shared/constants.js';
import { registerMessageHandler, sendMessage, validateServiceWorkerOriginatedSender } from '../shared/messages.js';
import { createSavedPageSliderController } from '../shared/saved-page-slider.js';
import { createClearConfirmController } from '../shared/clear-confirm.js';

const els = {
  list: document.getElementById('page-list'),
  emptyState: document.getElementById('empty-state'),
  listError: document.getElementById('list-error'),
  clearButton: document.getElementById('clear-button'),
  clearConfirm: document.getElementById('clear-confirm'),
  clearConfirmYes: document.getElementById('clear-confirm-yes'),
  clearConfirmCancel: document.getElementById('clear-confirm-cancel'),
};

// One entry per currently-rendered row, keyed by its exact pageKey. Lets an
// incoming SAVED_PAGE_LIVE_GAIN_CHANGED broadcast (the popup slider driving a
// live gain) move ONLY the matching exact row, without a full re-render, and
// lets renderList() dispose the previous rows' throttle timers.
const rows = new Map(); // pageKey -> { slider, volumeSpan, controller }

function disposeRows() {
  for (const row of rows.values()) row.controller.dispose();
  rows.clear();
}

function renderList(savedPages) {
  const entries = Object.entries(savedPages).sort(([a], [b]) => a.localeCompare(b));
  disposeRows();
  els.list.textContent = '';
  els.emptyState.hidden = entries.length > 0;

  for (const [pageKey, volumePercent] of entries) {
    const item = document.createElement('li');
    item.className = 'options__list-item';

    const keySpan = document.createElement('span');
    keySpan.className = 'options__page-key';
    keySpan.textContent = pageKey;
    keySpan.title = pageKey;

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(MIN_GAIN_PERCENT);
    slider.max = String(MAX_GAIN_PERCENT);
    slider.step = '1';
    slider.value = String(volumePercent);
    slider.className = 'options__row-slider';
    slider.setAttribute('aria-label', `Volume for ${pageKey}, ${MIN_GAIN_PERCENT} to ${MAX_GAIN_PERCENT} percent`);

    const volumeSpan = document.createElement('span');
    volumeSpan.className = 'options__volume';
    volumeSpan.textContent = `${volumePercent}%`;

    // The pure, DOM-free controller owns the live-vs-persist timing for THIS
    // exact row (see shared/saved-page-slider.js):
    //  - `input` (while dragging) drives a THROTTLED, LIVE-ONLY gain to the
    //    service worker (SET_SAVED_PAGE_LIVE_GAIN) - it changes the audio of
    //    any tab currently boosting this identical exact URL, but writes
    //    NOTHING to storage;
    //  - `change` (on release) flushes the final live value, then persists it
    //    exactly once through UPDATE_SAVED_PAGE_VOLUME. Only after a failed
    //    persist is the list re-fetched to recover the authoritative on-screen
    //    state (the stored value itself is never corrupted by a failed live
    //    propagation - see handleUpdateSavedPageVolume in service-worker.js).
    const controller = createSavedPageSliderController({
      sendLiveGain: (value) => {
        sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.SET_SAVED_PAGE_LIVE_GAIN, { pageKey, gainPercent: value });
      },
      persist: async (value) => {
        const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, {
          pageKey,
          gainPercent: value,
        });
        if (!response.ok) {
          els.listError.textContent = response.error?.message ?? "Could not update this page's volume.";
          await refresh();
          return response;
        }
        els.listError.textContent = '';
        return response;
      },
    });

    slider.addEventListener('input', () => {
      volumeSpan.textContent = `${slider.value}%`;
      controller.onInput(Number(slider.value));
    });
    slider.addEventListener('change', () => {
      controller.onChange(Number(slider.value));
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'options__remove-button';
    removeButton.textContent = '✕';
    removeButton.setAttribute('aria-label', `Delete ${pageKey}`);
    removeButton.addEventListener('click', () => removePage(pageKey));

    item.append(keySpan, slider, volumeSpan, removeButton);
    els.list.append(item);
    rows.set(pageKey, { slider, volumeSpan, controller });
  }
}

/**
 * Moves ONLY the matching exact row's slider + percentage to a live gain
 * driven by the popup slider (a SAVED_PAGE_LIVE_GAIN_CHANGED broadcast). It
 * never persists and never re-renders the whole list; a pageKey with no
 * currently-rendered row (e.g. an unsaved page) is a harmless no-op.
 */
function applyLiveGainToRow(pageKey, gainPercent) {
  const row = rows.get(pageKey);
  if (!row) return;
  row.slider.value = String(gainPercent);
  row.volumeSpan.textContent = `${gainPercent}%`;
}

async function refresh() {
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.GET_SAVED_PAGES, {});
  if (!response.ok) {
    els.listError.textContent = response.error?.message ?? 'Could not load saved pages.';
    return;
  }
  els.listError.textContent = '';
  renderList(response.data.savedPages ?? {});
}

async function removePage(pageKey) {
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey });
  if (!response.ok) {
    els.listError.textContent = response.error?.message ?? 'Could not delete this page.';
    return;
  }
  await refresh();
}

// The "Clear all" confirmation starts hidden (its `hidden` attribute is set in
// the static HTML and turned into `display: none !important` by options.css).
// The pure controller in shared/clear-confirm.js owns the show/cancel/confirm/
// escape transitions; a FAILED clear keeps the confirmation visible and shows
// the real error rather than dismissing itself.
const clearConfirm = createClearConfirmController({
  confirmEl: els.clearConfirm,
  clearButtonEl: els.clearButton,
  performClear: () => sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.CLEAR_SAVED_PAGES, {}),
  showError: (message) => {
    els.listError.textContent = message;
  },
});

els.clearButton.addEventListener('click', () => clearConfirm.show());
els.clearConfirmCancel.addEventListener('click', () => clearConfirm.hide());
els.clearConfirmYes.addEventListener('click', async () => {
  const result = await clearConfirm.confirm();
  if (result.ok) {
    els.listError.textContent = '';
    await refresh();
  }
});

// Escape closes the confirmation (only while it is open).
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') clearConfirm.onEscape();
});

async function handleOptionsMessage(message) {
  if (message.type === MESSAGE_TYPES.SAVED_PAGES_CHANGED) {
    renderList(message.payload?.savedPages ?? {});
  } else if (message.type === MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED) {
    // The popup slider is driving a live gain for one exact page - move just
    // that row (never persists, never re-renders the whole list).
    applyLiveGainToRow(message.payload?.pageKey, message.payload?.gainPercent);
  }
  return { ok: true, data: {} };
}

// Only the service worker ever sends a message addressed to this page -
// see validateServiceWorkerOriginatedSender's own doc comment in
// shared/messages.js for exactly what is and isn't trusted here.
registerMessageHandler(TARGETS.OPTIONS, handleOptionsMessage, { validateSender: validateServiceWorkerOriginatedSender });

// A closing options page must not leave a row's trailing throttle timer armed.
window.addEventListener('pagehide', disposeRows);

refresh();
