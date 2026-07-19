// Pure, DOM-free orchestration of the popup's slider-driven capture-start
// and live-gain flow. Extracted out of popup.js specifically so the REAL
// popup event order (slider input BEFORE any operationId exists -> start
// capture -> apply the value to the resulting operation) can be tested
// deterministically under plain Node, without a DOM and without manually
// re-ordering the steps.
//
// The central problem this solves: on an inactive page the user's first
// slider interaction fires `input` before any capture session (and thus any
// operationId) exists. A naive popup drops that value (no operationId to
// scope a SET_TAB_GAIN to) and then a server refresh caused by the start
// completing resets the slider back to the server's initial/saved value -
// so the user's chosen value is silently lost. This controller instead:
//   - records the user's chosen value as a pending `desired` value;
//   - starts exactly one de-duplicated capture, carrying that value as
//     START_CAPTURE's `initialGainPercent` (so the session starts AT it);
//   - after the start resolves, applies the LATEST pending desired value to
//     the now-known authoritative operationId (covers a drag that continued
//     while START_CAPTURE was in flight);
//   - keeps displaying the pending desired value across the post-start
//     server refresh, until the server actually reflects it;
//   - discards the pending value safely on navigation / PAGE_CHANGED /
//     capture failure / operation supersession.
// A saved page and an unsaved page behave identically for live gain;
// persistence stays conditional on the page being saved (delegated to the
// live-gain controller's caller-gated persistNow).

import { createGainInputController } from './popup-gain-controller.js';

export function createPopupController({
  startCapture, // ({tabId, expectedPageKey, initialGainPercent}) => Promise<response>
  setLiveGain, // ({tabId, gainPercent, operationId}) => Promise<response>
  persistVolume, // ({tabId, gainPercent, operationId}) => Promise<response>
  refresh, // () => Promise<void>  - re-fetches server state and calls setServerState()
  setSliderDisplay, // (value:number) => void  - updates the slider position + percent text
  liveThrottleMs,
}) {
  // Current server-observed context.
  let tabId = null;
  let pageKey = null;
  let saved = false;
  let captureState = 'inactive';
  let operationId = null;
  let serverGain = 100;

  // A value the user selected that the server has not yet reflected. It is
  // tied to `desiredContext` (the exact pageKey it was chosen for) so a
  // navigation to a different page discards it.
  let desired = null;
  let desiredContext = null;

  // De-duplicated in-flight START_CAPTURE - a slider drag firing many input
  // events, or a drag racing an Enable click, must never issue more than one
  // concurrent START_CAPTURE for the same tab.
  let startPromise = null;

  // The active-session live-gain throttle (leading + trailing). Its
  // sendLiveGain/persistNow read the controller's current tabId/saved at
  // call time; its operationId is established via onServerState.
  const gain = createGainInputController({
    sendLiveGain: (value, op) => {
      if (tabId === null || op === null) return;
      setLiveGain({ tabId, gainPercent: value, operationId: op });
    },
    persistNow: (value, op) => {
      // Persistence is conditional on the page being saved - an unsaved
      // (temporary) session never writes storage.
      if (tabId === null || op === null || !saved) return;
      persistVolume({ tabId, gainPercent: value, operationId: op });
    },
    liveThrottleMs,
  });

  function inProgress() {
    return captureState === 'active' || captureState === 'starting' || captureState === 'resolving';
  }

  /**
   * Starts exactly one capture (de-duplicated). `initialGainPercent` is
   * carried on START_CAPTURE so the session starts at that value. After a
   * successful start, the LATEST pending `desired` value is applied to the
   * authoritative operationId (covers a drag that continued while the start
   * was in flight). A failed/superseded start, or a navigation that changed
   * the context out from under this start, discards the pending value and
   * never applies a stale gain.
   */
  function ensureCaptureStarted(initialGainPercent) {
    if (startPromise) return startPromise;
    if (captureState === 'active') return Promise.resolve({ ok: true });
    const startedForPageKey = pageKey;
    const startedForTabId = tabId;
    startPromise = Promise.resolve(
      startCapture({ tabId: startedForTabId, expectedPageKey: startedForPageKey, initialGainPercent })
    )
      .then(async (response) => {
        if (!response || !response.ok) {
          // Failed start / PAGE_CHANGED / stale - never apply a stale gain.
          if (desiredContext === startedForPageKey) {
            desired = null;
            desiredContext = null;
          }
          await refresh();
          return response;
        }
        const op = response.data && response.data.operationId ? response.data.operationId : null;
        // Apply the latest pending desired value to this exact operation,
        // but only if the context has not changed (a navigation during the
        // start would have moved desiredContext to a different pageKey or
        // cleared it).
        if (op && desired !== null && desiredContext === startedForPageKey) {
          await setLiveGain({ tabId: startedForTabId, gainPercent: desired, operationId: op });
        }
        await refresh();
        return response;
      })
      .finally(() => {
        startPromise = null;
      });
    return startPromise;
  }

  /**
   * Fold a freshly-fetched/broadcast server state in. Reconciles the pending
   * desired value against the new context and computes what the slider
   * should display (the pending desired value if still pending, otherwise
   * the server's value) WITHOUT ever discarding a value the user is still
   * waiting on for the current page.
   */
  function setServerState(state) {
    if (state && state.restricted) {
      // Unsupported page - no slider, no pending value.
      tabId = state.tabId ?? tabId;
      pageKey = null;
      saved = false;
      captureState = 'inactive';
      operationId = null;
      serverGain = 100;
      desired = null;
      desiredContext = null;
      gain.onServerState(100, null);
      return;
    }

    const newPageKey = (state && state.pageKey) ?? null;
    tabId = state.tabId ?? tabId;
    saved = Boolean(state.saved);
    captureState = state.state;
    operationId = state.operationId ?? null;
    serverGain = typeof state.gainPercent === 'number' ? state.gainPercent : 100;

    if (desired !== null) {
      if (desiredContext !== newPageKey) {
        // The page changed out from under the pending value - discard it.
        desired = null;
        desiredContext = null;
      } else if (captureState === 'active' && serverGain === desired) {
        // The server has caught up to the desired value - hand back to the
        // normal (server-truth) flow.
        desired = null;
        desiredContext = null;
      }
      // else: still pending - keep displaying it below.
    }

    pageKey = newPageKey;

    const displayValue = desired !== null ? desired : serverGain;
    setSliderDisplay(displayValue);
    gain.onServerState(displayValue, operationId);
  }

  function onSliderInput(value) {
    setSliderDisplay(value);
    if (captureState === 'active') {
      gain.onInput(value);
      return;
    }
    // Inactive/resolving/starting: the slider interaction itself is the
    // explicit user action that starts a temporary session (saved or not).
    desired = value;
    desiredContext = pageKey;
    ensureCaptureStarted(value);
  }

  function onSliderChange(value) {
    setSliderDisplay(value);
    if (captureState === 'active') {
      gain.onChange(value);
      return;
    }
    // A change (release) while still inactive behaves like an input: record
    // the value and ensure a start. Persistence for a freshly-started saved
    // session happens on the next explicit change once it is active.
    desired = value;
    desiredContext = pageKey;
    ensureCaptureStarted(value);
  }

  /** Enable-boosting click: start at the currently displayed default/saved value. */
  function onEnableClick() {
    if (captureState === 'active') return Promise.resolve({ ok: true });
    const initial = desired !== null ? desired : serverGain;
    return ensureCaptureStarted(initial);
  }

  function flushFallback() {
    gain.flushFallback();
  }

  return {
    setServerState,
    onSliderInput,
    onSliderChange,
    onEnableClick,
    flushFallback,
    // Exposed for tests / diagnostics only.
    __getState: () => ({ tabId, pageKey, saved, captureState, operationId, serverGain, desired, desiredContext }),
  };
}
