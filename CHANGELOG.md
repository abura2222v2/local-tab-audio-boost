# Changelog

User-visible changes only.

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
