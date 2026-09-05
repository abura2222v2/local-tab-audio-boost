# Changelog

User-visible changes only.

## 0.5.0

- Added **Export saved pages** and **Import saved pages** to the Saved pages
  view. Export writes every saved page (its exact URL, volume, title
  snapshot, and custom name) to a local JSON file. Import reads a local JSON
  file - this extension's own export, or a hand-edited list with the same
  shape - and adds its pages; an already-saved exact URL is overwritten with
  the imported values. Neither ever touches the network: export only reads
  data already held locally, and import only ever reads a File the browser's
  own file picker handed to the page.

## 0.4.0

- Saved pages now **resume their boost automatically**. When you reopen, reload,
  or restore a page whose volume you saved — including after a browser or PC
  restart — its volume is reapplied on its own, with no need to open the popup
  or move the slider.
- Auto-resume uses the fullscreen-compatible engine only. A saved page that can
  only be boosted in compatibility mode still needs one manual click after a
  restart, because Chrome requires a user gesture for tab capture every time.
- Adds host access (`http://*/*`, `https://*/*`), used only to detect when a
  saved page loads and reapply its volume locally. No page URL is ever
  transmitted.

## 0.3.0

- Boosting now uses a **fullscreen-compatible** engine by default: the player's
  own fullscreen button and double-click keep working, and Chrome no longer
  shows the tab-capture indicator while boosting.
- Players that cannot use it (cross-origin audio without CORS, DRM, or an
  inaccessible frame) now say so, and offer **Use compatibility mode** as a
  separate choice instead of silently switching.
- The popup shows which mode is active.
- The offscreen audio document is now closed once compatibility mode has
  nothing left to do, and recreated on the next compatibility start.
- Adds the `scripting` permission, used only to inject the page audio engine
  after you press Enable boosting.

## 0.2.1

- Renamed **Clear selection** to **Deselect all** to make it clearly distinct
  from **Delete selected**.
- Moved **Clear all saved pages** into a collapsed *Delete all saved pages*
  section, so the destructive action no longer occupies a permanent block.
- Success messages now disappear on their own after a few seconds; errors stay
  visible until something replaces them.
- Simplified the public documentation.

## 0.2.0

- Added local search across saved pages, matching on name, title, hostname,
  URL, path, query, and fragment, with multi-word queries in any order.
- Added row checkboxes, **Select all visible**, **Reset selected to 100%**, and
  **Delete selected**.
- Saved pages now store a locally captured page title and an optional custom
  name, with **Rename** on every row.
- **Add URL manually** gained an optional name field.

## 0.1.3

- Saved pages sliders now change the audio of a matching tab live, and the
  popup and Saved pages sliders stay in sync while either one is dragged.
- The **Clear all** confirmation no longer appeared before it was requested.

## Earlier releases

- Initial release: temporary tab boosting from 0% to 300%, exact-page saved
  volume preferences, **Add this page**, **Add URL manually**, and the Saved
  pages view.
- Reliability fixes for temporary boosting on unsaved pages and for the
  **Add URL manually** dialog.
