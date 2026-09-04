// Saved-pages management: view, search, select, per-row volume, rename,
// delete, bulk actions, and clear all. Adding a new saved page happens
// exclusively from the popup ("Add this page" / "Add URL manually"); this view
// never opens the page it lists, never captures a tab, and never grants a
// domain-wide permission.
//
// Every read and write goes through the service worker; this file never calls
// chrome.storage.local directly. It also performs NO network access of any
// kind: search, display names, and fallback labels are all derived locally
// from data already in storage (see shared/saved-pages-search.js and
// shared/saved-page-metadata.js). Selection and the search query are
// TEMPORARY UI STATE only - neither is ever persisted.

import { TARGETS, MESSAGE_TYPES, MIN_GAIN_PERCENT, MAX_GAIN_PERCENT, MAX_CUSTOM_NAME_LENGTH } from '../shared/constants.js';
import { registerMessageHandler, sendMessage, validateServiceWorkerOriginatedSender } from '../shared/messages.js';
import { createSavedPageSliderController } from '../shared/saved-page-slider.js';
import { createClearConfirmController } from '../shared/clear-confirm.js';
import { createNotificationController } from '../shared/notifications.js';
import { getDisplayName } from '../shared/saved-page-metadata.js';
import { filterSavedPageKeys } from '../shared/saved-pages-search.js';
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

const els = {
  list: document.getElementById('page-list'),
  emptyState: document.getElementById('empty-state'),
  noMatches: document.getElementById('no-matches'),
  statusLine: document.getElementById('status-line'),
  search: document.getElementById('search-input'),
  selectAllVisible: document.getElementById('select-all-visible'),
  selectionSummary: document.getElementById('selection-summary'),
  resetSelected: document.getElementById('reset-selected'),
  deleteSelected: document.getElementById('delete-selected'),
  clearSelection: document.getElementById('clear-selection'),
  bulkDeleteConfirm: document.getElementById('bulk-delete-confirm'),
  bulkDeleteConfirmText: document.getElementById('bulk-delete-confirm-text'),
  bulkDeleteConfirmYes: document.getElementById('bulk-delete-confirm-yes'),
  bulkDeleteConfirmCancel: document.getElementById('bulk-delete-confirm-cancel'),
  // The destructive <details> section needs no script: it opens and closes
  // natively, and its collapsed state is deliberately never persisted.
  clearButton: document.getElementById('clear-button'),
  clearConfirm: document.getElementById('clear-confirm'),
  clearConfirmYes: document.getElementById('clear-confirm-yes'),
  clearConfirmCancel: document.getElementById('clear-confirm-cancel'),
};

// --- View state (never persisted) ---
let savedPages = {}; // authoritative schema-6 map, as last read from the SW
let activePageKeys = new Set(); // exact pageKeys currently boosting, when known
let selected = new Set(); // temporary selection
let searchQuery = '';
let visibleKeys = [];
let renamingPageKey = null; // the row currently showing its inline rename editor

// One entry per rendered row, so a live-gain broadcast can move exactly one
// row without a full re-render, and so throttle timers can be disposed.
const rows = new Map(); // pageKey -> { slider, volumeSpan, controller }

function disposeRows() {
  for (const row of rows.values()) row.controller.dispose();
  rows.clear();
}

// Transient success/info messages clear themselves; errors stay until
// something replaces them. See shared/notifications.js.
const notifications = createNotificationController({
  render: (message, kind) => {
    els.statusLine.textContent = message ?? '';
    els.statusLine.classList.toggle('options__status-line--error', kind === 'error');
    els.statusLine.classList.toggle('options__status-line--success', kind === 'success');
    els.statusLine.setAttribute('aria-live', kind === 'error' ? 'assertive' : 'polite');
  },
});

function setError(message) {
  notifications.error(message);
}

function setStatus(message) {
  notifications.success(message);
}

function clearStatus() {
  notifications.clear();
}

/**
 * A bulk summary is transient only when every page succeeded. If any page
 * failed, the summary names a real failure and must stay on screen until the
 * user acts again.
 */
function reportBulkOutcome(results, options) {
  const summary = summarizeBulkResults(results, options);
  const anyFailed = results.some((result) => !result.ok);
  if (anyFailed) setError(summary);
  else setStatus(summary);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderToolbar() {
  const counts = selectionCounts(selected, visibleKeys);
  els.selectionSummary.textContent = describeSelection(counts);

  const headerState = headerCheckboxState(selected, visibleKeys);
  els.selectAllVisible.checked = headerState === 'checked';
  els.selectAllVisible.indeterminate = headerState === 'indeterminate';
  els.selectAllVisible.disabled = visibleKeys.length === 0;

  // Bulk actions are meaningless with an empty selection.
  const nothingSelected = counts.total === 0;
  els.resetSelected.disabled = nothingSelected;
  els.deleteSelected.disabled = nothingSelected;
  els.clearSelection.disabled = nothingSelected;
}

function buildRenameEditor(pageKey, record, item) {
  const wrapper = document.createElement('div');
  wrapper.className = 'options__rename-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'options__rename-input';
  input.maxLength = MAX_CUSTOM_NAME_LENGTH;
  input.value = record.customName ?? '';
  input.placeholder = 'Custom name (leave empty to clear)';
  input.setAttribute('aria-label', `Custom name for ${getDisplayName(pageKey, record)}`);

  const save = document.createElement('button');
  save.type = 'button';
  save.className = 'options__small-button';
  save.textContent = 'Save';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'options__small-button';
  cancel.textContent = 'Cancel';

  const commit = async () => {
    const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.RENAME_SAVED_PAGE, {
      pageKey,
      customName: input.value,
    });
    if (!response.ok) {
      setError(response.error?.message ?? 'Could not rename this page.');
      return;
    }
    setStatus('Renamed page.');
    renamingPageKey = null;
    await refresh();
  };

  save.addEventListener('click', commit);
  cancel.addEventListener('click', () => {
    renamingPageKey = null;
    render();
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      renamingPageKey = null;
      render();
    }
  });

  wrapper.append(input, save, cancel);
  item.append(wrapper);
  // Focus after the row is in the document.
  queueMicrotask(() => input.focus());
}

function buildRow(pageKey, record) {
  const displayName = getDisplayName(pageKey, record);
  const isActive = activePageKeys.has(pageKey);

  const item = document.createElement('li');
  item.className = 'options__list-item';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'options__checkbox';
  checkbox.checked = selected.has(pageKey);
  checkbox.setAttribute('aria-label', `Select ${displayName}`);
  checkbox.addEventListener('change', () => {
    selected = toggleSelection(selected, pageKey, checkbox.checked);
    renderToolbar();
  });

  const main = document.createElement('div');
  main.className = 'options__row-main';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'options__display-name';
  nameSpan.textContent = displayName;
  nameSpan.title = displayName;

  // The exact URL is shown in full via title text and only visually truncated.
  const keySpan = document.createElement('span');
  keySpan.className = 'options__page-key';
  keySpan.textContent = pageKey;
  keySpan.title = pageKey;

  const status = document.createElement('span');
  status.className = isActive ? 'options__status options__status--active' : 'options__status';
  status.textContent = isActive ? 'Boosting now' : 'Not boosting';

  main.append(nameSpan, keySpan, status);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = String(MIN_GAIN_PERCENT);
  slider.max = String(MAX_GAIN_PERCENT);
  slider.step = '1';
  slider.value = String(record.volumePercent);
  slider.className = 'options__row-slider';
  slider.setAttribute(
    'aria-label',
    `Volume for ${displayName}, ${record.volumePercent} percent, ${MIN_GAIN_PERCENT} to ${MAX_GAIN_PERCENT} percent`
  );

  const volumeSpan = document.createElement('span');
  volumeSpan.className = 'options__volume';
  volumeSpan.textContent = `${record.volumePercent}%`;

  // `input` (while dragging) drives a THROTTLED, LIVE-ONLY gain - it changes
  // the audio of any tab currently boosting this identical exact URL but
  // writes nothing. `change` (on release) flushes the final live value, then
  // persists it exactly once.
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
        setError(response.error?.message ?? "Could not update this page's volume.");
        await refresh();
        return response;
      }
      clearStatus();
      return response;
    },
  });

  slider.addEventListener('input', () => {
    volumeSpan.textContent = `${slider.value}%`;
    slider.setAttribute(
      'aria-label',
      `Volume for ${displayName}, ${slider.value} percent, ${MIN_GAIN_PERCENT} to ${MAX_GAIN_PERCENT} percent`
    );
    controller.onInput(Number(slider.value));
  });
  slider.addEventListener('change', () => controller.onChange(Number(slider.value)));

  const actions = document.createElement('div');
  actions.className = 'options__row-actions';

  const renameButton = document.createElement('button');
  renameButton.type = 'button';
  renameButton.className = 'options__small-button';
  renameButton.textContent = 'Rename';
  renameButton.setAttribute('aria-label', `Rename ${displayName}`);
  renameButton.addEventListener('click', () => {
    renamingPageKey = renamingPageKey === pageKey ? null : pageKey;
    render();
  });

  const removeButton = document.createElement('button');
  removeButton.type = 'button';
  removeButton.className = 'options__remove-button';
  removeButton.textContent = '✕';
  removeButton.setAttribute('aria-label', `Delete ${displayName}`);
  removeButton.addEventListener('click', () => removePage(pageKey));

  actions.append(renameButton, removeButton);
  item.append(checkbox, main, slider, volumeSpan, actions);

  if (renamingPageKey === pageKey) buildRenameEditor(pageKey, record, item);

  rows.set(pageKey, { slider, volumeSpan, controller });
  return item;
}

function render() {
  const totalSaved = Object.keys(savedPages).length;
  visibleKeys = filterSavedPageKeys(savedPages, searchQuery);

  disposeRows();
  els.list.textContent = '';
  for (const pageKey of visibleKeys) {
    els.list.append(buildRow(pageKey, savedPages[pageKey]));
  }

  els.emptyState.hidden = totalSaved > 0;
  els.noMatches.hidden = !(totalSaved > 0 && visibleKeys.length === 0);
  renderToolbar();
}

/**
 * Moves ONLY the matching exact row's slider + percentage to a live gain
 * driven by the popup slider (a SAVED_PAGE_LIVE_GAIN_CHANGED broadcast). Never
 * persists and never re-renders the whole list; a pageKey with no
 * currently-rendered row is a harmless no-op.
 */
function applyLiveGainToRow(pageKey, gainPercent) {
  const row = rows.get(pageKey);
  if (!row) return;
  row.slider.value = String(gainPercent);
  row.volumeSpan.textContent = `${gainPercent}%`;
  if (savedPages[pageKey]) savedPages[pageKey] = { ...savedPages[pageKey], volumePercent: gainPercent };
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

async function refresh() {
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.GET_SAVED_PAGES, {});
  if (!response.ok) {
    setError(response.error?.message ?? 'Could not load saved pages.');
    return;
  }
  savedPages = response.data.savedPages ?? {};
  activePageKeys = new Set(Array.isArray(response.data.activePageKeys) ? response.data.activePageKeys : []);
  // A selection may reference a page that has since disappeared.
  selected = pruneSelection(selected, savedPages);
  if (renamingPageKey && !(renamingPageKey in savedPages)) renamingPageKey = null;
  render();
}

async function removePage(pageKey) {
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.REMOVE_SAVED_PAGE, { pageKey });
  if (!response.ok) {
    setError(response.error?.message ?? 'Could not delete this page.');
    return;
  }
  setStatus('Deleted saved page.');
  selected = toggleSelection(selected, pageKey, false);
  await refresh();
}

// ---------------------------------------------------------------------------
// Toolbar wiring
// ---------------------------------------------------------------------------

// Debounced: filtering + a full list rebuild on every single keystroke is
// wasted work while the user is still typing a multi-character query. The
// visible query updates and re-renders SEARCH_DEBOUNCE_MS after the last
// keystroke, not on each one - a fast, uninterrupted burst of typing (the
// common case) produces exactly one render instead of one per character.
const SEARCH_DEBOUNCE_MS = 120;
let searchDebounceTimer = null;

els.search.addEventListener('input', () => {
  // Selection intentionally survives a query change - the counts report how
  // much of it is currently hidden.
  const value = els.search.value;
  if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
  searchDebounceTimer = setTimeout(() => {
    searchDebounceTimer = null;
    searchQuery = value;
    render();
  }, SEARCH_DEBOUNCE_MS);
});

els.selectAllVisible.addEventListener('change', () => {
  selected = els.selectAllVisible.checked
    ? selectAllVisible(selected, visibleKeys)
    : deselectAllVisible(selected, visibleKeys);
  render();
});

// "Deselect all" only removes checkmarks. It never deletes a saved page,
// never changes a volume, never stops capture, and writes nothing to storage.
els.clearSelection.addEventListener('click', () => {
  selected = clearSelection();
  hideBulkDeleteConfirm();
  render();
  setStatus('Selection cleared.');
});

els.resetSelected.addEventListener('click', async () => {
  const pageKeys = [...selected];
  if (pageKeys.length === 0) return;
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.RESET_SELECTED_SAVED_PAGES_TO_100, { pageKeys });
  if (!response.ok) {
    setError(response.error?.message ?? 'Could not reset the selected pages.');
    return;
  }
  const results = response.data?.results ?? [];
  // Successful pages leave the selection; failed pages stay selected to retry.
  selected = applyBulkResultsToSelection(selected, results);
  reportBulkOutcome(results, { verb: 'Reset', suffix: 'to 100%' });
  await refresh();
});

function showBulkDeleteConfirm() {
  els.bulkDeleteConfirmText.textContent = describeDeleteConfirmation(selectionCounts(selected, visibleKeys));
  els.bulkDeleteConfirm.hidden = false;
}

function hideBulkDeleteConfirm() {
  els.bulkDeleteConfirm.hidden = true;
}

els.deleteSelected.addEventListener('click', () => {
  if (selected.size === 0) return;
  showBulkDeleteConfirm();
});

els.bulkDeleteConfirmCancel.addEventListener('click', hideBulkDeleteConfirm);

els.bulkDeleteConfirmYes.addEventListener('click', async () => {
  const pageKeys = [...selected];
  if (pageKeys.length === 0) {
    hideBulkDeleteConfirm();
    return;
  }
  const response = await sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.DELETE_SELECTED_SAVED_PAGES, { pageKeys });
  if (!response.ok) {
    setError(response.error?.message ?? 'Could not delete the selected pages.');
    return;
  }
  const results = response.data?.results ?? [];
  selected = applyBulkResultsToSelection(selected, results);
  reportBulkOutcome(results, { verb: 'Deleted' });
  hideBulkDeleteConfirm();
  await refresh();
});

// ---------------------------------------------------------------------------
// Clear all (danger zone) - always every saved page, never only the visible or
// selected ones.
// ---------------------------------------------------------------------------

const clearConfirm = createClearConfirmController({
  confirmEl: els.clearConfirm,
  clearButtonEl: els.clearButton,
  performClear: () => sendMessage(TARGETS.SERVICE_WORKER, MESSAGE_TYPES.CLEAR_SAVED_PAGES, {}),
  showError: (message) => setError(message),
});

els.clearButton.addEventListener('click', () => clearConfirm.show());
els.clearConfirmCancel.addEventListener('click', () => clearConfirm.hide());
els.clearConfirmYes.addEventListener('click', async () => {
  const result = await clearConfirm.confirm();
  if (result.ok) {
    setStatus('Cleared all saved pages.');
    selected = clearSelection();
    await refresh();
  }
});

// Escape closes whichever confirmation / inline editor is open.
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  clearConfirm.onEscape();
  if (!els.bulkDeleteConfirm.hidden) hideBulkDeleteConfirm();
});

// ---------------------------------------------------------------------------
// Broadcasts from the service worker
// ---------------------------------------------------------------------------

async function handleOptionsMessage(message) {
  if (message.type === MESSAGE_TYPES.SAVED_PAGES_CHANGED) {
    savedPages = message.payload?.savedPages ?? {};
    if (Array.isArray(message.payload?.activePageKeys)) {
      activePageKeys = new Set(message.payload.activePageKeys);
    }
    selected = pruneSelection(selected, savedPages);
    if (renamingPageKey && !(renamingPageKey in savedPages)) renamingPageKey = null;
    render();
  } else if (message.type === MESSAGE_TYPES.SAVED_PAGE_LIVE_GAIN_CHANGED) {
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
