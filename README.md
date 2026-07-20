# Local Tab Audio Boost

A local Chrome (Manifest V3) extension that adjusts the audio gain of the tab
you're currently viewing, from 0% to 300%. You can optionally save a preferred
volume for an **exact page URL**, so that page opens at your chosen level next
time. Nothing is ever captured automatically: boosting always starts from an
explicit action you take, and the extension makes no network requests at all.

## Features

- 0%–300% gain on the current tab (100% is unmodified audio).
- Temporary boosting on any supported page, without saving it first.
- Saved volume preferences scoped to one **exact** URL, never a whole site.
- Saved pages view with local search and bulk management.
- Local page-title snapshots, captured only when you press **Add this page**.
- Optional custom names for saved pages.
- Live synchronization between the popup slider and the Saved pages sliders.
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
- **Add URL manually** saves any exact URL, with an optional name and starting
  volume, without visiting or capturing it.

**Saved pages**

- **Search** filters the list locally by name, title, hostname, URL, path,
  query, or fragment. Multi-word queries match in any order.
- Each row has a checkbox, a volume slider, **Rename**, and an individual
  delete button.
- **Reset selected to 100%** sets the checked pages back to 100%. It keeps
  every record and keeps any active boosting running, just at normal volume.
- **Delete selected** removes only the checked pages, stopping active boosting
  for those exact URLs first.
- **Deselect all** only removes the checkmarks. It deletes nothing, changes no
  volume, and stops no capture.
- **Clear all saved pages**, under the collapsed *Delete all saved pages*
  section, removes **every** saved page — including pages hidden by the current
  search and pages that are not selected.

## Exact-page behavior

Saved preferences apply to one exact address. These are three different pages,
each with its own independent preference:

```
https://example.com/video
https://example.com/video?episode=2
https://example.com/video#player
```

Path, query, fragment, scheme, port, hostname, and subdomain all distinguish a
page. There is no site-wide or wildcard mode. If a site changes its URLs, you
will need to save the new address.

## Privacy

- All settings are stored locally via `chrome.storage.local`. Nothing is synced.
- Stored data is limited to exact page URLs, a volume percentage, an optional
  title snapshot, and an optional custom name.
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
| `webNavigation` | Detect navigation, including same-document route changes, so boosting stops immediately |

No host permissions, no content scripts, and no `externally_connectable`.

## Development

No runtime or development dependencies, and no build step.

```
node --test              # unit and integration test suite
node scripts/audit.mjs   # security and policy audit
```

Both should pass before any change is trusted. Browser-level behavior (real
audio capture, the popup and Saved pages UI) can only be verified by loading
the extension in Chrome.

## Known limitations

- Capture starts only after an explicit user action, every time — Chrome
  requires this and the extension does not work around it.
- Protected or DRM-controlled media may not be capturable.
- Raising gain above 100% is plain amplification with no limiter, so it can
  clip or distort.
- Restricted pages (`chrome://`, the Chrome Web Store, and similar) cannot be
  captured.
- A saved preference stops matching if the page's URL changes.
- Navigation, closing the tab, or reloading the extension ends an active
  session; there is no automatic resume.

## License

Released under the MIT License. See [LICENSE](LICENSE).

## Changelog

See [CHANGELOG.md](CHANGELOG.md).
