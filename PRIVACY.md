# Privacy Policy

**Local Tab Audio Boost** collects no data.

## What is collected

Nothing. There is no data collection, no analytics, no telemetry, no crash
reporting, no advertising, and no user identifier of any kind.

## Network activity

The extension makes no network requests. It contains no code that could make
one: no `fetch`, no `XMLHttpRequest`, no `WebSocket`, no `EventSource`, no
remote scripts, no remote fonts, and no remote images. Nothing you do in the
extension leaves your device.

In particular:

- URLs you add manually are **never** fetched or opened.
- No page title, favicon, or other metadata is ever looked up online.
- Search happens entirely on your own machine, over data already stored there.

## What is stored locally

Saved pages are stored on your device via `chrome.storage.local`, restricted to
trusted extension contexts. For each page you choose to save:

| Field | Contents |
|---|---|
| exact page URL | the address you saved, used as the key |
| volume percentage | an integer from 0 to 300 |
| title snapshot | the tab's title, read locally only when you press **Add this page**; empty for manually added URLs |
| custom name | an optional label you type yourself; empty unless you set one |

Nothing else is persisted. The search text you type and which rows you have
checked exist only while the Saved pages view is open and are never written to
storage. Whether a tab is currently boosting is in-memory state only.

Exact URLs can contain sensitive query parameters, fragments, or identifiers.
They are never transmitted, but they are stored in plain text locally — see
[SECURITY.md](SECURITY.md).

## Deleting your data

- Remove one page with its delete button, or select pages and use **Delete
  selected**.
- Remove everything with **Clear all saved pages**, under *Delete all saved
  pages* in the Saved pages view.
- Uninstalling the extension from `chrome://extensions` deletes its
  `chrome.storage.local` data along with it.

## Audio

Tab audio is processed locally by an offscreen document using the Web Audio
API, and only while you have explicitly started boosting. Audio is never
recorded, stored, or transmitted.
