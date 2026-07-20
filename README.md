# Local Tab Audio Boost

A private, local-only Chrome extension that temporarily amplifies audio on
the page you're currently viewing, from 0% to 300%. It is built for personal
use, loaded as an unpacked extension, and is not published to the Chrome Web
Store.

## What this extension does, precisely

**Any supported current http/https page can be temporarily boosted after an
explicit user action** - moving the main slider, or clicking **Enable
boosting**. You never need to save a page first.

**Saving a page is optional, and is not a capture permission.** Saving only
stores a few things for one **exact web page URL** - not a website, not a
domain, not "everything on this hostname":

- the exact canonical URL;
- your preferred volume percentage for that exact URL;
- a **title snapshot**, captured locally from the open tab at the moment you
  press **Add this page** (a manually added URL never gets one, because that
  page is never loaded);
- an optional **custom name** you typed yourself.

The last two are display labels only. They never affect matching, never affect
audio, and are never fetched from anywhere - see **Privacy** below.

For example, saving

```
https://film.example/watch/movie-123
```

saves only that exact address's preferred volume. Each of these is a
**different page** and has no saved preference of its own unless you save it
separately:

```
https://film.example/watch/movie-456        (different path)
https://film.example/catalog                (different path)
https://film.example/watch/movie-123?episode=2   (different query string)
https://film.example/watch/movie-123#episode-2   (different fragment)
http://film.example/watch/movie-123          (different scheme)
```

There is no "allow/save this whole site" mode. This is deliberate: it keeps
the extension's behavior exact, simple, and predictable, at the cost of
needing to re-save a page if a site changes its URL (see **Known
limitations** below).

100% is unmodified volume. 200% doubles the raw signal gain and 300% triples
it (GainNode gain of 1.0, 2.0, and 3.0 respectively). There is no compressor,
limiter, or any other audio processing in this version - only plain gain
multiplication - so 100% is (by construction, not just by intention)
indistinguishable from normal playback, and audio above 100% is not
protected from clipping or distortion in any way. The higher you go toward
300%, the more likely it is to clip or sound distorted.

## Why boosting doesn't start on its own

Chrome's `tabCapture` API requires an explicit user action every time capture
starts. Saving a page's preferred volume **never** causes it to be silently
boosted on a future visit, a new tab, after a browser restart, or after
reloading the extension - you always move the popup's slider or click
**Enable boosting** yourself. Navigating away from a boosted page - including
a reload, a link click, a redirect, or a same-page route change in a
single-page app - stops boosting immediately, with no gain carried over to
whatever loads next, whether or not the page was saved.

## Installing

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project's folder
   (`/home/abura/Desktop/extension`).
4. Pin the extension's icon to your toolbar if you'd like quick access.

## Using it

The popup has one main volume slider (0-300%) and four controls:

- **The main slider** always works on any supported current page, saved or
  not. Moving it on a page that isn't currently boosting starts a temporary
  session from that explicit interaction; you can also click **Enable
  boosting** first if you'd rather start at the current value. While active,
  the slider controls that tab's live gain. If the page is saved, letting go
  of the slider (or pressing a key) also updates that exact page's saved
  percentage; if it isn't saved, nothing is written to storage - the
  temporary gain simply applies to this session and is gone once it ends.
- **Add this page** saves the exact current URL and the slider's current
  value. It never starts, stops, or restarts capture - if a temporary
  session is already running on that tab, it simply keeps running,
  now associated with a saved preference. This button is hidden once the
  current exact page is already saved.
- **Add URL manually** opens a small dialog to save any exact URL (with a
  starting volume, default 100%) without visiting or capturing it at all.
- **Enable boosting** / **Disable boosting** is a single toggle that starts
  or stops a session on the current tab - saved or not.
- **Saved pages** opens the saved-pages management view, where you can:
  - **search** your saved pages locally (by name, captured title, hostname,
    URL, path, query, or fragment - multi-word queries match in any order);
  - adjust each page's saved volume with its own slider, which live-updates
    any tab currently boosting that identical exact URL and never starts a new
    session on its own;
  - **rename** any page (a local label only - the URL, volume, captured title,
    and any running session are all untouched; clearing the name falls back to
    the captured title, then to a label derived from the URL);
  - **select** pages with checkboxes and then **Reset selected to 100%** (keeps
    every record, keeps capture running, just returns the gain to 1.0) or
    **Delete selected** (stops each page's sessions first, then removes only
    those exact URLs);
  - delete individual entries, or clear the whole list (with a confirmation
    step, in a separate danger section).

  Selection and the search text live only in the open view - neither is ever
  saved to disk. Bulk actions report per-page results, so a page that fails is
  never counted as a success and stays selected so you can retry it.
- Two tabs showing the **identical** exact URL that are both currently
  boosting share one live propagation target: committing a change in either
  one (from the popup or the saved-pages view) updates the other too.

## Permissions, and exactly why each one is needed

| Permission | Why |
|---|---|
| `activeTab` | Lets the extension read the URL of the tab you just clicked on, and target it for capture, only for that gesture |
| `tabCapture` | The only way to capture a tab's audio without injecting a script into every page |
| `offscreen` | Service workers have no DOM; this hosts the `AudioContext` that does the actual audio processing |
| `storage` | Stores your saved pages and their preferred volumes locally |
| `webNavigation` | Detects when you navigate away from a boosted page - including single-page-app route and hash changes that a simpler API can't see - so boosting stops immediately |

No other permission is requested: not `tabs`, not `scripting`, not any host
permission, not `<all_urls>`, not `history`, not `cookies`, not
`webRequest`. There are no content scripts anywhere in this extension.

`webNavigation` can, in principle, see navigation events across the whole
browser. This extension immediately discards every such event for any tab it
is not actively boosting or starting to boost - the URL of an event for an
unrelated tab is never read, logged, stored, or analyzed. See `SECURITY.md`
for the exact code-level detail of how that's enforced.

## Privacy

- **Fully local.** No analytics, no telemetry, no advertisements, no update
  checker beyond Chrome's own extension system, and no network request of any
  kind, anywhere in the code.
- **Titles and names are local, and never fetched.** A page's title snapshot is
  read from the tab you already have open, only when you press **Add this
  page**, and only by the service worker (a title supplied by the popup is
  ignored). A manually added URL is never visited, so it gets no title at all -
  just the optional name you type. When a page has neither, its label is derived
  from the URL's own text. There is no title service, no favicon request, no
  Open Graph lookup, and no metadata API anywhere in this extension.
- **Search is entirely local**, running over data already in
  `chrome.storage.local`. Nothing you type into the search box leaves your
  machine, and the query is never stored.
- **Selection is temporary.** Which rows you have checked in the Saved pages
  view exists only while that view is open - it is never written to storage.
- **Exact page URLs can be sensitive** - they may contain access tokens,
  session identifiers, search queries, or other private information. This
  extension never sends a URL anywhere; it only ever exists in
  `chrome.storage.local` (hardened to trusted extension contexts only) and in
  short-lived messages between this extension's own popup, options page, and
  background components.
- `chrome.storage.local` is **not** an encrypted vault - anything with access
  to your Chrome profile on disk can potentially read it. Avoid saving pages
  whose URLs embed passwords or tokens you wouldn't want stored in plain
  text locally.
- No microphone or camera access, no cookie access, no browsing-history
  collection, no page-content collection.

## Known limitations

- Chrome requires a real user action to start capture, every time - this
  extension cannot and does not try to work around that.
- A page whose URL changes dynamically (session tokens, rotating query
  parameters) will stop matching your saved entry the moment the URL
  changes, even if it's "the same page" to you. You'll need to save it
  again.
- Closing the tab, replacing it (e.g. via Chrome's prerendering), reloading
  the extension, or restarting the browser all end an active boosting
  session - there is no way to resume automatically, whether or not the page
  is saved.
- `chrome://` pages, the Chrome Web Store, and a few other special pages
  can't be captured at all.
- Whether Chrome allows boosting more than one tab at the same time has not
  been exhaustively verified across every Chrome version - if you hit a
  limit, disable boosting on one tab before enabling it on another.
- There is no audio processing beyond plain gain multiplication. Amplifying
  above 100% can clip, distort, or sound uncomfortably loud, and can stress
  speakers or headphones. Use high percentages carefully.

## Testing this project

```
node --test
```

runs the unit test suite (`tests/urls.test.js`, `tests/validation.test.js`,
`tests/storage-logic.test.js`, `tests/service-worker-logic.test.js`,
`tests/offscreen-contract.test.js`, `tests/sender-validation.test.js`,
`tests/popup-gain-controller.test.js`, `tests/popup-controller.test.js`,
`tests/popup-modal.test.js`, `tests/saved-page-slider.test.js`,
`tests/options-clear-confirm.test.js`, `tests/saved-page-metadata.test.js`,
`tests/saved-pages-search.test.js`, `tests/saved-pages-view-model.test.js`) -
no install step, no dependencies.

```
node scripts/audit.mjs
```

runs the zero-dependency security/policy audit described in `SECURITY.md`.
Both commands should exit successfully before you trust a change to this
project.

Browser-level behavior (real audio capture, navigation handling, restart
reconciliation, the popup/saved-pages UI, etc.) can only be verified in an
actual loaded copy of Chrome - see `SECURITY.md` and the project's
implementation notes for the manual test steps.

## Inspecting the source and verifying there's no network activity

Every file in this project is plain, unminified, readable HTML/CSS/JavaScript
- open any of them directly. To confirm no network requests are ever made:

1. Load the extension unpacked (see **Installing** above).
2. Open `chrome://extensions`, find this extension, and click the
   **service worker** link to open its dedicated DevTools.
3. Open the **Network** panel there and use the extension normally (boost a
   page, save it, adjust the slider). The panel should stay empty.
4. Repeat with the **offscreen document**'s own DevTools (same extensions
   page, or via `chrome://inspect/#extensions`).

You can also simply search the source for `fetch(`, `XMLHttpRequest`,
`WebSocket`, or `EventSource` - `node scripts/audit.mjs` does this
automatically for you.

## Troubleshooting

- **"This page cannot be boosted"** - you're on a restricted page
  (`chrome://`, the Chrome Web Store, a page with credentials embedded in
  its URL, or similar). This is a Chrome limitation, not a bug.
- **Boosting stopped unexpectedly** - any navigation, including a reload or
  a single-page-app route change, stops boosting by design, whether or not
  the page is saved. Move the slider or click **Enable boosting** again.
- **The slider won't move** - it works on any supported current page; if it
  still seems unresponsive, check the status line for what's happening
  (e.g. "Starting…").

## Uninstalling and clearing local data

- To remove your saved pages without uninstalling: open **Saved pages** from
  the popup and use **Clear all saved pages**.
- To remove everything, including the extension itself: go to
  `chrome://extensions`, find this extension, and click **Remove**. This
  deletes its `chrome.storage.local` data along with it.

## Changelog

### 0.2.0

Saved pages becomes a real management view. Everything below is **fully local** -
no page is ever fetched, and no title, favicon, or metadata is ever looked up
online.

- **Local smart search.** A search box filters saved pages by custom name,
  captured title, generated label, hostname, full URL (raw and percent-decoded),
  path, query string, and fragment. Multi-word queries use *tokenized AND* -
  `rezka kandidat` matches a page whose hostname supplies one word and whose
  path supplies the other, in any order. Search only decides which rows are
  visible; it never widens audio matching beyond the exact page.
- **Checkboxes and bulk actions.** Every row has a checkbox, plus **Select all
  visible**, **Clear selection**, **Reset selected to 100%**, and **Delete
  selected**. Selection is temporary view state and is never stored. It survives
  a search change, so the counts always report totals, visible, and *hidden by
  search* - and the delete confirmation states the hidden count explicitly.
- **Reset selected to 100%** keeps every record and keeps capture running; it
  just returns the volume to 1.0 gain. **Delete selected** stops each page's
  matching sessions through the existing confirmed teardown *before* removing
  its record. Both report **per-page** results: one page failing never blocks
  another, a failed page is never reported as succeeded, and failed pages stay
  selected so you can retry.
- **Automatic title snapshots.** **Add this page** now stores the current tab's
  title, read by the service worker itself (a title supplied by the popup is
  ignored) and sanitized before storage. Re-saving refreshes the snapshot but
  keeps any name you chose.
- **Names.** **Add URL manually** gained an optional name field, and every row
  has **Rename**. A rename changes only the name - never the URL, the volume,
  the captured title, or any capture session. Clearing the name falls back to
  the captured title, then to a label derived locally from the URL itself
  (`https://www.youtube.com/watch?v=abc` → `youtube.com · watch`).
- **Storage schema 6.** Each saved page is now a record -
  `{volumePercent, titleSnapshot, customName}` - instead of a bare number.
  Existing schema-5 (and schema-4) profiles migrate automatically: every valid
  exact URL and volume is preserved, metadata starts empty, and the old data is
  never deleted until the new write succeeds.
- Live popup ↔ Saved pages slider synchronization, exact-page matching, the
  0-300% range, temporary boosting on unsaved pages, and every lifecycle
  guarantee are unchanged.

### 0.1.3

- **Saved pages sliders now control matching active tabs live.** Dragging a
  saved-page row slider immediately changes the real audio gain of any tab
  currently boosting that identical exact URL, throttled and without writing to
  storage; the final percentage is saved once when you release the slider.
- **The popup and Saved pages sliders synchronize in real time.** Moving the
  popup's main slider on a saved page moves that page's Saved-pages row (and
  vice-versa) as you drag, exact-page-scoped so a different path, query,
  fragment, scheme, port, or host is never touched. A failed or superseded live
  update never falsely moves either slider. The root cause was that a saved-page
  row drag only updated the stored number (and only on release), and neither
  view told the other about an in-progress drag.
- **The "Clear all" confirmation is hidden until requested.** It now stays out
  of sight until you click **Clear all saved pages**, and hides again on
  **Cancel**, on **Escape**, and after a successful clear (a failed clear keeps
  it visible with the error). The root cause was the same kind of stylesheet
  rule that affected the manual-add modal in 0.1.1: an author `display` rule
  overrode the `hidden` attribute, so the `hidden` attribute is now made
  authoritative with `[hidden] { display: none !important }`.

### 0.1.2

- Fixed **temporary boosting on unsaved pages**. **Enable boosting** now works
  on any supported page without saving it first and without touching the
  slider (it starts at the currently displayed value, normally 100%). The
  **first slider interaction** on an inactive page now correctly starts a
  temporary session and applies the exact value you selected - in either
  direction (e.g. 100% → 155% or 100% → 50%). The root cause was that the
  popup's tab-state response omitted the tab id, so the popup issued a capture
  request with a missing tab id that failed message validation.

### 0.1.1

- Fixed the **Add URL manually** modal: it no longer opens automatically when
  the popup is opened, and it now closes correctly on **Cancel**, on a
  successful **Save**, on **Escape**, and on clicking the backdrop outside the
  panel (clicking inside the panel keeps it open). A failed validation or save
  keeps it open and shows the error. The root cause was a popup stylesheet
  rule that overrode the `hidden` attribute; the `hidden` attribute is now the
  authoritative visibility state.
