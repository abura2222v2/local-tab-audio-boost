# Security

## Reporting a security issue

Please report suspected vulnerabilities by opening an issue in this
repository's issue tracker.

Do **not** include secrets in a public report: no access tokens, passwords,
cookies, session identifiers, or full URLs that embed any of those. A
description of the problem and the steps to reproduce it is enough.

## Security model

This extension is local-only. There is no server, account, API key, or network
request initiated by the extension. Its relevant risk surfaces are local state
and the untrusted web pages where fullscreen-compatible audio runs:

- Something with access to your Chrome profile directory could read
  `chrome.storage.local` and see which URL rules you have saved.
- A bug in this extension could misuse a capability it already holds.
- A hostile page can observe or interfere with objects and DOM events in its
  own MAIN world. It can disrupt its own audio processing or make the displayed
  page-audio status unreliable, but that channel exposes no extension API,
  storage access, saved URL, tab ID, or compatibility-capture permission.

Design decisions that follow from that:

- **The service worker is the only component that writes persistent storage.**
  The popup and the Saved pages view never touch `chrome.storage.local`; every
  mutation goes through a validated message.
- **Every message is validated by both target and type**, and by the sender
  context allowed to send it. A message addressed to one component can never be
  validated against another component's payload shape.
- **MAIN-world replies are untrusted.** The service worker validates the full
  controller snapshot, including its operation token and bounded fields, before
  it updates derived session state. This limits malformed or forged replies,
  although no extension can stop a page from sabotaging code running in that
  page's own MAIN world.
- **Capture teardown is fail-closed.** The extension never reports a tab as
  silent unless the offscreen document positively confirmed that its audio
  graph was torn down; if that cannot be confirmed, it escalates to an
  unconditional shutdown rather than assuming success.
- **Capture is scoped to a session generation.** A delayed or superseded
  message cannot affect a newer session that happens to share the same tab.
- **URLs with embedded credentials are rejected** and can never be saved.

## Saved URLs can be sensitive

A page's exact URL can embed access tokens, session identifiers, document IDs,
search queries, or other private information. This extension never transmits a
URL anywhere, and stores URLs only in `chrome.storage.local`, restricted to
trusted extension contexts.

`chrome.storage.local` is **not** an encrypted vault. Anything with access to
your Chrome profile on disk can potentially read it. Avoid saving pages whose
URLs embed secrets you would not want stored in plain text locally.

## Permissions

The extension requests six permissions — `activeTab`, `tabCapture`,
`offscreen`, `storage`, `webNavigation`, and `scripting` — plus
`host_permissions` for `http://*/*` and `https://*/*`, and no content scripts
or `externally_connectable`. See the README for what each one is for.

`host_permissions` is what lets a saved page resume its boost automatically:
when a top-level page finishes loading, the extension canonicalizes its URL
 and checks it against the rules you have saved locally, and only on a valid
 local match injects the packaged audio engine to reapply your saved volume. This
necessarily relaxes the previous "a tab's URL is never read until it is already
boosting" property: a committed top-level URL is now read to be matched against
local storage. It is matched only through the single canonical matcher in
`shared/urls.js`, is never transmitted, logged, or stored by the match itself,
and a URL that does not match a saved page is used for nothing further.

`webNavigation` can in principle deliver navigation events for tabs across the
whole browser. Every navigation listener here returns immediately for subframe
events. For a top-level event, the URL is read only to (a) tear down a session
this extension is already running on that tab, or (b) match it against your
locally saved pages for auto-resume; it is never transmitted, logged, or
stored, and an event for a page that is neither boosting nor saved leads to no
further action.

## Verifying this yourself

Every file is plain, unminified JavaScript, HTML, and CSS.

```
node scripts/audit.mjs
```

audits permissions, forbidden APIs, storage-write containment, and other policy
invariants. To confirm there is no network activity, open the service worker's
and the offscreen document's DevTools from `chrome://extensions`, use the
extension normally, and watch the Network panels stay empty.
