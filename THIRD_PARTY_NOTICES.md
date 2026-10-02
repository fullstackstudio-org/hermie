# Third-party notices

Hermie is distributed under the MIT licence (see [LICENSE](LICENSE)). It includes and depends on
third-party software that carries its own terms. This file lists the code that is **copied into** or
**ported into** this repository, which is the half no tool can work out on its own.

The other half is generated: every package installed from npm that ships inside the app is listed,
with its licence text, in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md), which
`scripts/generate-third-party-licenses.mjs` writes from the lockfile.

## Hermes Agent — protocol sources

- **Project:** [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)
- **Copyright:** Nous Research
- **Licence:** MIT
- **Pinned commit:** `b9c2660ca479d9a2cf000d1d45ac9aadd1b7e3bd`
- **Vendored path:** `packages/hermes-shared/src/`
- **Upstream path:** `apps/shared/src/`

A subset of the pure-TypeScript sources that define the gateway protocol — the generated contract,
the event types, the JSON-RPC channel and gateway client, WebSocket URL handling, reconnect backoff,
slash-command parsing and a few small helpers — together with their tests. The exact file list is in
`packages/hermes-shared/upstream.json`.

The copy is produced by `scripts/sync-hermes-shared.mjs`, which pulls the files at the pinned commit
and applies a small set of mechanical rewrites so they run under React Native. Each vendored file
carries an attribution banner naming the project, the commit and the licence. The full upstream
licence text is kept at `packages/hermes-shared/LICENSE`.

The decision and its rationale are recorded in
[docs/adr/0003-vendor-hermes-shared.md](docs/adr/0003-vendor-hermes-shared.md), and the rewrites are
documented in [packages/hermes-shared/README.md](packages/hermes-shared/README.md).

## Hermes Agent — ported Desktop and gateway logic

- **Project:** [NousResearch/Hermes-Agent](https://github.com/NousResearch/Hermes-Agent)
- **Copyright:** Nous Research
- **Licence:** MIT
- **Pinned commit:** `b9c2660ca479d9a2cf000d1d45ac9aadd1b7e3bd`

Not every piece of upstream work in Hermie arrived as a copy. Parts of this client are a
**derivative work** of the upstream Desktop app and its gateway: logic that was read there and
written again here, because the original is React DOM against an Electron process and this is React
Native against a socket. The characters are ours; the behaviour, the order of the steps and often the
shape of the data are theirs, and under MIT that is the same attribution obligation as a copy.

**This list is maintained by hand, and has to be.** A port leaves no machine-readable trace — no
manifest entry, no checksum, nothing `scripts/sync-hermes-shared.mjs` can diff, and nothing a
licence scanner can see. The only record is the attribution each ported file carries in its own
header, so the rule is: a file that ports upstream logic says so at the top, and this section repeats
it. Every upstream path below is relative to the upstream repository at the pinned commit above.

| Our file                                         | Upstream origin                                                                                                             | What was ported                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/transcript/src/reconcile.ts`           | `apps/desktop/src/lib/chat-messages/reconciliation.ts`                                                                      | Folding a freshly hydrated transcript into live state without renaming items                                                                                     |
| `packages/transcript/src/rows-to-items.ts`       | `apps/desktop/src/lib/chat-messages/hydration.ts`, and the gateway's own projection in `tui_gateway/session_history.py`     | History rows → transcript items, for both the RPC and the REST row shapes                                                                                        |
| `packages/transcript/src/subagent-progress.ts`   | `apps/desktop/src/store/subagents.ts` (`toProgress`, `streamFromPayload`)                                                   | The `subagent.*` payload projection, including the status vocabulary                                                                                             |
| `packages/transcript/src/types.ts`               | `apps/desktop/src/store/subagents.ts` (`MAX_STREAM`)                                                                        | `SUBAGENT_STREAM_CAP`: how many stream lines a subagent row retains                                                                                              |
| `packages/transcript/src/bot-dm.ts`              | `apps/desktop/src/components/assistant-ui/thread/user-message.tsx`, `.../thread/agent-delivery.tsx`, `tools/bot_mode_dm.py` | The bot-to-bot wire conventions: the inbound delivery signature, `agentKey`, `dispatchedTo`, and both forms of the delivery command                              |
| `expo/hermie/src/chat-ui/tool-result-summary.ts` | `apps/desktop/src/lib/tool-result-summary.ts`                                                                               | The heuristic that turns an arbitrary tool result into one human line                                                                                            |
| `expo/hermie/src/chat-ui/tool-render-class.ts`   | `apps/desktop/src/lib/tool-render-class.ts`                                                                                 | Which surface a tool call renders as: card, silent, file edit, and the tool families                                                                             |
| `expo/hermie/src/markdown/preprocess.ts`         | `apps/desktop/src/lib/markdown-preprocess.ts`                                                                               | A subset: reasoning blocks, fence normalisation, `MEDIA:` tags and table spacing. Everything about maths and the desktop-only renderers was deliberately dropped |

These files also port upstream logic, but their own headers name the origin without naming a full
upstream path. They are listed because the obligation does not depend on our precision, and listed
apart from the table because a path nobody has checked against the pin would be worse than none:

- `packages/transcript/src/selectors.ts` — `subagentTree` is ported from upstream's
  `buildSubagentTree`.
- `packages/gateway-client/src/native-auth.ts` — `TokenCoordinator` is ported from the Hermes
  Desktop native access-token coordinator: one owner per refresh flight, with an auth epoch so a
  sign-in that lands mid-rotation cannot be overwritten.
- `expo/hermie/src/markdown/blocks.ts` — the two lexer caches are ported from the desktop app's
  `markdown-blocks.ts`.
- `expo/hermie/src/features/bots/bots-controller.ts` — canonical-chat resolution follows the
  desktop's order (roster field, then an exact-title `session.list`, then and only then
  `session.create`), and `PROFILE_SESSION_LIST_LIMIT` and `SESSION_COLUMNS` are the desktop's
  numbers.

What is deliberately **not** in this list: files that cite an upstream module to explain a
constraint rather than to credit a copy. `expo/hermie/src/features/chats/file-upload.ts` and
`expo/hermie/src/features/cron/cron-controller.ts` point at `tui_gateway/prompt_turn.py` and
`tui_gateway/methods_tools.py` to say why the client has to behave a certain way, and the fixtures in
`packages/transcript/src/__fixtures__/` are hand-written to mirror the wire shapes that
`tui_gateway/contracts/events.py` and `tui_gateway/session_history.py` produce. Describing an
interface is not copying an implementation.

## Contributor Covenant — code of conduct

- **Project:** [Contributor Covenant](https://www.contributor-covenant.org)
- **Licence:** CC BY 4.0
- **Vendored path:** `CODE_OF_CONDUCT.md`

Version 2.1 of the Contributor Covenant, adopted with the enforcement contact filled in. The text is
meant to be copied; the attribution it asks for is at the foot of the file itself.
