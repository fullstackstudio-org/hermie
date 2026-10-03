# @hermie/fake-gateway

An in-process stand-in for `hermes serve`, for tests and offline development. It speaks the status
endpoints, the authentication flows, WebSocket tickets and the JSON-RPC surface the clients call.
See [the fake gateway in CONTRIBUTING.md](../../CONTRIBUTING.md#the-fake-gateway) for the general
use, `npm run fake-gateway -- --help` for every flag and control endpoint, and `src/server.ts` for
the behaviour of each method. This file documents the passkey level, which is new enough to need its
own page.

## The passkey level (`confirm` at level `passkey`)

The fake can play a gateway that verifies a `confirm` itself with a WebAuthn assertion. The rules
are the real gateway's: `contract/confirm-passkey/README.md` (the construction and the order of
the checks) and the fork's `hermes_cli/dashboard_auth/passkeys/` and `tui_gateway/confirm*.py` (the
wire shapes, codes and reasons). The vectors in `contract/confirm-passkey/vectors.json` all pass
byte for byte (`src/passkey/contract-vectors.test.ts`). Verification uses `node:crypto` only; no
runtime dependency was added.

### Turning it on

A gateway **knows** the level or it does not, like a build of the real one. Without it nothing here
changes: `client.capabilities` has no `confirm_passkey`, `/api/auth/passkeys` is not served and
`confirm` keeps the permissive behaviour it always had (any level, any answer).

| How                                                     | What it does                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `npm run fake-gateway -- --auth cookie --passkey`       | knows the level, enabled, base URL = its own address                                                                        |
| `--passkey-base-url <url>` (repeatable, implies it)     | list base URLs instead; the opt-in for private base URLs is then off unless `--passkey-allow-private`                       |
| `--passkey-rp <id=origin,origin>` (repeatable)          | native RPs and the `clientDataJSON.origin` values allowed for each. Default `confirm.hermie.dev=https://confirm.hermie.dev` |
| `--no-passkey-invites`                                  | a person cannot mint their own enrolment code                                                                               |
| `startFakeGateway({ passkey: true \| PasskeyOptions })` | the same in-process                                                                                                         |
| `POST /__fake/passkey/enable`                           | the same at run time, and how settings change afterwards                                                                    |

It needs `--auth cookie` or `--auth native`. With `none` or `token` nobody is signed in, so the
level answers `no_identity` (the capability reason, and `403 no_identity` from the routes).

The fake's own address is `http://127.0.0.1:<port>`, which the contract calls **private**
(README §10). Without an explicit base URL the operator's opt-in (`allow_private_base_urls`) is
therefore on; the native path works (native RPs are accepted with any accepted base URL), the browser
path does not (web RPs need an `https` base URL without a path). To test a browser, list one:
`--passkey-base-url https://gw.example.invalid` and send that `Origin` on cookie writes.

The gateway has one identity per run (`gateway_id`, `handle_key`), created with the store and gone
with the process. Credentials, codes, registrations and receipts are in memory.

### What it serves

The six routes of the real gateway, with its shapes, status codes and reasons, behind the gate:

| Route                                     | Notes                                                                                                               |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/passkeys`                  | `{v, enabled, reason, gateway_id, user: {id, handle}, rp, base_urls, user_invites, credentials}` of the caller only |
| `POST /api/auth/passkeys/register/begin`  | `{rp_id, base_url, name}`, lives 300 s, 5 per 10 minutes per user and per address                                   |
| `POST /api/auth/passkeys/register/finish` | attestation (`fmt` any, `none` expected) + a one-time enrolment code                                                |
| `POST /api/auth/passkeys/stepup/begin`    | `{purpose: "invite" \| "revoke", subject?}`, lives 120 s, single use                                                |
| `POST /api/auth/passkeys/invites`         | an `invite` step-up assertion mints a code bound to the caller (only with `user_invites`)                           |
| `POST /api/auth/passkeys/revoke`          | a `revoke` step-up assertion for that credential                                                                    |

Mirrored from the fork:

- Level off: `GET` answers 404 `{"detail": "No such API endpoint: <path>"}`, a `POST` 405 with
  `Allow: GET`. Nothing is public; the gate's 401 comes first.
- 403 `no_identity`, `origin_not_listed` (a cookie write needs an `Origin` that is the origin of one of
  the level's own base URLs; a bearer, as the native app sends, is exempt), `invites_disabled`,
  `stepup_invalid`, `code_invalid` (one answer for unknown, expired, used and wrong-user codes).
- 400 `bad_request` (with `reason`: `rp_not_accepted`, `base_url_not_accepted`, `rp_host_mismatch`,
  `not_enrolled`, `unknown_credential`), 410 `expired`, 409 `credential_exists`, 413 `body_too_large`
  (16 KiB cap), 422 `attestation_invalid` / `assertion_invalid` with the contract's `reason`, 429
  `rate_limited` with `Retry-After`.
- Failed enrolment codes: 5 per user and per address per 10 minutes, 20 per hour gateway-wide. A
  duplicate credential counts as a wrong code.
- `passkey.changed {change, credential: {id, name, rp_id}, at}` goes to every live connection signed
  in as that user (and to nobody else) on an enrolment and on a revoke through the routes, as an event
  with `session_id: ""`.

Not mirrored: the audit log (the public view below keeps `refusals` instead), the plugin hook
`on_passkey_change`, SQLite and file permissions, `503 unavailable` for a broken store (the store
cannot break), and the operator CLI itself (the control calls below stand in for it).

### `confirm`

On a gateway that knows the level `confirm` takes the real gateway's gated path
(`tui_gateway/confirm.py`, `confirm_passkey.py`, `server_requests.py`):

- **Handshake.** The first `client.capabilities` result always lists `confirm`, carries
  `confirm: []` and `confirm_passkey {v: 1, enabled, reason, gateway_id, rp: {native, web}}`
  (`reason`: `disabled`, `no_base_url`, `private_origin`, `no_identity`). The second call may carry
  `confirm: ["plain", "passkey"]` and `confirm_passkey {v: 1, kind, rp_id}`; `passkey` is accepted only
  for a signed-in connection with an RP accepted for that `kind`. The result's `confirm` lists the
  accepted levels, sorted.
- **Frame.** `{id, method: "confirm", params: {session_id, title, summary, detail?, level, passkey?}}`,
  with `params.passkey {v, nonce, gateway_id, base_url, expires_at, user: {id, name}, credentials:
[{rp_id, ids}]}` at level `passkey`. Text is cleaned and bounded as the gateway does (80 / 500 /
  2,000, control and format characters stripped). The frame goes only to connections that offered the
  level; at `passkey` also only to connections signed in as the bound user that advertised an RP the
  user has a credential for. The same predicate decides who may answer and who sees the request in
  `session.resume` / `session.events.since` `open_requests`.
- **Answers** go through `request.answer {id, result}` or a bare response frame. `request.answer`
  refuses with **4033** (not allowed to answer) and **4034** (`data.reason` at `passkey`; at `plain` the
  message only). A refused `passkey` answer leaves the request open; the **fifth** settles it
  `unavailable (verification_failed)`, withdraws it (`request.cancel too_many_attempts`) and the fifth
  answer's error says `too_many_attempts`. Only refusals from connections allowed to answer count.
  A bare response frame is counted the same way and gets no reply. A JSON-RPC error answer
  (`4040`) takes that connection out of the running; the last one settles `unavailable (error_response)`.
- **Per-level method sets.** `plain`: `decision` `confirmed` or `declined` with `method: "tap"`, so
  `method: "passkey"` is refused (`bad_shape`). `passkey`: a valid assertion, or exactly
  `{decision: "declined", method: "tap"}`.
- **Settle, then commit.** `request.answer` → `{status: "ok"}` means received and valid. `verified: true`
  exists only after the store commit: the credential re-read, the counter rule re-applied to the value
  stored now, a receipt written. A refused commit (revoked meanwhile, replay, counter regression) is
  `unavailable (verification_failed)` and the session gets `request.cancel {reason: "verification_failed"}`.
  A valid answer also sends `request.cancel {reason: "resolved"}` to every connection of the session.
- **Limits.** One open confirmation and at most 6 per 600 s per conversation (`already_pending`,
  `rate_limited`).
- **No downgrade.** After a `passkey` request ends in `declined`, `timeout`, `verification_failed`,
  `error_response`, a withdrawal (`cancelled:*`) or `no_capable_client`, `plain` requests in that
  conversation are `unavailable (downgrade_refused)` for 600 s. A request that is unavailable before a
  frame is sent opens nothing.

Reasons for a request that is unavailable before anything is sent: `disabled`, `no_base_url`,
`private_origin`, `no_identity`, `no_acting_user`, `not_enrolled`, `turn_isolation`,
`downgrade_refused`, `already_pending`, `rate_limited`, and `no_capable_client` (nobody could answer).

Not mirrored: `settings_unavailable` and `store_unavailable` (the settings and the store cannot fail),
the plugin hook `pre_confirm_request` and the audit lines.

### Control calls

Never part of the gateway contract; they play the operator and the clock.

| Call                                                                                                                            | What it does                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__fake/passkey/enable {enabled?, base_urls?, rps?, allow_private?, user_invites?}`                                       | know the level, or change the operator's settings. Answers the public view. 400 for a base URL or RP the gateway would refuse                                                                                                                                                           |
| `POST /__fake/passkey/code {user?, ttl?}`                                                                                       | an operator enrolment code (`hermes dashboard passkey invite`), optionally bound to a user; `ttl` 60 to 86400 s. Answers `{code, expires_at, user_id}`                                                                                                                                  |
| `POST /__fake/passkey/revoke {credential_id \| user + all, announce?}`                                                          | the operator's revoke, by id prefix or for a whole user. Silent (the real CLI is another process) unless `announce: true`                                                                                                                                                               |
| `POST /__fake/passkey/expire {request_id?, pending?, codes?, window?}`                                                          | time passing. With no flag every open `confirm` times out now (`request.cancel timeout`); `request_id` names one; `pending` ends open registrations and step-ups, `codes` the enrolment codes, `window` the no-downgrade window and the per-conversation limits                         |
| `POST /__fake/passkey/changed {user?, change?, credential?}`                                                                    | emit `passkey.changed` to a user's connections without a change behind it                                                                                                                                                                                                               |
| `POST /__fake/request {method: "confirm", params: {level, title?, summary, detail?}, user?, timeout_seconds?, turn_isolation?}` | raise a gated `confirm` on a profile's chat (`profile`, default `researcher`). Answers 200 `{raised, session_id, request_id, level}`, or 409 `{detail, outcome: "unavailable", reason}` when nothing was sent, 400 for text that cannot be carried. `summary` may also be called `text` |
| `GET /__fake/state`                                                                                                             | gains `passkey`, below                                                                                                                                                                                                                                                                  |

`user` names who the turn acts for: `<provider>:<user id>` (here `self-hosted:<account user id>`), an
account's user id, or its username. Absent it is the gateway's first account; `null` is a turn nobody
signed in submitted (`no_acting_user`, or `no_identity` while nobody is signed in).

`GET /__fake/state` → `passkey`, absent while the gateway does not know the level: the capability
fields (`enabled`, `reason`, `gateway_id`, `rp`), `base_urls`, `accepted_base_urls`,
`allow_private_base_urls`, `native_rps`, `user_invites`, `credentials` (public fields, active and revoked),
`open_codes`, `receipts` (digests and ids, never the text or a signature), `refusals` (surface, reason,
user, request id), `open` (requests waiting), `outcomes` (what the agent would learn: `{request_id,
level, user_id, credential_id, outcome, method, verified, reason}`) and `windows` (conversations whose
no-downgrade window is open). No key, code, nonce or confirmed text is in it.
`clientCapabilities` entries gain `confirm_passkey` when the client sent it.

The TypeScript handle has `gateway.passkey()` (the store and settings), `gateway.enablePasskey(options)`,
`gateway.raiseConfirm({summary, level, user, …})` (`{kind: "unavailable", reason}` or `{kind: "open",
id, done}` with `done` the outcome) and `gateway.requestServerSide("confirm", …)`.

### The soft authenticator

`src/testing/soft-authenticator.ts`, also `@hermie/fake-gateway/testing/soft-authenticator`, builds
what a platform authenticator and its client return for a registration and an assertion (ES256,
attestation `none`), under the contract's construction. A test double: the key is generated per
instance and lives in memory.

```ts
import { SoftAuthenticator } from '@hermie/fake-gateway/testing/soft-authenticator'

const phone = SoftAuthenticator.native() // RP confirm.hermie.dev, client origin https://confirm.hermie.dev, synced
const laptop = SoftAuthenticator.web('https://gw.example.invalid') // RP = host, device-bound

// Enrolment: register/begin gave `begin`, the operator gave `code`.
const body = phone.register(
  { registrationId, baseUrl, gatewayId, userId, name, nonce }, // from register/begin
  code
) // the register/finish body

// A confirm frame: the text it shows is the text in the frame, the base URL is the one it dialed.
const answer = phone.answer({ id: frame.id, params: frame.params }, { baseUrl, userHandle })
// -> {decision: "confirmed", method: "passkey", passkey: {...}}, send it through request.answer

// A step-up (`invite`, `revoke`): title "", summary the subject, detail "", session "".
const assertion = phone.assert({
  baseUrl,
  gatewayId,
  userId,
  requestId: stepupId,
  nonce,
  title: '',
  summary: 'invite',
  purpose: 'invite',
  userHandle
}).passkey
```

`register(input, code?, tamper?)` and `assert(input, tamper?)` / `answer(frame, options, tamper?)`
take a `Tampering` object for building what a verifier must refuse: `flags`, `signCount`,
`clientOrigin`, `clientType`, `rpIdHashOf`, `claimBaseUrl`, `coseFields`, `signWith`,
`omitUserHandle`. Also `id` / `credentialId`, `publicKey`, `rpId`, `signCount` (rises with every
device-bound assertion), `clone()` (the same passkey again), `DECLINE` and `cbor()`. The user handle is
what `GET /api/auth/passkeys` answers as `user.handle`; the gateway's `handle_key` is never needed.

### Tests

`src/passkey/`: `contract-vectors.test.ts` (the contract), `verifier.test.ts` (CBOR, verifier, store),
`routes.test.ts` (the six routes), `confirm.test.ts` (capability handshake, gating, refusals, limits,
window), `control.test.ts` (control calls, state, handle, CLI). `harness.ts` is the shared support:
a gateway that knows the level with two accounts, cookie and bearer sign-in, and connections with a
ticket.

### Not covered

The scenario dump for `contract/transcript/streams` (`scripts/dump-frames.ts`) has no `confirm-passkey`
scenario: the transcript engine's `applyServerRequest` knows `approval` and `clarify` only, so a
scripted `confirm` would record frames no engine step consumes. It needs engine support first.
