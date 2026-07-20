# Security

This document describes the threat model, permissions, stored data, and
verification steps for **Local Tab Audio Boost**, a private, local-only
Chrome extension. It is intended for personal use and is not published or
distributed.

## Threat model

There is no server, no account, and no credential of any kind for this
extension to protect - it makes no network requests at all. The realistic
risk surface is entirely local:

- Something with access to your Chrome profile directory reading
  `chrome.storage.local` and seeing which exact page URLs you've boosted
  (which could embed sensitive query parameters or tokens - see below).
- A bug in this extension's own code accidentally exposing a capability it
  shouldn't (e.g. a permission being used for something other than its
  stated purpose).

There is no meaningful "remote attacker" threat model here, because there is
no network-facing surface whatsoever.

## Permissions, exactly

```jsonc
"permissions": ["activeTab", "tabCapture", "offscreen", "storage", "webNavigation"]
```

| Permission | Exact reason | Code site | What it exposes |
|---|---|---|---|
| `activeTab` | Temporary, gesture-scoped access to the tab the user just clicked on - lets the service worker read that tab's URL and target it for capture | `service-worker.js`: `chrome.tabs.get`, `chrome.tabCapture.getMediaStreamId` | Read access to one specific tab's URL, only while that gesture-derived grant is live |
| `tabCapture` | The only API that captures a tab's audio without injecting a content script or requesting broad host access | `service-worker.js`: `getMediaStreamId`, `getCapturedTabs`; `chrome.tabCapture.onStatusChanged` listener | Ability to capture the current tab's media stream, only after an explicit user gesture |
| `offscreen` | Service workers have no DOM/`AudioContext`; this hosts the one document that does | `service-worker.js` (lifecycle), `offscreen/offscreen.js` | One hidden, extension-origin HTML document |
| `storage` | Persists exact saved pages and their preferred volumes locally | `shared/settings.js`, the only module that touches `chrome.storage.local` | Local key-value storage scoped to this extension, never synced or transmitted |
| `webNavigation` | Detects same-document URL changes (`pushState`/`replaceState`/hash-only) that `chrome.tabs.onUpdated` cannot reliably see, so boosting stops instantly on any navigation | `service-worker.js`: `onCommitted`, `onHistoryStateUpdated`, `onReferenceFragmentUpdated`, `getFrame` | Navigation events, including full URLs, delivered broadly across the browser - see the mitigation below |

No other permission exists in this project: no `tabs`, no `scripting`, no
`host_permissions`/`optional_host_permissions`/`<all_urls>`, no `history`, no
`cookies`, no `webRequest`, no `declarativeNetRequest`, no `content_scripts`,
no `externally_connectable`, no unjustified `web_accessible_resources`.

### `webNavigation`'s privacy exposure and how it's mitigated

`webNavigation` can, by itself, deliver navigation events (including URLs)
for tabs across the whole browser, not just the tab the user is currently
interacting with. This extension mitigates that exposure at the code level,
not just by policy:

1. Every one of the three navigation-family listeners in `service-worker.js`
   (`onCommitted`, `onHistoryStateUpdated`, `onReferenceFragmentUpdated`)
   first checks `details.frameId !== 0` and returns immediately for any
   subframe event, before reading anything else.
2. It then awaits `ensureReconciled()` - the service worker's cold-start
   state-reconciliation gate - so that its view of "which tabs are currently
   being boosted" is never stale or empty right after a fresh service-worker
   instance starts.
3. Only then does it check whether the event's `tabId` corresponds to a tab
   this extension is currently starting or actively boosting. If not, the
   handler returns **without ever reading `details.url`**.

Because of this ordering, a navigation event's URL is structurally never
read, logged, stored, or analyzed for any tab this extension isn't actively
boosting or starting to boost - not merely "discarded after being read."

## Everything this extension stores, and everything it does not

Stored, in `chrome.storage.local` only:

```jsonc
// "settings"
{ "schemaVersion": 6 }

// "savedPages"
{
  "https://film.example/watch/movie-123": {
    "volumePercent": 150,
    "titleSnapshot": "Movie 123 - Film Example",
    "customName": ""
  }
}
```

That's the entire persisted state: a schema version number, and a map of
exact page URLs to a small record. Nothing else is ever written to persistent
storage.

The three record fields, and where each one comes from:

- **`volumePercent`** - an integer from 0 to 300. The only field that affects
  audio.
- **`titleSnapshot`** - a **local** snapshot of the tab's own title, read by
  the service worker via `chrome.tabs.get` at the moment you press **Add this
  page**, and nowhere else. A title supplied by the popup in the message
  payload is deliberately ignored, so a compromised or buggy popup cannot write
  an arbitrary label into storage. It is sanitized before storage (control
  characters stripped, whitespace collapsed, length-limited) and is never
  refreshed in the background. A **manually added** URL is never loaded, so it
  never gets a title snapshot at all.
- **`customName`** - an optional label you typed yourself, via the **Add URL
  manually** name field or a row's **Rename**. Sanitized and length-limited the
  same way. Setting it empty clears it.

Both metadata fields are **display labels only**. Neither affects exact-page
matching, neither affects audio, and neither is ever fetched: there is no title
service, no favicon request, no Open Graph or oEmbed lookup, and no metadata API
anywhere in this extension. When a page has neither label, its display name is
derived locally from the URL's own text (see `shared/saved-page-metadata.js`).

**Never persisted:** the Saved-pages **search query** and the **row selection**
are temporary state inside the open options page. They are never written to
storage, never included in a saved-page record, and disappear when the view
closes. Live capture-session state (operation IDs, which tabs are boosting) is
likewise in-memory only.

Schema-5 profiles (where each `savedPages` value was a bare number) migrate
automatically into schema-6 records the first time this version runs: every
valid canonical exact URL and its valid volume is preserved, and both metadata
fields start empty. As with the schema-4 migration below, the new data is
written before anything old is removed, and a failed write leaves the original
data untouched so the migration can be retried rather than losing it.

**A saved page is a stored preference, never a capture permission.**
Boosting any supported current http/https page requires only an explicit
user action (moving the popup's slider or clicking Enable boosting) - it
never checks, and never required, an entry in `savedPages`. Saving only
determines the starting volume a page opens at and whether a slider commit
is written anywhere; it never starts, stops, or is a precondition for a
capture session. A prior version of this extension (schema 4) called this
map `allowedPages` and required a page to be present in it before capture
could start at all - that requirement no longer exists. Schema 4 installs
are migrated automatically and losslessly into schema-6 `savedPages` the first time
this version runs (see `shared/settings.js`); the migration preserves every
valid canonical exact URL and its valid percentage, and never itself grants
or implies any capture permission, present or past. Once the schema-6 write
succeeds, the old `allowedPages` key is deleted from `chrome.storage.local`
so no stale copy of your exact URLs lingers; if that write fails the legacy
key is left intact so the migration can retry rather than lose data.

**Never stored, anywhere:** browsing history beyond the pages you explicitly
add, page content, credentials, cookies, analytics/telemetry identifiers, or
anything derived from a network request (because none are ever made).

### Exact URLs can be sensitive

A page's exact URL can embed access tokens, session identifiers, user or
document IDs, search queries, tracking parameters, or other private
information. This extension:

- never transmits a URL anywhere off-device;
- stores URLs only in `chrome.storage.local`, hardened via
  `chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})` at
  service-worker startup, which removes the default exposure of
  `chrome.storage.local` to content scripts (this extension has none, but the
  call is defense-in-depth regardless);
- never strips query strings or fragments to "sanitize" a stored URL - exact
  matching depends on them being preserved verbatim;
- rejects any URL containing embedded `username`/`password` credentials
  outright, at the point of validation, before it can ever be stored;
- never writes a full page URL to `console.log`/`console.error` during normal
  operation - diagnostic output references `tabId` and structured error
  codes only. (The popup's on-screen display of the current page's URL is a
  direct UI element for the user's own page, not a log.)

**`chrome.storage.local` is not an encrypted vault.** Anything with access to
the Chrome profile on disk can potentially inspect it. The options page
displays this warning directly: *"Exact page addresses are stored locally.
Avoid adding URLs that contain passwords, access tokens, or other secrets."*

## No network, no third-party code

- No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, or
  `navigator.sendBeacon` call exists anywhere in the runtime source.
- No `eval`, `new Function`, or `WebAssembly` usage exists anywhere.
- No npm dependency, `devDependency`, `node_modules` directory, or
  dependency-generated lockfile exists. `package.json` exists solely to
  configure Node's built-in test runner.
- No CDN-hosted script, external font, external icon, or external image is
  referenced anywhere. All icons are original artwork created for this
  project.
- No content script is registered anywhere, and no `host_permissions` of any
  kind are requested.
- No code from the Chrome Web Store extension used as a design reference
  ("Volume Booster") was copied - this codebase is independently written.
- No dynamics processing exists in the audio graph (`MediaStreamAudioSourceNode
  → GainNode → destination` only) - there is no `DynamicsCompressorNode`,
  `WaveShaperNode`, or automatic-gain code anywhere, and no recording of
  captured audio to storage or disk. The single `GainNode`'s gain is the
  user-selected percent divided by 100 (0-300%, i.e. gain 0.0-3.0); above
  100% it is plain multiplication with no limiter, so it can clip or distort.

## Auditing the source yourself

`scripts/audit.mjs` is a zero-dependency Node script (`node:fs`/`node:path`
only) that mechanically checks most of the claims above against the actual
runtime files (`manifest.json`, `service-worker.js`, `offscreen/`, `popup/`,
`options/`, `shared/` - deliberately excluding `tests/`, this file, `README.md`,
and `LICENSE`, so an example URL in documentation or a test fixture is never
misidentified as a real network endpoint). Run it with:

```
node scripts/audit.mjs
```

It checks, among other things: the manifest's permission list is exactly the
five listed above; no forbidden manifest keys exist; no dependency or
`node_modules` exists; no forbidden runtime API (`fetch`, `eval`, etc.) is
used; no external script/style/font/image reference exists; `shared/urls.js`
is the only file defining page-matching logic; no polling/heartbeat/
`chrome.alarms` code exists; no compressor/limiter/AGC code exists;
`chrome.storage.local.set` is only ever called from `shared/settings.js`; no
`onMessage` listener is declared `async`; and several structural markers
confirming the reconciliation, operation-tracking, and teardown logic
described above are actually present in the code. A few checks (minification
detection, possible URL-logging detection, and confirming a listener is
registered at module top level rather than nested in a function) are
explicitly reported as **advisory** rather than hard failures, since they are
necessarily heuristic - review those manually rather than trusting the script
alone for those specific properties.

### Manually inspecting network activity

1. Load this extension unpacked via `chrome://extensions` (Developer mode →
   Load unpacked).
2. On that page, click this extension's **service worker** link to open its
   dedicated DevTools, and separately open the **offscreen document**'s
   DevTools (same page, or `chrome://inspect/#extensions`).
3. Open the **Network** panel in each and use the extension normally. Both
   panels should remain empty for the lifetime of the extension.

## Reporting a problem

This project is not published or distributed - if you're reading this file,
you already have the complete source. There is no public issue tracker to
report to. If you find a problem, fix it directly in your own copy, or note
it for yourself before sharing this project further.
