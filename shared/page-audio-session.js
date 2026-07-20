// Pure, DOM-free registry of the page-audio frame controllers the service
// worker currently believes are installed.
//
// This is a derived, in-memory cache only: nothing here is ever persisted, and
// saved pages continue to store exact-page preferences and metadata alone.
//
// Two properties this structure exists to guarantee:
//
//  1. It is BOUNDED. Every record hangs off a tabId, and dropping a tab (or a
//     frame) removes every record underneath it - so repeated enable/disable
//     cycles, navigations, and closed tabs cannot grow it without limit.
//  2. It is GENERATION-SAFE. Each frame record carries the documentId and
//     operationToken it was installed for, so a reply from an old document can
//     never revive or mutate the record belonging to a newer one.

import { isRunningState } from './page-audio-policy.js';

export function createPageAudioRegistry() {
  /** @type {Map<number, Map<number, object>>} tabId -> frameId -> record */
  const byTab = new Map();

  function frames(tabId) {
    return byTab.get(tabId) ?? null;
  }

  /** Records (or refreshes) one installed frame controller. */
  function setFrame(tabId, frameId, record) {
    let tabFrames = byTab.get(tabId);
    if (!tabFrames) {
      tabFrames = new Map();
      byTab.set(tabId, tabFrames);
    }
    tabFrames.set(frameId, { frameId, ...record });
  }

  function getFrame(tabId, frameId) {
    return frames(tabId)?.get(frameId) ?? null;
  }

  function listFrames(tabId) {
    const tabFrames = frames(tabId);
    return tabFrames ? [...tabFrames.values()] : [];
  }

  /** Frames still considered live for this exact operation generation. */
  function listFramesForOperation(tabId, operationToken) {
    return listFrames(tabId).filter((frame) => frame.operationToken === operationToken);
  }

  function removeFrame(tabId, frameId) {
    const tabFrames = frames(tabId);
    if (!tabFrames) return false;
    const removed = tabFrames.delete(frameId);
    // Never leave an empty Map behind - that is how a "bounded" registry
    // quietly becomes unbounded across thousands of tabs.
    if (tabFrames.size === 0) byTab.delete(tabId);
    return removed;
  }

  function removeTab(tabId) {
    return byTab.delete(tabId);
  }

  /**
   * Navigation in a frame invalidates whatever controller used to live there:
   * the old document is gone, so its record must not survive to receive
   * commands meant for the new one. Dropping the record is the whole point -
   * the page-side objects die with their document.
   */
  function invalidateFrame(tabId, frameId) {
    return removeFrame(tabId, frameId);
  }

  /** A top-level navigation invalidates every frame in the tab. */
  function invalidateTab(tabId) {
    return removeTab(tabId);
  }

  /**
   * Drops any frame whose documentId no longer matches the one currently
   * reported for it, so a stale record can never be mistaken for a live one.
   */
  function reconcileDocument(tabId, frameId, currentDocumentId) {
    const frame = getFrame(tabId, frameId);
    if (!frame) return false;
    if (currentDocumentId && frame.documentId && frame.documentId !== currentDocumentId) {
      removeFrame(tabId, frameId);
      return true;
    }
    return false;
  }

  /** True when this tab still has at least one frame in a running state. */
  function hasRunningFrames(tabId, operationToken) {
    return listFramesForOperation(tabId, operationToken).some((frame) => isRunningState(frame.state));
  }

  function updateFrameState(tabId, frameId, operationToken, patch) {
    const frame = getFrame(tabId, frameId);
    // A reply from a superseded generation must change nothing.
    if (!frame || frame.operationToken !== operationToken) return false;
    frames(tabId).set(frameId, { ...frame, ...patch });
    return true;
  }

  return {
    setFrame,
    getFrame,
    listFrames,
    listFramesForOperation,
    removeFrame,
    removeTab,
    invalidateFrame,
    invalidateTab,
    reconcileDocument,
    hasRunningFrames,
    updateFrameState,
    /** Diagnostics for tests: total tabs and total frame records held. */
    size: () => ({
      tabs: byTab.size,
      frames: [...byTab.values()].reduce((total, tabFrames) => total + tabFrames.size, 0),
    }),
    clear: () => byTab.clear(),
  };
}
