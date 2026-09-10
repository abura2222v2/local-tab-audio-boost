// MAIN-world page audio controller for the fullscreen-compatible backend.
//
// Injected as a packaged classic script by chrome.scripting.executeScript,
// only after an explicit user action. It runs in the page's own world because
// it has to operate on the page's real HTMLMediaElement objects; it therefore
// holds NO extension privileges and never touches chrome.* APIs, storage, or
// any page URL beyond the media sources it inspects.
//
// What it does: routes accessible media elements through one shared GainNode.
//
//   HTMLMediaElement -> MediaElementAudioSourceNode -> GainNode -> destination
//
// What it deliberately does NOT do, so the page's own fullscreen keeps working:
// it never calls or patches requestFullscreen, never installs click/dblclick
// or fullscreenchange handlers, never calls preventDefault, never injects CSS,
// never wraps or replaces the video element, never changes element.volume or
// element.muted, and never alters the player's controls or layout.
//
// The safety rules for deciding which elements may be routed are duplicated
// from shared/page-audio-policy.js because an injected classic script cannot
// import a module. tests/page-audio-controller.test.js loads this real file
// and asserts it agrees with the shared module on a common corpus, so the two
// copies cannot silently drift.

(() => {
  'use strict';

  const CONTROLLER_GLOBAL = '__localTabAudioBoostPageController';
  const COMMAND_EVENT = 'ltab-page-audio-command';
  const RESULT_EVENT = 'ltab-page-audio-result';

  const COMMANDS = {
    INSTALL: 'INSTALL',
    SET_GAIN: 'SET_GAIN',
    QUERY_STATE: 'QUERY_STATE',
    RESET_TO_NEUTRAL: 'RESET_TO_NEUTRAL',
    DISPOSE_OBSERVERS: 'DISPOSE_OBSERVERS',
  };

  const STATES = {
    ACTIVE_WITH_MEDIA: 'ACTIVE_WITH_MEDIA',
    ARMED_WAITING_FOR_MEDIA: 'ARMED_WAITING_FOR_MEDIA',
    UNSUPPORTED_MEDIA: 'UNSUPPORTED_MEDIA',
    CONTEXT_SUSPENDED: 'CONTEXT_SUSPENDED',
    ATTACHMENT_FAILED: 'ATTACHMENT_FAILED',
  };

  const REFUSAL = {
    NOT_MEDIA_ELEMENT: 'NOT_MEDIA_ELEMENT',
    NO_SOURCE_YET: 'NO_SOURCE_YET',
    CROSS_ORIGIN_NO_CORS: 'CROSS_ORIGIN_NO_CORS',
    UNSUPPORTED_SCHEME: 'UNSUPPORTED_SCHEME',
    PROTECTED_MEDIA: 'PROTECTED_MEDIA',
    ALREADY_ATTACHED: 'ALREADY_ATTACHED',
    FOREIGN_CONTEXT: 'FOREIGN_CONTEXT',
  };

  // Installing twice must never build a second graph: a repeat injection just
  // finds the existing controller and reports its current state.
  if (window[CONTROLLER_GLOBAL]) {
    window[CONTROLLER_GLOBAL].markReinstalled();
    return;
  }

  // ---------------------------------------------------------------------
  // Media safety classification (mirrors shared/page-audio-policy.js)
  // ---------------------------------------------------------------------

  function schemeOf(rawUrl) {
    const colon = rawUrl.indexOf(':');
    return colon <= 0 ? '' : rawUrl.slice(0, colon).toLowerCase();
  }

  function sameOrigin(mediaUrl, documentOrigin) {
    try {
      return new URL(mediaUrl).origin === documentOrigin;
    } catch (err) {
      return false;
    }
  }

  function classify(descriptor) {
    const tagName = typeof descriptor.tagName === 'string' ? descriptor.tagName.toUpperCase() : '';
    if (tagName !== 'VIDEO' && tagName !== 'AUDIO') return { safe: false, reason: REFUSAL.NOT_MEDIA_ELEMENT };
    if (descriptor.alreadyAttached) return { safe: false, reason: REFUSAL.ALREADY_ATTACHED };
    if (descriptor.ownedByForeignContext) return { safe: false, reason: REFUSAL.FOREIGN_CONTEXT };
    if (descriptor.hasEncryptedMedia) return { safe: false, reason: REFUSAL.PROTECTED_MEDIA };

    const currentSrc = typeof descriptor.currentSrc === 'string' ? descriptor.currentSrc : '';
    if (currentSrc.length === 0) return { safe: false, reason: REFUSAL.NO_SOURCE_YET, retryable: true };

    const scheme = schemeOf(currentSrc);
    if (scheme === 'blob' || scheme === 'data') return { safe: true, reason: null };
    if (scheme !== 'http' && scheme !== 'https') return { safe: false, reason: REFUSAL.UNSUPPORTED_SCHEME };

    const documentOrigin = typeof descriptor.documentOrigin === 'string' ? descriptor.documentOrigin : '';
    if (sameOrigin(currentSrc, documentOrigin)) return { safe: true, reason: null };

    const crossOrigin = typeof descriptor.crossOrigin === 'string' ? descriptor.crossOrigin.toLowerCase() : '';
    if (crossOrigin === 'anonymous' || crossOrigin === 'use-credentials') return { safe: true, reason: null };
    return { safe: false, reason: REFUSAL.CROSS_ORIGIN_NO_CORS };
  }

  /** Snapshot of an element, so classification stays a pure decision. */
  function describe(element, attached) {
    let hasEncryptedMedia = false;
    try {
      hasEncryptedMedia = Boolean(element.mediaKeys) || Boolean(element.msKeys);
    } catch (err) {
      hasEncryptedMedia = false;
    }
    return {
      tagName: element.tagName,
      currentSrc: element.currentSrc || element.src || '',
      documentOrigin: getOrigin(),
      crossOrigin: element.crossOrigin || '',
      hasEncryptedMedia,
      alreadyAttached: attached,
      ownedByForeignContext: false,
    };
  }

  function getOrigin() {
    try {
      return window.location.origin;
    } catch (err) {
      return '';
    }
  }

  // ---------------------------------------------------------------------
  // Controller state - exactly one AudioContext and one GainNode per document
  // ---------------------------------------------------------------------

  let audioContext = null;
  let gainNode = null;
  let observer = null;
  let currentGainPercent = 100;
  let operationToken = null;
  let disposed = false;
  let reinstallCount = 0;

  // Element ownership. A WeakMap keeps no element alive and needs no pruning:
  // entries vanish with their elements.
  const ownership = new WeakMap(); // element -> {sourceNode|null, refusedReason|null}
  let attachedCount = 0;
  const refusalReasons = new Set();

  function ensureContext() {
    if (audioContext) return audioContext;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    audioContext = new Ctor();
    gainNode = audioContext.createGain();
    gainNode.gain.value = currentGainPercent / 100;
    gainNode.connect(audioContext.destination);
    return audioContext;
  }

  /**
   * Routes one element, but only when classification says it is safe. An
   * unsafe or not-yet-ready element is left completely untouched - no source
   * node is created, and its own audio path is never disturbed.
   */
  function tryAttach(element) {
    if (disposed) return false;
    const existing = ownership.get(element);
    if (existing && existing.sourceNode) return false;

    const verdict = classify(describe(element, Boolean(existing && existing.sourceNode)));
    if (!verdict.safe) {
      // Retryable means "nothing loaded yet" - keep watching, do not record it
      // as a blocking refusal.
      if (!verdict.retryable) {
        ownership.set(element, { sourceNode: null, refusedReason: verdict.reason });
        refusalReasons.add(verdict.reason);
      }
      return false;
    }

    if (!ensureContext()) return false;

    try {
      // The irreversible step: from here the element's audio flows through our
      // context for the rest of this document's life.
      const sourceNode = audioContext.createMediaElementSource(element);
      sourceNode.connect(gainNode);
      ownership.set(element, { sourceNode, refusedReason: null });
      attachedCount += 1;
      return true;
    } catch (err) {
      ownership.set(element, { sourceNode: null, refusedReason: REFUSAL.FOREIGN_CONTEXT });
      refusalReasons.add(REFUSAL.FOREIGN_CONTEXT);
      return false;
    }
  }

  function scanDocument(root) {
    const scope = root && typeof root.querySelectorAll === 'function' ? root : document;
    let found = 0;
    let elements = [];
    try {
      elements = scope.querySelectorAll('video, audio');
    } catch (err) {
      elements = [];
    }
    for (const element of elements) {
      if (tryAttach(element)) found += 1;
    }
    return found;
  }

  function mediaElementForMutationTarget(target) {
    if (!target) return null;
    if (target.tagName === 'VIDEO' || target.tagName === 'AUDIO') return target;
    if (target.tagName !== 'SOURCE') return null;
    const parent = target.parentElement;
    return parent && (parent.tagName === 'VIDEO' || parent.tagName === 'AUDIO') ? parent : null;
  }

  /**
   * One MutationObserver for the whole document - never one per element, and
   * never a polling interval. Players that create their <video> late, swap it
   * out, or assign a source after the element exists are all covered.
   */
  function ensureObserver() {
    if (observer || disposed) return;
    if (typeof MutationObserver !== 'function') return;
    observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          // `video.src = ...` and updates to a nested <source src="..."> do
          // not add a media element to the DOM. Retry only the affected player
          // rather than re-scanning every media element on the page.
          const media = mediaElementForMutationTarget(record.target);
          if (media) tryAttach(media);
          continue;
        }
        const added = record.addedNodes || [];
        for (const node of added) {
          if (!node) continue;
          if (node.tagName === 'VIDEO' || node.tagName === 'AUDIO') tryAttach(node);
          else if (typeof node.querySelectorAll === 'function') scanDocument(node);
        }
        // A ready <source src="..."> may be appended to an existing player.
        // Its attribute was set while detached, so no observed attribute
        // mutation is guaranteed; the child-list target names the player.
        const parentMedia = mediaElementForMutationTarget(record.target);
        if (parentMedia) tryAttach(parentMedia);
      }
    });
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  }

  function disconnectObserver() {
    if (!observer) return;
    try {
      observer.disconnect();
    } catch (err) {
      /* already gone */
    }
    observer = null;
  }

  function currentState() {
    if (attachedCount > 0) {
      if (audioContext && audioContext.state === 'suspended') return STATES.CONTEXT_SUSPENDED;
      return STATES.ACTIVE_WITH_MEDIA;
    }
    const blocking = [...refusalReasons].filter((r) => r !== REFUSAL.NO_SOURCE_YET && r !== REFUSAL.ALREADY_ATTACHED);
    if (blocking.length > 0) return STATES.UNSUPPORTED_MEDIA;
    return STATES.ARMED_WAITING_FOR_MEDIA;
  }

  function snapshot() {
    return {
      state: currentState(),
      gainPercent: currentGainPercent,
      attachedCount,
      refusals: [...refusalReasons],
      contextState: audioContext ? audioContext.state : 'none',
      operationToken,
      reinstallCount,
    };
  }

  function applyGain(gainPercent) {
    currentGainPercent = gainPercent;
    if (gainNode) gainNode.gain.value = gainPercent / 100;
  }

  function resumeIfNeeded() {
    if (!audioContext || audioContext.state !== 'suspended') return;
    try {
      const result = audioContext.resume();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (err) {
      /* resume is best-effort; state is reported honestly either way */
    }
  }

  const controller = {
    install(token, gainPercent) {
      disposed = false;
      operationToken = token;
      applyGain(gainPercent);
      ensureContext();
      applyGain(gainPercent); // the context may have just been created
      scanDocument(document);
      ensureObserver();
      resumeIfNeeded();
      return snapshot();
    },
    setGain(token, gainPercent) {
      // A command from a superseded operation must never move live audio.
      if (token !== operationToken) return { rejected: true, reason: 'STALE_OPERATION', ...snapshot() };
      applyGain(gainPercent);
      resumeIfNeeded();
      return snapshot();
    },
    query(token) {
      if (token !== operationToken) return { rejected: true, reason: 'STALE_OPERATION', ...snapshot() };
      return snapshot();
    },
    /**
     * Disable: return to neutral gain (1.0) rather than tearing the graph down.
     * Closing the AudioContext would silence every element already routed
     * through it, because createMediaElementSource cannot be undone for the
     * document's lifetime. Neutral gain is audibly identical to no extension.
     */
    resetToNeutral(token) {
      if (token !== operationToken) return { rejected: true, reason: 'STALE_OPERATION', ...snapshot() };
      applyGain(100);
      return snapshot();
    },
    /** Drops the observer once boosting is off - routing stays, watching stops. */
    disposeObservers(token) {
      if (token !== operationToken) return { rejected: true, reason: 'STALE_OPERATION', ...snapshot() };
      disconnectObserver();
      disposed = true;
      return snapshot();
    },
    markReinstalled() {
      reinstallCount += 1;
      disposed = false;
      ensureObserver();
    },
    // Test/diagnostic surface only - never used for privileged decisions.
    __debug: () => ({ hasContext: Boolean(audioContext), hasGain: Boolean(gainNode), hasObserver: Boolean(observer) }),
  };

  window[CONTROLLER_GLOBAL] = controller;

  function respond(requestId, payload) {
    try {
      document.dispatchEvent(new CustomEvent(RESULT_EVENT, { detail: { requestId, payload } }));
    } catch (err) {
      /* the bridge will time out rather than hang */
    }
  }

  // The only entry point from the isolated bridge. Every command is matched
  // against the fixed vocabulary below; anything else is ignored outright.
  document.addEventListener(COMMAND_EVENT, (event) => {
    const detail = event && event.detail;
    if (!detail || typeof detail !== 'object') return;
    const { requestId, command } = detail;
    if (typeof requestId !== 'string' || !command || typeof command !== 'object') return;
    const token = command.operationToken;
    if (typeof token !== 'string' || token.length === 0) return;

    const gainPercent = command.gainPercent;
    const validGain = Number.isInteger(gainPercent) && gainPercent >= 0 && gainPercent <= 300;

    switch (command.type) {
      case COMMANDS.INSTALL:
        if (!validGain) return respond(requestId, { rejected: true, reason: 'INVALID_GAIN' });
        return respond(requestId, controller.install(token, gainPercent));
      case COMMANDS.SET_GAIN:
        if (!validGain) return respond(requestId, { rejected: true, reason: 'INVALID_GAIN' });
        return respond(requestId, controller.setGain(token, gainPercent));
      case COMMANDS.QUERY_STATE:
        return respond(requestId, controller.query(token));
      case COMMANDS.RESET_TO_NEUTRAL:
        return respond(requestId, controller.resetToNeutral(token));
      case COMMANDS.DISPOSE_OBSERVERS:
        return respond(requestId, controller.disposeObservers(token));
      default:
        return undefined;
    }
  });
})();
