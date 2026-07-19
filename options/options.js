// Saved-pages management only - view, per-row volume, delete, clear all.
// Adding a new saved page happens exclusively from the popup ("Add this
// page" / "Add URL manually"); this view never opens the page it lists,
// never captures a tab, and never grants a domain-wide permission. Every
// read and write goes through the service worker; this file never calls
// chrome.storage.local directly.

import { TARGETS, MESSAGE_TYPES, MIN_GAIN_PERCENT, MAX_GAIN_PERCENT } from '../shared/constants.js';
import { registerMessageHandler, sendMessage, validateServiceWorkerOriginatedSender } from '../shared/messages.js';

const els = {
  list: document.getElementById('page-list'),
  emptyState: document.getElementById('empty-state'),
  listError: document.getElementById('list-error'),
  clearButton: document.getElementById('clear-button'),
  clearConfirm: document.getElementById('clear-confirm'),
  clearConfirmYes: document.getElementById('clear-confirm-yes'),
  clearConfirmCancel: document.getElementById('clear-confirm-cancel'),
};

function renderList(savedPages) {
  const entries = Object.entries(savedPages).sort(([a], [b]) => a.localeCompare(b));
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

    // `input` (continuous, while dragging) only updates the on-screen
    // number - it never writes storage. `change` (once, on commit) is the
    // only thing that sends UPDATE_SAVED_PAGE_VOLUME - this updates ONLY
    // this exact URL's saved default, and only after a failed live update
    // is the list re-fetched to recover the authoritative on-screen state
    // (the stored value itself is never corrupted by a failed live
    // propagation - see handleUpdateSavedPageVolume in service-worker.js).
    slider.addEventListener('input', () => {
      volumeSpan.textContent = `${slider.value}%`;
    });
    slider.addEventListener('change', async () => {
      const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.UPDATE_SAVED_PAGE_VOLUME, {
        pageKey,
        gainPercent: Number(slider.value),
      });
      if (!response.ok) {
        els.listError.textContent = response.error?.message ?? "Could not update this page's volume.";
        await refresh();
        return;
      }
      els.listError.textContent = '';
    });

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'options__remove-button';
    removeButton.textContent = '✕';
    removeButton.setAttribute('aria-label', `Delete ${pageKey}`);
    removeButton.addEventListener('click', () => removePage(pageKey));

    item.append(keySpan, slider, volumeSpan, removeButton);
    els.list.append(item);
  }
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

els.clearButton.addEventListener('click', () => {
  els.clearConfirm.hidden = false;
  els.clearButton.hidden = true;
});

els.clearConfirmCancel.addEventListener('click', () => {
  els.clearConfirm.hidden = true;
  els.clearButton.hidden = false;
});

els.clearConfirmYes.addEventListener('click', async () => {
  els.clearConfirm.hidden = true;
  els.clearButton.hidden = false;
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.CLEAR_SAVED_PAGES, {});
  if (!response.ok) {
    els.listError.textContent = response.error?.message ?? 'Could not clear saved pages.';
    return;
  }
  await refresh();
});

async function handleOptionsMessage(message) {
  if (message.type === MESSAGE_TYPES.SAVED_PAGES_CHANGED) {
    renderList(message.payload?.savedPages ?? {});
  }
  return { ok: true, data: {} };
}

// Only the service worker ever sends a message addressed to this page -
// see validateServiceWorkerOriginatedSender's own doc comment in
// shared/messages.js for exactly what is and isn't trusted here.
registerMessageHandler(TARGETS.OPTIONS, handleOptionsMessage, { validateSender: validateServiceWorkerOriginatedSender });

refresh();
