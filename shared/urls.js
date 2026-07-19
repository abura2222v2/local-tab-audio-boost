// The single, canonical implementation of exact-page matching for this
// extension. No other file may contain page-matching logic of any kind.

import { ERROR_CODES, RESTRICTED_HOSTNAMES, RESTRICTED_HOSTNAME_PATH_PREFIXES } from './constants.js';

/**
 * Returns true if the given (already-parsed) URL is a page this extension
 * will never be able to capture, or should never offer to capture, even
 * though it may otherwise look like an ordinary http(s) URL.
 *
 * This list is not, and cannot be, exhaustive - it exists to give an early,
 * specific error for known cases. The real safety net is always the
 * capture-time failure-and-cleanup path.
 */
export function isRestrictedPageUrl(url) {
  if (!(url instanceof URL)) return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;
  if (url.username !== '' || url.password !== '') return true;

  const hostname = url.hostname.toLowerCase();

  if (RESTRICTED_HOSTNAMES.includes(hostname)) return true;

  for (const entry of RESTRICTED_HOSTNAME_PATH_PREFIXES) {
    if (hostname === entry.hostname && url.pathname.startsWith(entry.pathPrefix)) {
      return true;
    }
  }

  return false;
}

/**
 * Canonicalizes a URL string into the exact-page key used everywhere in this
 * extension for saved-page membership and session identity.
 *
 * @param {string} urlString
 * @returns {{ok: true, pageKey: string} | {ok: false, code: string}}
 */
export function canonicalizePageKey(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { ok: false, code: ERROR_CODES.INVALID_URL };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, code: ERROR_CODES.UNSUPPORTED_SCHEME };
  }

  if (url.username !== '' || url.password !== '') {
    return { ok: false, code: ERROR_CODES.CREDENTIALS_IN_URL };
  }

  if (isRestrictedPageUrl(url)) {
    return { ok: false, code: ERROR_CODES.RESTRICTED_PAGE };
  }

  // url.href already: lowercases the hostname, resolves IDN/punycode, and
  // omits an explicit port that equals the scheme's default port. Path,
  // query string (including parameter order), and fragment are preserved
  // exactly as given - no normalization of any of them is performed.
  return { ok: true, pageKey: url.href };
}
