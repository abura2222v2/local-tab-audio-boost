import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SAVED_PAGE_MATCH_MODES } from '../shared/constants.js';
import {
  canonicalizeSavedPageRule,
  savedPageRuleMatches,
  findSavedPageMatch,
} from '../shared/saved-page-rules.js';

const EPISODE = 'https://stream.example/series/science-fiction/snow-train.html#season:2-episode:10';
const TITLE_PAGE = 'https://stream.example/series/science-fiction/snow-train.html';

test('rules: exact preserves the episode fragment and matches only that address', () => {
  const rule = canonicalizeSavedPageRule(EPISODE, SAVED_PAGE_MATCH_MODES.EXACT);
  assert.equal(rule.ok, true);
  assert.equal(rule.pageKey, EPISODE);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, EPISODE), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, `${TITLE_PAGE}#t:56-s:2-e:11`), false);
});

test('rules: page removes the fragment and matches every fragment on that title page', () => {
  const rule = canonicalizeSavedPageRule(EPISODE, SAVED_PAGE_MATCH_MODES.PAGE);
  assert.equal(rule.pageKey, TITLE_PAGE);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, `${TITLE_PAGE}#t:56-s:1-e:1`), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, `${TITLE_PAGE}#t:56-s:9-e:99`), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, `${TITLE_PAGE}?mirror=2#t:56-s:1-e:1`), false);
});

test('rules: path is segment-bounded and ignores query/fragment', () => {
  const rule = canonicalizeSavedPageRule('https://stream.example/series/science-fiction/', SAVED_PAGE_MATCH_MODES.PATH);
  assert.equal(rule.pageKey, 'https://stream.example/series/science-fiction');
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, EPISODE), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, 'https://stream.example/series/science-fiction/sub/page?x=1#y'), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, 'https://stream.example/series/science-fictional/movie'), false);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, 'https://other.example/series/fiction/movie'), false);
});

test('rules: site reduces to the origin and matches every path on only that origin', () => {
  const rule = canonicalizeSavedPageRule('https://stream.example/series/science-fiction?x=1#y', SAVED_PAGE_MATCH_MODES.SITE);
  assert.equal(rule.pageKey, 'https://stream.example/');
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, EPISODE), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, 'https://stream.example/films/123'), true);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, 'http://stream.example/films/123'), false);
  assert.equal(savedPageRuleMatches(rule.pageKey, rule.matchMode, 'https://sub.stream.example/films/123'), false);
});

test('rules: the most specific match wins, with the longest path prefix winning between sections', () => {
  const savedPages = {
    'https://stream.example/': { volumePercent: 110, matchMode: SAVED_PAGE_MATCH_MODES.SITE },
    'https://stream.example/series': { volumePercent: 130, matchMode: SAVED_PAGE_MATCH_MODES.PATH },
    'https://stream.example/series/science-fiction': { volumePercent: 150, matchMode: SAVED_PAGE_MATCH_MODES.PATH },
    [TITLE_PAGE]: { volumePercent: 175, matchMode: SAVED_PAGE_MATCH_MODES.PAGE },
    [EPISODE]: { volumePercent: 225 },
  };

  assert.equal(findSavedPageMatch(savedPages, EPISODE).pageKey, EPISODE);
  assert.equal(findSavedPageMatch(savedPages, `${TITLE_PAGE}#other`).pageKey, TITLE_PAGE);
  assert.equal(findSavedPageMatch(savedPages, 'https://stream.example/series/science-fiction/another').pageKey, 'https://stream.example/series/science-fiction');
  assert.equal(findSavedPageMatch(savedPages, 'https://stream.example/series/comedy/another').pageKey, 'https://stream.example/series');
  assert.equal(findSavedPageMatch(savedPages, 'https://stream.example/films/1').pageKey, 'https://stream.example/');
  assert.equal(findSavedPageMatch(savedPages, 'https://unrelated.example/'), null);
});

test('rules: invalid modes and restricted URLs are rejected', () => {
  assert.equal(canonicalizeSavedPageRule(EPISODE, 'regex').ok, false);
  assert.equal(canonicalizeSavedPageRule('chrome://settings/', SAVED_PAGE_MATCH_MODES.SITE).ok, false);
  assert.equal(savedPageRuleMatches('not a url', SAVED_PAGE_MATCH_MODES.SITE, EPISODE), false);
});
