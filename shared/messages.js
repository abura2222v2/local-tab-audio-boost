// Envelope building, response helpers, and the single non-async
// onMessage-listener wrapper used identically by all four extension
// contexts (service worker, offscreen document, popup, options page).

import { validateMessage } from './validation.js';
import {
  ERROR_CODES,
  TARGETS,
  SERVICE_WORKER_SCRIPT_PATH,
  OFFSCREEN_DOCUMENT_PATH,
  POPUP_PATH,
  OPTIONS_PATH,
} from './constants.js';

export function createRequestId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildMessage(target, type, payload) {
  return { target, type, requestId: createRequestId(), payload: payload ?? {} };
}

export function toStructuredError(error) {
  if (error && typeof error === 'object' && error.code && error.message) {
    return { ok: false, error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message } };
}

/**
 * A small typed error that handler functions can throw to produce a
 * specific structured error code/message instead of a generic
 * INTERNAL_ERROR.
 */
export class HandlerError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const CONTEXT_PATHS = {
  [TARGETS.SERVICE_WORKER]: SERVICE_WORKER_SCRIPT_PATH,
  [TARGETS.OFFSCREEN]: OFFSCREEN_DOCUMENT_PATH,
  [TARGETS.POPUP]: POPUP_PATH,
  [TARGETS.OPTIONS]: OPTIONS_PATH,
};

/** The extension-origin URL a message genuinely sent from `target` should carry as sender.url. */
export function expectedContextUrl(target) {
  const path = CONTEXT_PATHS[target];
  if (!path) return null;
  try {
    return chrome.runtime.getURL(path);
  } catch {
    return null;
  }
}

const SENDER_REJECTED = { ok: false, error: { code: ERROR_CODES.INVALID_MESSAGE, message: 'Message sender is not a trusted context for this operation.' } };

/**
 * Validates a sender that, by this protocol's fixed message-type/target
 * design, is exclusively ever the service worker (offscreen commands,
 * TAB_STATE_CHANGED, ALLOWED_PAGES_CHANGED - no other context ever sends a
 * message addressed that way). Chrome's MessageSender.url is documented as
 * potentially absent specifically when the sender is a service worker,
 * unlike a real page/frame sender where it is reliable - an absent url is
 * accepted here ONLY for that narrow, documented reason, and only because
 * registerMessageHandler has already verified sender.id === chrome.runtime.id
 * before validateSender ever runs. A *present* url must still match
 * exactly; a wrong url is always rejected regardless of a valid sender.id.
 * This is deliberately not a general "missing url means trusted" rule - it
 * is scoped to this one sender/direction pairing.
 */
export function validateServiceWorkerOriginatedSender(sender) {
  if (sender?.url === undefined) return true;
  return sender.url === expectedContextUrl(TARGETS.SERVICE_WORKER);
}

/**
 * Validates a sender that must be a genuine page/frame extension context
 * (popup, options, or offscreen) at `target` - used for messages that are
 * only ever legitimately sent by a real document context, where
 * MessageSender.url is reliably present. No bypass on an absent url.
 */
export function validatePageContextSender(sender, target) {
  return sender?.url === expectedContextUrl(target);
}

/**
 * Registers a single chrome.runtime.onMessage listener answering only
 * messages addressed to `selfTarget`. The listener itself is never async:
 * a target mismatch returns `undefined` synchronously (never a Promise),
 * and addressed messages return the literal `true` while `handleMessage`
 * resolves asynchronously. Both synchronous throws and asynchronous
 * rejections from `handleMessage` are caught, and `sendResponse` is called
 * at most once.
 *
 * Every addressed message is additionally checked against
 * `sender.id === chrome.runtime.id` - a missing or mismatched sender.id is
 * always rejected; every genuine internal chrome.runtime.sendMessage call
 * (see sendMessage below) always yields a sender.id, so this never rejects
 * legitimate traffic. `options.validateSender`, when provided, adds a
 * second, more specific check (e.g. "only the service worker may send
 * this") - see validateServiceWorkerOriginatedSender/validatePageContextSender
 * above for the two shared, narrowly-scoped implementations used by every
 * context in this codebase.
 */
export function registerMessageHandler(selfTarget, handleMessage, options = {}) {
  const { validateSender } = options;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.target !== selfTarget) {
      return undefined;
    }

    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse(SENDER_REJECTED);
      return true;
    }

    if (typeof validateSender === 'function' && !validateSender(sender, message)) {
      sendResponse(SENDER_REJECTED);
      return true;
    }

    const validation = validateMessage(message);
    if (!validation.ok) {
      sendResponse({ ok: false, error: { code: validation.code, message: validation.message } });
      return true;
    }

    Promise.resolve()
      .then(() => handleMessage(message, sender))
      .then((response) => {
        sendResponse(response ?? { ok: true, data: {} });
      })
      .catch((error) => {
        sendResponse(toStructuredError(error));
      });

    return true;
  });
}

/**
 * Sends a message and awaits its structured response. Never throws - a
 * missing receiver (e.g. the popup closed before the response arrived) or
 * a transport error is returned as a structured `{ok:false}` response.
 */
export async function sendMessage(target, type, payload) {
  const message = buildMessage(target, type, payload);
  try {
    const response = await chrome.runtime.sendMessage(message);
    if (response === undefined) {
      return { ok: false, error: { code: ERROR_CODES.INTERNAL_ERROR, message: 'No response received.' } };
    }
    return response;
  } catch (error) {
    return toStructuredError(error);
  }
}
