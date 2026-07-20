# Security

## Reporting a security issue

Please report suspected vulnerabilities by opening an issue in this
repository's issue tracker.

Do **not** include secrets in a public report: no access tokens, passwords,
cookies, session identifiers, or full URLs that embed any of those. A
description of the problem and the steps to reproduce it is enough.

## Security model

This extension is local-only. There is no server, no account, no API key, and
no network request of any kind, so there is no remote attack surface to
protect. The realistic risk surface is entirely local:

- Something with access to your Chrome profile directory could read
  `chrome.storage.local` and see which exact page URLs you have saved.
- A bug in this extension could misuse a capability it already holds.

Design decisions that follow from that:

- **The service worker is the only component that writes persistent storage.**
  The popup and the Saved pages view never touch `chrome.storage.local`; every
  mutation goes through a validated message.
- **Every message is validated by both target and type**, and by the sender
  context allowed to send it. A message addressed to one component can never be
  validated against another component's payload shape.
- **Capture teardown is fail-closed.** The extension never reports a tab as
  silent unless the offscreen document positively confirmed that its audio
  graph was torn down; if that cannot be confirmed, it escalates to an
  unconditional shutdown rather than assuming success.
- **Capture is scoped to a session generation.** A delayed or superseded
  message cannot affect a newer session that happens to share the same tab.
- **URLs with embedded credentials are rejected** and can never be saved.

## Exact URLs can be sensitive

A page's exact URL can embed access tokens, session identifiers, document IDs,
search queries, or other private information. This extension never transmits a
URL anywhere, and stores URLs only in `chrome.storage.local`, restricted to
trusted extension contexts.

`chrome.storage.local` is **not** an encrypted vault. Anything with access to
your Chrome profile on disk can potentially read it. Avoid saving pages whose
URLs embed secrets you would not want stored in plain text locally.

## Permissions

The extension requests exactly five permissions — `activeTab`, `tabCapture`,
`offscreen`, `storage`, and `webNavigation` — and no host permissions, content
scripts, or `externally_connectable`. See the README for what each one is for.

`webNavigation` can in principle deliver navigation events for tabs across the
whole browser. Every navigation listener here returns immediately for subframe
events, and then checks whether the event's tab is one this extension is
actually boosting **before reading the event's URL**. The URL of an event for
an unrelated tab is therefore never read, logged, stored, or analyzed.

## Verifying this yourself

Every file is plain, unminified JavaScript, HTML, and CSS.

```
node scripts/audit.mjs
```

audits permissions, forbidden APIs, storage-write containment, and other policy
invariants. To confirm there is no network activity, open the service worker's
and the offscreen document's DevTools from `chrome://extensions`, use the
extension normally, and watch the Network panels stay empty.
