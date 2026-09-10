# Local Tab Audio Boost

A local Chrome (Manifest V3) extension that adjusts the audio gain of the tab
you're currently viewing, from 0% to 300%. You can save a preferred volume for
an exact URL or a broader local URL rule, and matching pages automatically resume your chosen level
whenever you reopen it — including after a browser or PC restart — using the
fullscreen-compatible engine. The extension does not initiate network requests.
Web pages and their media players continue making their normal requests
independently.

## Features

- 0%–300% gain on the current tab (100% is unmodified audio).
- Temporary boosting on any supported page, without saving it first.
- Saved volume preferences can target an exact address, one page across URL
  fragments, a path section and its subpages, or an entire website.
- Automatic resume: a matching saved rule reapplies its volume when you reopen
  a page, reload it, restore it after a browser/PC restart, or navigate inside
  a single-page app — no click needed (fullscreen-compatible
  engine only).
- Saved pages view with local search and bulk management.
- Export saved pages to a local JSON file, and import them back (or a
  hand-edited list with the same shape) — fully local, no network access.
- Local page-title snapshots, captured only when you press **Add this page**.
- Optional custom names for saved pages.
- Live synchronization between the popup slider and the Saved pages sliders.
- **Fullscreen-compatible mode**: boosting normally keeps the player's own
  fullscreen working, with no tab-capture indicator.
- No network access, no analytics, no telemetry, no third-party dependencies.

## Installation

This extension is not published to the Chrome Web Store; load it unpacked.

1. Download or clone this repository.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the directory containing `manifest.json`.

## Usage

**Popup**

- **The slider** works on any supported page. Moving it on a page that isn't
  boosting yet starts a temporary session at that value. While a session is
  active, it controls that tab's live gain.
- **Enable boosting / Disable boosting** starts or stops a session on the
  current tab, saved or not.
- **Add this page** saves the current exact URL with the slider's current value
  and a snapshot of the tab's title. It never starts or stops capture.
- **Add URL manually** saves an exact URL, with an optional name and starting
  volume, without visiting or capturing it.

**Saved pages**

- **Add an address** lets you paste a URL and choose its scope: exact address,
  page and episode fragments, section and subpages, or the entire website.
- **Search** filters the list locally by name, title, hostname, URL, path,
  query, or fragment. Multi-word queries match in any order.
- Each row has a checkbox, a volume slider, **Rename**, and an individual
  delete button.
- **Reset selected to 100%** sets the checked pages back to 100%. It keeps
  every record and keeps any active boosting running, just at normal volume.
- **Delete selected** removes only the checked pages, stopping active boosting
  for tabs currently governed by those rules first.
- **Deselect all** only removes the checkmarks. It deletes nothing, changes no
  volume, and stops no capture.
- **Clear all saved pages**, under the collapsed *Delete all saved pages*
  section, removes **every** saved page — including pages hidden by the current
  search and pages that are not selected.
- **Export saved pages** saves every saved page (URL, volume, title snapshot,
  matching scope, and custom name) to a local JSON file. **Import saved pages** reads a local
  JSON file — this extension's own export, or a hand-edited list with the same
  shape — and adds its rules; an already-saved rule is overwritten with
  the imported values. Imports are limited to 5 MB and large valid lists are
  processed in bounded batches. Neither action ever touches the network.

## Audio modes

**Fullscreen-compatible** (the default). Pressing **Enable boosting** injects a
small audio engine into the page and routes the player's own media through a
gain node. Because no tab capture is involved, the page's fullscreen button and
double-click keep working normally, and Chrome shows no capture indicator.
Injection happens when you press Enable, or automatically when a page you have
saved finishes loading or becomes current through same-document navigation; it
uses packaged files from the extension, and never reads or sends page content.

Some players cannot be used this way — audio served cross-origin without CORS,
DRM-protected media, and players inside frames the extension cannot reach. In
those cases the popup says why and offers **Use compatibility mode** as a
separate, deliberate choice.

**Compatibility mode** uses Chrome's tab capture, as earlier versions always
did. It works with more players, but while it is active Chrome may keep
fullscreen inside the browser tab and shows the capture indicator. It is never
selected automatically.

When you disable boosting in fullscreen-compatible mode, the gain returns to
100% (audibly identical to the extension not being there). The audio routing
itself stays in place until you navigate away, because removing it could
silence media that is already playing through it.

## Saved URL rules

Each saved address has one of four scopes:

- **Exact address** matches the complete URL, including query and fragment.
- **Page and episodes** ignores only the fragment. This is useful when a player
  stores season or episode selection after `#`.
- **Section and subpages** matches that path and deeper path segments on the
  same origin. `/series/fiction` does not accidentally match `/series/fictional`.
- **Entire website** matches every path on the same scheme, hostname, and port.

When several rules match, the most specific one wins: exact address, page,
longest section path, then entire website. Subdomains remain separate websites.

### Fictional streaming-site example

Suppose the current episode URL is:

```text
https://stream.example/series/science-fiction/snow-train.html#season:2-episode:10
```

Choose the scope based on what you want:

| Saved address | Scope | What it controls |
|---|---|---|
| `https://stream.example/series/science-fiction/snow-train.html#season:2-episode:10` | Exact address | Only season 2, episode 10 at this complete URL |
| `https://stream.example/series/science-fiction/snow-train.html` | Page and episodes | Every episode represented by a different `#...` fragment on this title page |
| `https://stream.example/series/science-fiction` | Section and subpages | This section and its deeper paths |
| `https://stream.example/` | Entire website | Every page on this exact website origin |

For most series pages that keep the episode after `#`, use **Page and
episodes**. The extension does not contact the example website when you save
the rule. It only compares the current tab URL with the locally stored rule.

## Privacy

- All settings are stored locally via `chrome.storage.local`. Nothing is synced.
- Stored data is limited to saved URL rules, their matching scope, a volume
  percentage, an optional title snapshot, and an optional custom name.
- The extension makes **no network requests**, and contains no analytics or
  telemetry.
- Manually added URLs are never fetched or opened.
- A page title is captured locally from the tab you already have open, and only
  when you explicitly press **Add this page**.
- Exact URLs can contain sensitive query parameters or fragments — see
  [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md).

## Permissions

| Permission | Why it is needed |
|---|---|
| `activeTab` | Read the URL of the tab you acted on, and target it for capture |
| `tabCapture` | Capture that tab's audio without injecting a content script |
| `offscreen` | Host the `AudioContext` that applies the gain (service workers have no DOM) |
| `storage` | Store saved pages and their preferences locally |
| `webNavigation` | Detect navigation, including same-document route changes, so boosting stops immediately — and detect when a saved page loads, so it can resume its volume |
| `scripting` | Inject the page audio engine, when you press Enable boosting or when a saved page auto-resumes |
| `host_permissions` (`http://*/*`, `https://*/*`) | Read a loading tab's URL to check it against your locally saved pages, and inject the audio engine to resume the saved volume — without waiting for a click. The URL is only matched locally and never transmitted |

No content scripts and no `externally_connectable`.

## Development

No runtime or development dependencies, and no build step.

```
node --test              # unit and integration test suite
node --test --experimental-test-coverage  # suite plus coverage report
node scripts/audit.mjs   # security and policy audit
```

The test suite and security audit should pass before any change is trusted. Browser-level behavior (real
audio capture, the popup and Saved pages UI) can only be verified by loading
the extension in Chrome. A dependency-free local audio page and release
checklist are available in [TESTING.md](TESTING.md).

## Known limitations

- Auto-resume uses the fullscreen-compatible engine only. **Compatibility
  mode cannot auto-resume**: Chrome requires a genuine user gesture for every
  tab-capture call, so a saved page that only works in compatibility mode
  still needs one manual **Use compatibility mode** click after a restart.
- Protected or DRM-controlled media may not be capturable, and cannot use
  fullscreen-compatible mode at all.
- Players whose audio is cross-origin without CORS, or that live in an
  inaccessible frame, fall back to compatibility mode.
- Raising gain above 100% is plain amplification with no limiter, so it can
  clip or distort.
- Restricted pages (`chrome://`, the Chrome Web Store, and similar) cannot be
  captured.
- A saved preference applies only while the current URL matches its rule.
  Navigating to a URL governed by a more specific rule applies that rule.
- A page you never saved is never boosted on its own — auto-resume applies
  only to URLs matched by rules you have saved.

## License

Released under the MIT License. See [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
