# Browser test checklist

The automated suite exercises the service worker, storage, validation, page
audio controller, and the real offscreen audio lifecycle. Chrome still owns
the actual extension installation, tab capture, popup, and Fullscreen APIs, so
run this short local check before a release.

## Start the local test page

1. Run `npm run test:manual-server` from the repository directory.
2. Open `http://127.0.0.1:4173/` in Chrome.
3. Load this repository as an unpacked extension from `chrome://extensions`.
4. Confirm that the extension card and its service worker show no errors.

The test page generates its WAV in browser memory and uses no external media,
services, dependencies, or network hosts.

## Fullscreen-compatible mode

1. Press **Create source now**, then Play.
2. Open the extension popup and set the volume to 175%.
3. Confirm the tone is louder and the popup reports an active
   fullscreen-compatible session.
4. Press **Toggle page fullscreen** and confirm entering and leaving fullscreen
   still works while the boost remains active.
5. Disable boosting and confirm the tone returns to its normal level.

## Source assigned after activation

1. Reload the test page and enable boosting before creating an audio source.
2. Press **Create source after 2 seconds**.
3. After the source appears, press Play and confirm the already-armed session
   becomes active without toggling the extension off and on.

## Exact SPA routes and automatic resume

1. Press **Route A**, set 175%, and save that exact page.
2. Press **Route B**, set 225%, and save that exact page.
3. Move between Route A and Route B. Confirm each route automatically receives
   its own saved value.
4. Press **Unsaved route**. Confirm automatic boosting stops there.
5. Reload each saved route directly and confirm its exact value resumes.

## Compatibility mode

1. Start the tone and select **Use compatibility mode** in the popup.
2. Confirm Chrome shows its capture indicator and the slider changes the tone.
3. Disable boosting. Confirm the indicator disappears and the tone is normal.

## Saved pages and accessibility

1. Open Saved pages. Export, then re-import the JSON and confirm the page names
   and volumes remain intact.
2. Open **Add URL manually** in the popup. Use Tab and Shift+Tab to confirm focus
   stays in the dialog.
3. Close with Escape and confirm focus returns to **Add URL manually**.
4. Check the popup and Saved pages at 100%, 125%, and 200% display scaling.
