// Pure URL-rule construction and matching for saved volume preferences.
// Rules never contain regular expressions or executable patterns. They are
// always derived from one canonical http/https URL and one fixed match mode.

import { SAVED_PAGE_MATCH_MODES } from './constants.js';
import { canonicalizePageKey } from './urls.js';

const MODE_PRIORITY = Object.freeze({
  [SAVED_PAGE_MATCH_MODES.EXACT]: 4,
  [SAVED_PAGE_MATCH_MODES.PAGE]: 3,
  [SAVED_PAGE_MATCH_MODES.PATH]: 2,
  [SAVED_PAGE_MATCH_MODES.SITE]: 1,
});

export function isValidSavedPageMatchMode(value) {
  return Object.values(SAVED_PAGE_MATCH_MODES).includes(value);
}

export function normalizeSavedPageMatchMode(value) {
  return isValidSavedPageMatchMode(value) ? value : SAVED_PAGE_MATCH_MODES.EXACT;
}

function trimTrailingPathSlashes(pathname) {
  if (pathname === '/') return pathname;
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === '/') end -= 1;
  return pathname.slice(0, end);
}

/**
 * Converts a user-entered URL into the canonical key stored for one fixed
 * matching mode. Narrowing is deterministic and local:
 *   exact: preserve path, query, and fragment;
 *   page: preserve path/query, ignore fragment;
 *   path: preserve a segment-bounded path prefix, ignore query/fragment;
 *   site: preserve only origin and the root slash.
 */
export function canonicalizeSavedPageRule(rawUrl, matchMode = SAVED_PAGE_MATCH_MODES.EXACT) {
  if (!isValidSavedPageMatchMode(matchMode)) {
    return { ok: false, code: 'INVALID_MATCH_MODE' };
  }
  const canonical = canonicalizePageKey(rawUrl);
  if (!canonical.ok) return canonical;

  const url = new URL(canonical.pageKey);
  if (matchMode === SAVED_PAGE_MATCH_MODES.PAGE) {
    url.hash = '';
  } else if (matchMode === SAVED_PAGE_MATCH_MODES.PATH) {
    url.search = '';
    url.hash = '';
    url.pathname = trimTrailingPathSlashes(url.pathname);
  } else if (matchMode === SAVED_PAGE_MATCH_MODES.SITE) {
    url.pathname = '/';
    url.search = '';
    url.hash = '';
  }

  const normalized = canonicalizePageKey(url.href);
  return normalized.ok ? { ...normalized, matchMode } : normalized;
}

function samePageIgnoringFragment(ruleUrl, pageUrl) {
  return (
    ruleUrl.origin === pageUrl.origin &&
    ruleUrl.pathname === pageUrl.pathname &&
    ruleUrl.search === pageUrl.search
  );
}

function pathPrefixMatches(rulePath, pagePath) {
  if (rulePath === '/') return true;
  return pagePath === rulePath || pagePath.startsWith(`${rulePath}/`);
}

export function savedPageRuleMatches(ruleKey, matchMode, candidatePageKey) {
  const rule = canonicalizeSavedPageRule(ruleKey, normalizeSavedPageMatchMode(matchMode));
  const candidate = canonicalizePageKey(candidatePageKey);
  if (!rule.ok || !candidate.ok || rule.pageKey !== ruleKey) return false;

  const mode = rule.matchMode;
  if (mode === SAVED_PAGE_MATCH_MODES.EXACT) return rule.pageKey === candidate.pageKey;

  const ruleUrl = new URL(rule.pageKey);
  const pageUrl = new URL(candidate.pageKey);
  if (mode === SAVED_PAGE_MATCH_MODES.PAGE) return samePageIgnoringFragment(ruleUrl, pageUrl);
  if (mode === SAVED_PAGE_MATCH_MODES.PATH) {
    return ruleUrl.origin === pageUrl.origin && pathPrefixMatches(ruleUrl.pathname, pageUrl.pathname);
  }
  return ruleUrl.origin === pageUrl.origin;
}

function matchRank(ruleKey, matchMode) {
  const mode = normalizeSavedPageMatchMode(matchMode);
  if (mode !== SAVED_PAGE_MATCH_MODES.PATH) return MODE_PRIORITY[mode] * 1_000_000;
  try {
    return MODE_PRIORITY[mode] * 1_000_000 + new URL(ruleKey).pathname.length;
  } catch {
    return 0;
  }
}

/** Returns the most specific saved rule governing `candidatePageKey`. */
export function findSavedPageMatch(savedPages, candidatePageKey) {
  let best = null;
  for (const [pageKey, record] of Object.entries(savedPages ?? {})) {
    const matchMode = normalizeSavedPageMatchMode(record?.matchMode);
    if (!savedPageRuleMatches(pageKey, matchMode, candidatePageKey)) continue;
    const rank = matchRank(pageKey, matchMode);
    if (!best || rank > best.rank || (rank === best.rank && pageKey < best.pageKey)) {
      best = { pageKey, record, matchMode, rank };
    }
  }
  if (!best) return null;
  const { rank, ...match } = best;
  return match;
}
