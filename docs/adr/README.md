# Architecture decision records

Every decision that is expensive to reverse gets a short record here: what we decided, why, and what
it costs. The point is not ceremony — it is that six months later the reasoning is still readable,
including the parts that turned out to be wrong.

Records are numbered and immutable once accepted. A decision that no longer holds is not edited: a
new record supersedes it, and the old one gets a line at the top pointing forward.

## Index

| ADR                                                    | Decision                                                                     | Status                     |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------- |
| [0001](0001-expo-sdk-54-rn-081.md)                     | Expo SDK 54 and React Native 0.81                                            | Amended by 0028, 0029      |
| [0002](0002-macos-via-react-native-macos.md)           | macOS through react-native-macos, in the same app package                    | Superseded by 0011, 0028   |
| [0003](0003-vendor-hermes-shared.md)                   | Vendor the Hermes protocol sources with a sync script                        | Accepted                   |
| [0004](0004-native-pkce-via-webview.md)                | Native PKCE sign-in through an intercepted web view redirect                 | Accepted                   |
| [0005](0005-ticket-per-websocket-dial.md)              | A fresh ticket per WebSocket dial, offered as a subprotocol                  | Accepted                   |
| [0006](0006-single-gateway-no-relay.md)                | One gateway per install, no cross-gateway bot relay                          | Amended by 0024            |
| [0007](0007-canonical-bot-chats-only.md)               | Only canonical Bot Chats                                                     | Accepted                   |
| [0008](0008-verbosity-as-client-selector.md)           | Verbosity is a client-side selector                                          | Accepted                   |
| [0009](0009-bot-to-bot-detection.md)                   | Bot-to-bot traffic is detected from transcript conventions                   | Accepted                   |
| [0010](0010-agent-questions-as-bottom-sheets.md)       | Questions from the agent are bottom sheets                                   | Accepted                   |
| [0011](0011-mac-via-the-ipad-build.md)                 | The Mac version is the iPad build                                            | Superseded by 0028 (Apple) |
| [0012](0012-local-chat-list-layout.md)                 | The chat list's arrangement and colours are client-local                     | Amended by 0016            |
| [0013](0013-cron-deliveries-in-the-transcript.md)      | A cron delivery is its own item kind, detected from its header               | Accepted, amended          |
| [0014](0014-plain-http-on-private-networks.md)         | Plain http is supported on a private network                                 | Accepted                   |
| [0015](0015-web-variant-on-its-own-port.md)            | The web variant is one server on its own port, same-origin                   | Superseded by 0030         |
| [0016](0016-ui-meta-sync.md)                           | Per-client settings live in `ui_meta`, one key per person                    | Accepted, amended          |
| [0017](0017-push-through-hermie-web.md)                | Push comes from the `hermie` gateway plugin; a device registers in `ui_meta` | Partly superseded by 0030  |
| [0018](0018-injected-rows-are-notices.md)              | A row the gateway injected is a notice, recognised by its shape              | Accepted                   |
| [0019](0019-folders-in-the-chat-list.md)               | The chat list groups into folders, and a bot is in exactly one               | Accepted                   |
| [0020](0020-diagrams-and-math-without-a-webview.md)    | Diagrams and mathematics are drawn in the bundle, not in a web view          | Accepted                   |
| [0021](0021-header-based-front-doors.md)               | Header-based front doors: Cloudflare Access                                  | Accepted                   |
| [0022](0022-voice-on-the-device.md)                    | Speech happens on the device; the gateway's voice RPCs are not used          | Amended by 0033 (speaking) |
| [0023](0023-the-shared-container-is-the-seam.md)       | The shared container is the seam for every system surface                    | Amended by 0026            |
| [0024](0024-a-list-of-gateways.md)                     | A list of gateways, one live at a time, storage keyed by which               | Amended by 0032, see 0030  |
| [0025](0025-hermie-web-is-a-service-layer.md)          | Hermie Web is a service layer, not only a proxy                              | Superseded by 0030         |
| [0026](0026-the-share-sheet-may-deliver.md)            | The share sheet may deliver, once, with the app's own answers                | Accepted                   |
| [0027](0027-desktop-is-a-webview-over-hermie-web.md)   | The desktop shell loads a remote Hermie Web URL, not a bundled export        | Amended by 0030            |
| [0028](0028-native-apps-on-apple-platforms.md)         | Native SwiftUI apps on Apple platforms, sharing one Swift package            | Accepted                   |
| [0029](0029-expo-native-and-the-contract-directory.md) | `expo/`, `native/` and a `contract/` both are tested against                 | Accepted, see 0030         |
| [0030](0030-web-client-served-by-the-plugin.md)        | The web client is served by the `hermie` plugin, on the gateway's origin     | Accepted                   |
| [0032](0032-icloud-gateway-sync.md)                    | Gateways follow the Apple Account through iCloud Keychain                    | Accepted                   |
| [0033](0033-the-gateways-voice-as-a-second-source.md)  | The gateway's voice is a second source for speaking                          | Accepted                   |

## Template

```markdown
# NNNN. Title in one line

- Status: Proposed | Accepted | Superseded by [NNNN](NNNN-....md)
- Date: YYYY-MM-DD

## Context

What forces are at play? What is true about the problem that makes this a decision rather than a
detail? Facts, constraints and the options that were actually considered.

## Decision

What we will do, stated plainly and in the present tense.

## Consequences

What becomes easier, what becomes harder, and what we are now committed to. Include the costs —
a record that only lists benefits is not describing a decision.
```
