# @hermie/fake-gateway

An in-process stand-in for `hermes serve`, for tests and offline development. It speaks the status
endpoints, the authentication flows, WebSocket tickets and the JSON-RPC surface the clients call.
See [the fake gateway in CONTRIBUTING.md](../../CONTRIBUTING.md#the-fake-gateway) for the general
use, `npm run fake-gateway -- --help` for every flag and control endpoint, and `src/server.ts` for
the behaviour of each method. This file documents the staged identity provider, the passkey
level, the interactive requests and the MCP page, which are new enough to need their own page.

## The staged identity provider (`--idp staged`)

With `--auth native --idp staged` (in-process: `idp: 'staged'`) a native sign-in runs the chain a
real gateway runs, with an identity provider shaped like the FullStack Studio one behind it, all on
the fake's own address:

1. `GET /auth/native/authorize` keeps the client's challenge, redirect URI and state in a pending
   broker, puts only the broker id in the `hermes_session_pkce` cookie and 302s to the provider.
2. `GET /__idp/authorize` remembers where to go after signing in in an `idp_next` cookie, then sends
   the browser to the consent page if it already has an `idp_session`, else to `/__idp/login`.
3. `POST /__idp/login` (`tester` / `hunter2`, form-encoded) starts a challenge in an `idp_pending`
   cookie (path `/__idp`, 5 minutes) and 303s to `/__idp/verify`.
4. `POST /__idp/verify` with `code=246810` signs in and 303s to the `idp_next` page. The challenge is
   burned on the first try: after a wrong code, the next try is told the sign-in expired and
   `/__idp/verify` sends the browser back to the password form.
5. `GET /__idp/consent` issues the provider's code and 303s to `/auth/callback`, which checks the
   PKCE cookie and the state (`400 Missing PKCE state cookie` without it, as the gateway answers)
   and 302s to the client's loopback redirect with the gateway's own code.

Without `--idp staged` the authorize page approves in one step, as before. The native
`NativeOIDCRoundTripTests` and `src/staged-idp.test.ts` drive this chain.

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
| `--no-passkey-self-enrol`                               | a person cannot add a passkey by signing in again (`self_enrol.enabled` off); implies the level                             |
| `--passkey-cooling-off <seconds>`                       | a self-enrolled passkey is listed but unusable for that long (`self_enrol.cooling_off_s`); implies the level                |
| `--passkey-accept-missing-auth-time`                    | a re-sign-in without an `auth_time` counts as fresh, marked assumed (`self_enrol.accept_missing_auth_time`)                 |
| `--passkey-no-reauth`                                   | the sign-in provider cannot authenticate again, like Nous (`self_enrol.reason: provider_no_reauth`)                         |
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

The seven routes of the real gateway, with its shapes, status codes and reasons, behind the gate:

| Route                                     | Notes                                                                                                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/passkeys`                  | `{v, enabled, reason, gateway_id, user: {id, handle}, rp, base_urls, user_invites, self_enrol: {available, reason, cooling_off_s}, credentials}` of the caller only    |
| `POST /api/auth/passkeys/reauth/begin`    | `{}` opens a grant for self-enrolment (600 s, 5 per 10 minutes per user and per address): `{grant_id, expires_at, provider, login_path?}` (see "Self-enrolment" below) |
| `POST /api/auth/passkeys/register/begin`  | `{rp_id, base_url, name, grant_id?, use_secret?}`, lives 300 s, 5 per 10 minutes per user and per address; with a grant the answer gains `grant: {expires_at}`         |
| `POST /api/auth/passkeys/register/finish` | attestation (`fmt` any, `none` expected) + exactly one of a one-time enrolment code and a fresh `grant_id` (the app adds `use_secret`)                                 |
| `POST /api/auth/passkeys/stepup/begin`    | `{purpose: "invite" \| "revoke", subject?}`, lives 120 s, single use                                                                                                   |
| `POST /api/auth/passkeys/invites`         | an `invite` step-up assertion mints a code bound to the caller (only with `user_invites`)                                                                              |
| `POST /api/auth/passkeys/revoke`          | a `revoke` step-up assertion for that credential                                                                                                                       |

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
  duplicate credential counts as a wrong code, and so does a grant refused at `register/finish`.
- Self-enrolment: 403 `self_enrol_disabled`, `provider_no_reauth`, `insecure_binding` and
  `reauth_invalid` (`reason`: `unknown`, `not_fresh`, `spent`, `failed`; with `failed` also `failure`),
  400 `bad_request` for both or neither of `code` and `grant_id`.
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

| Call                                                                                                                                                | What it does                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /__fake/passkey/enable {enabled?, base_urls?, rps?, allow_private?, user_invites?, self_enrol?, provider_reauth?}`                            | know the level, or change the operator's settings. `self_enrol` is `{enabled?, accept_missing_auth_time?, cooling_off_s?}`; `provider_reauth: false` stages a provider that cannot authenticate again. Answers the public view. 400 for a base URL, RP or setting the gateway would refuse                                                 |
| `POST /__fake/passkey/code {user?, ttl?}`                                                                                                           | an operator enrolment code (`hermes dashboard passkey invite`), optionally bound to a user; `ttl` 60 to 86400 s. Answers `{code, expires_at, user_id}`                                                                                                                                                                                     |
| `POST /__fake/passkey/revoke {credential_id \| user + all, announce?}`                                                                              | the operator's revoke, by id prefix or for a whole user. Silent (the real CLI is another process) unless `announce: true`                                                                                                                                                                                                                  |
| `POST /__fake/passkey/expire {request_id?, pending?, codes?, grants?, window?}`                                                                     | time passing. With no flag every open `confirm` times out now (`request.cancel timeout`); `request_id` names one; `pending` ends open registrations and step-ups, `codes` the enrolment codes, `grants` the re-authentication grants, `window` the no-downgrade window and the limits                                                      |
| `POST /__fake/passkey/reauth {fail?, auth_time?, user?, provider?, sticky?}`                                                                        | what the next simulated re-authentication reports (see "Self-enrolment"). `{}` or `{clear: true}` goes back to a plain fresh sign-in                                                                                                                                                                                                       |
| `POST /__fake/passkey/changed {user?, change?, credential?}`                                                                                        | emit `passkey.changed` to a user's connections without a change behind it                                                                                                                                                                                                                                                                  |
| `POST /__fake/request {method: "confirm", params: {level, title?, summary, detail?, fields?, draft_id?}, user?, timeout_seconds?, turn_isolation?}` | raise a gated `confirm` on a profile's chat (`profile`, default `researcher`). Answers 200 `{raised, session_id, request_id, level}`, or 409 `{detail, outcome: "unavailable", reason}` when nothing was sent, 400 for text that cannot be carried. `summary` may also be called `text`. `fields` and `draft_id`: see "Structured confirm" |
| `GET /__fake/state`                                                                                                                                 | gains `passkey`, below                                                                                                                                                                                                                                                                                                                     |

`user` names who the turn acts for: `<provider>:<user id>` (here `self-hosted:<account user id>`), an
account's user id, or its username. Absent it is the gateway's first account; `null` is a turn nobody
signed in submitted (`no_acting_user`, or `no_identity` while nobody is signed in).

`GET /__fake/state` → `passkey`, absent while the gateway does not know the level: the capability
fields (`enabled`, `reason`, `gateway_id`, `rp`), `base_urls`, `accepted_base_urls`,
`allow_private_base_urls`, `native_rps`, `user_invites`, `self_enrol` (the operator's settings),
`provider_reauth`, `reauth_script` (what the next sign-in reports, or `null`), `grants` (every grant: id, user,
provider, client, state, failure, `auth_time`, `auth_time_assumed`, times, the credential it was spent on; never a
secret), `credentials` (public fields, active and revoked, with `usable_from`), `open_codes`, `receipts` (digests and ids, never the text or a signature), `refusals` (surface, reason,
user, request id), `open` (requests waiting), `outcomes` (what the agent would learn: `{request_id,
level, user_id, credential_id, outcome, method, verified, reason}`) and `windows` (conversations whose
no-downgrade window is open). No key, code, nonce or confirmed text is in it.
`clientCapabilities` entries gain `confirm_passkey` when the client sent it.

The TypeScript handle has `gateway.passkey()` (the store and settings), `gateway.enablePasskey(options)`,
`gateway.raiseConfirm({summary, level, user, fields?, draftId?, …})` (`{kind: "unavailable", reason}` or `{kind: "open",
id, done}` with `done` the outcome) and `gateway.requestServerSide("confirm", …)`.

### Structured confirm (`fields`, `draft_id`, version 2)

`contract/confirm-passkey` §4.1, §8 and §9, as the gateway's `confirm.py`, `confirm_passkey.py` and
`server_requests.py` have it. A `confirm` may carry `fields`: at most 8 one-line key facts
(`{kind: amount|text|recipient|domain|model|count|date, label, value, currency?, id?}`), shown apart from the
text. They are checked VERBATIM (`src/verbatim.ts`: the contract's §6.2 character rules): a control, bidi or
zero-width character, anything that renders as nothing, padding or a line break is refused (400, the sentence
the agent would get), never rewritten; only the spaces at either end go. A missing `id` becomes `field_<n>`.

- **Advertising.** `client.capabilities` results always carry `confirm_fields` (`false` until accepted). The
  second call's `confirm_fields: true` counts only when it is exactly `true`, with at least one accepted
  level; every call replaces the last one. `confirm_passkey.versions` is `[1, 2]`, and `confirm_passkey {v: 2,
kind, rp_id}` is accepted (any other `v` drops the level, as before).
- **Who is sent it.** A `confirm` with fields goes only to connections that advertised `confirm_fields: true`
  and, at level `passkey`, also `v: 2`. A version-1 client of the same person is never sent a version-2 frame,
  nor listed one by `session.resume`, and cannot answer it (4033). With nobody capable the control call is a 409
  `{outcome: "unavailable", reason: "no_capable_client"}` and nothing was sent. A connection that drops `v: 2` or
  the fields while the request is open can no longer answer it.
- **Version 2.** A passkey request with fields has `passkey.v: 2` and its challenge commits to
  `text_digest_v2` (`SHA-256` over the version-1 text and each field `S(id) ‖ S(kind) ‖ S(label) ‖ S(value) ‖
S(currency or "")`, in the frame's order). The answer's `passkey.v` must repeat the request's own version: a
  version-2 answer to a version-1 request, or the reverse, is `bad_shape`; a signature over the text without the
  fields, with the fields in another order or with another value is `challenge_mismatch`.
  `contract/confirm-passkey/vectors.json` (`text_digest_v2_vectors`, `assertion_vectors_v2`) runs through the
  same verifier (`src/passkey/contract-vectors.test.ts`).
- **`draft_id`.** An approved `review.draft` is kept by the gateway, in memory, under a `draft_id`
  (`drf-<12 hex>`) for its conversation (an hour, 20 per conversation; `src/review-register.ts`). A `confirm`
  with `draft_id` takes its detail from there, verbatim (indentation and blank lines kept), whatever detail the
  caller passed. An unknown, expired, too long (over 2,000 characters) or another conversation's id is a 400 and
  nothing is sent.
- **Without the passkey level** the permissive `confirm` of the fake takes the same `fields` and `draft_id`
  (checked the same way) and sends a request with fields only to connections that showed them.
- **`SoftAuthenticator.answer(frame, …)`** reads `params.fields` and signs version 2 (`v: 2`) for a frame that has
  them. Tampering: `v` (the `v` the answer repeats) and `signWithoutFields` (sign the version-1 text).

### Self-enrolment: adding a passkey by signing in again

Contract §7.2 and §8, and the fork's `passkeys/reauth.py` and `routes.py`. A signed-in person opens a grant
(`reauth/begin`), signs in again, and the grant that sign-in completes authorises one enrolment, with no code.
The fake plays the identity provider, so the sign-in is **simulated**; the rules that judge it are the
contract's (§7.2: the binding, the same person on the same provider, `auth_time >= created_at - 120`), and the
contract's `reauth_freshness_vectors` run through the same store.

- **Web** (`--auth cookie`): `reauth/begin` with a cookie sets `__Host-hermes_reauth=<secret>; Max-Age=600;
Path=/; Secure; HttpOnly; SameSite=Lax` and answers a `login_path` (`<prefix>/auth/login?provider=self-hosted&
reauth=<id>`, the prefix from `X-Forwarded-Prefix`). The page then navigates to it with `&next=<its path>`.
  `GET /auth/login?reauth=` needs that cookie (a 400 page and no redirect or cookie without it; a 429 page with
  `Retry-After` once the address has used up 200 refusals in 600 s, or one grant id 20, as in the contract;
  a check that finds its grant is not counted, and `native/authorize` is limited the same way), completes the grant, signs the browser in as the person the sign-in
  reported and answers 302 to `next` (a relative path only). It never shows a sign-in form: there is no
  identity provider. The cookie is the grant's binding until `register/finish`, which clears it; `/auth/logout`
  clears it too. `register/begin` and `register/finish` read it from the `Cookie` header, so a test that sends
  cookies by hand adds `__Host-hermes_reauth=<secret>` to the session cookie. A browser must be on https or a
  loopback host (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), by its `Origin`: otherwise 403
  `insecure_binding`.
- **Native** (`--auth native`): `reauth/begin` with a bearer answers no cookie and no `login_path`. The app
  opens `GET /auth/native/authorize?…&reauth=<id>` (the provider is optional: the grant names it), redeems the
  loopback code at `POST /auth/native/token` with its verifier and gets `{reauth: {grant_id, state: "fresh" |
"failed", reason?, expires_at, use_secret?}}`, **no tokens**; `use_secret` only when fresh, and
  `register/begin` / `register/finish` then need it in the body. `tokenExchanges` does not move.
- **What the sign-in reports** is scripted with `POST /__fake/passkey/reauth`: `fail` is one of
  `provider_mismatch`, `user_mismatch`, `auth_time_missing`, `auth_not_fresh` (it sets the facts that produce
  that failure; the store then judges them), `auth_time` (Unix seconds, `null` for none), `user` (a person the
  gateway knows: the browser is then signed in as them, as the real gateway does for a sign-in as somebody else)
  and `provider` override single facts, `sticky: true` keeps the script for every sign-in until `{}` clears it.
  Unscripted, the person who opened the grant signs in again, authenticated now. With `accept_missing_auth_time`
  a missing `auth_time` is fresh and marked assumed; an old one never is.
- **Cooling-off** (`self_enrol.cooling_off_s` > 0): the new credential is listed with `usable_from`, is in no
  `confirm` snapshot, cannot sign an `invite` or `revoke` step-up, and can be revoked by another credential.
- **Switches**: `self_enrol.enabled: false` refuses `reauth/begin` and any `register/begin|finish` that names a
  grant, also one opened before; `provider_reauth: false` refuses with `provider_no_reauth`.

Not mirrored: the identity provider's own pages and the password form behind `/auth/login`, the audit
lines (the public view's `refusals`, `grants` and `reauth_script` stand in), and a web caller and a bearer
caller on one gateway: the fake's gate is `cookie` or `native`, so a grant opened by one kind of client cannot be
presented by the other here (the store's rule for it is tested directly).

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

`src/passkey/`: `contract-vectors.test.ts` (the contract, the freshness table included), `verifier.test.ts`
(CBOR, verifier, store), `routes.test.ts` (the routes), `self-enrol.test.ts` (grants, the simulated sign-in
for web and native, enrolment with a grant, cooling-off, the contract's wire examples), `confirm.test.ts`
(capability handshake, gating, refusals, limits, window), `control.test.ts` (control calls, state, handle,
CLI). `harness.ts` is the shared support:
a gateway that knows the level with two accounts, cookie and bearer sign-in, and connections with a
ticket.

### Not covered

The scenario dump for `contract/transcript/streams` (`scripts/dump-frames.ts`) has no `confirm-passkey`
scenario: the transcript engine's `applyServerRequest` knows `approval` and `clarify` only, so a
scripted `confirm` would record frames no engine step consumes. It needs engine support first.

## Interactive requests (`input.form`, `input.file`, `review.draft`, `review.diff`)

The fake raises the four interactive server requests of [`contract/requests`](../../contract/requests/README.md)
and holds an answer to that contract. Every gateway has them; a client that never advertises them never
sees one, so nothing else changes. No dependency: `src/interactive.ts` checks answers against
`schema.json` with a page-long checker of the keywords that file uses, then applies the rules the schema
cannot say (`README.md` sections 3 to 7): required values, ranges and steps, ISO 4217 minor units,
datetimes with their zone and offset, choice membership and counts, where files may live and how big they
may be, what a draft may contain, that every hunk of a diff is decided and the decision agrees with them. The contract files are read from `contract/requests/` when first needed.
`src/interactive-gate.ts` is the request's life.

### The handshake

`client.capabilities` records and echoes `requests`: the methods it accepted, which are the ones that are
interactive methods, only together with `server_requests: true` (otherwise `[]`). The first call's
`server_requests` lists the four methods, as the contract has a client wait for. The result carries
`requests` only when the call did; `GET /__fake/state` → `clientCapabilities` records the accepted list
the same way. A later call replaces what the connection advertised before.

### Control calls

| Call                                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /__fake/request {method, params?, profile?}`      | raise an interactive request on a profile's chat (default `researcher`). `params` are laid over the contract's example for the method (the first frame of `examples.json`, with an `expires_at` 300 s ahead), so `{}` and a bare `{method}` both work; the params are NOT validated, so a frame the gateway would never send (the `invalid_frames`) can be raised on purpose. Answers `{id, raised, session_id, expires_at}`, or 409 `{error: "no_capable_client", outcome: "unavailable"}` when no connection advertised the method (nothing is sent). Any other method is raised as before. **`review.diff` from a diff**: `params.diff` (a unified diff of one file) and `params.path` (needed only when the diff has no `---`/`+++` lines) are read by the gateway's own parser (`src/diff-hunks.ts`, a port of `diff_hunks.py`), which numbers the hunks `h1`…, computes each hunk's `anchor` (`start`, `end`, `both`) and reads `kind`, `path` and `old_path` from the header; `title`, `summary`, `expires_at`… in `params` are laid over its defaults. A diff the gateway refuses (binary, two files, a mode change, an executable or link, a hunk without context, a hidden character, a `.git` path, over the bounds…) is a 400 `{error: "diff_refused", detail}` with the sentence the agent would get, and nothing is sent. Without `params.diff` the contract's example frame (`settings.py`, two hunks) is raised as for any method |
| `GET /__fake/request/<id>`                              | `{id, method, open, answer?, refusals, outcome?, error?, reason?}`. `answer` is what the gateway took: a draft with its trailing whitespace removed, `edited`, and the `draft_id` and `sha256` the review register keeps it under; a diff with each hunk's decision in the request's order and, for an approval, `approved_patch` (git's form, `git apply`-able, composed from the gateway's own copy of the approved hunks; a rejected hunk before an approved one moves the latter's new-side start back; a rejection has none); `refusals` the reason of every refused answer as the client was told it; `outcome` is `answered`, `timeout`, `withdrawn`, `too_many_attempts` or `unavailable` (the client answered with an error: `error` is its frame, `reason` its `data.reason`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `POST /__fake/request/<id>/expire`                      | the gateway stops waiting now (`request.cancel timeout`) instead of at `expires_at`. Answers the same view                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /__fake/files`                                     | `{files: [{path, name, mime, bytes, sha256}]}`: what `POST /api/files/upload-stream` received, in order. The SHA-256 is the one an `input.file` answer has to quote                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `GET /__fake/files/content?path=<path>`                 | The raw bytes the upload route received at that path (404 when nothing is there): what an upload check reads on an engine that hides the request body from interception (WebKit)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /__fake/state`                                     | gains `interactiveRequests`: the same view for every request raised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gateway.raiseInteractive({method, params?, profile?})` | the same raise for a test holding the gateway object: `{kind: "unavailable"}`, `{kind: "refused", error: "diff_refused", detail}` (a diff the gateway would not build) or `{kind: "raised", id, settled}`, where `settled` resolves with how it ended                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

### What it does

- **Who is sent it.** Only the connections that advertised the method. `session.resume` and
  `session.events.since` list an open request (`open_requests`) to those connections only. Any connection
  may answer with `request.answer {id, result}`.
- **A valid answer** on the request's own reply frame or as `request.answer` settles it: `request.answer`
  says `ok`, and an answer after that says `expired`.
- **`review.diff`.** The answer decides every hunk (`approved` or `rejected`); `hunk:<id>:unknown` (a key the
  request lacks, in the answer's order), `hunk:<id>:missing` (in the request's order) and `decision:inconsistent`
  (`approved` with nothing approved, `rejected` with a hunk approved) are refused after the shape; the request
  stays open. The gateway writes the patch from its own copy of the hunks, never from the answer.
- **A refused answer** is `request.answer` error `4034` `{reason}` (on a reply frame, a `4034` error
  frame to the same connection), the reason exactly as the contract gives it, including
  `field:<id>:<problem>`. The request stays open. The tenth refusal reports `too_many_attempts`, publishes
  `request.cancel {reason: "too_many_attempts"}` and settles the request.
- **An error response** (`4041 cannot_show`, ...) settles it as `unavailable`.
- **The clock.** At `expires_at` the fake publishes `request.cancel {reason: "timeout"}`; a request raised
  with an `expires_at` that has passed ends on the next tick. `POST /__fake/withdraw-requests` withdraws
  them with every other open request.

### Tests

`src/diff-hunks.test.ts` (the gateway's parser: real `git` diffs round-tripped through `git apply`, every
refusal, the bounds, tabs and layout limits, the no-newline marker, anchors), `src/review-diff.test.ts` (raised
from a diff over a WebSocket, the answer and the `approved_patch`), `src/passkey/confirm-fields.test.ts`
(structured confirm). `src/interactive.test.ts`: every example of `examples.json` through the validators (valid answers taken,
invalid ones refused with exactly their `reason`, every form field kind), the rules the schema cannot say,
and the request's life over a WebSocket (gate, validation, refusal cap, resume listing, cancel on expiry,
error response, upload listing). `src/client-capabilities.test.ts` covers the handshake. `scripts/dump-frames.ts`
records a stream scenario per method (`input-form`, `input-file`, `review-draft`, `review-diff`) into
`contract/transcript/streams/`; the native corpus test needs every server request in a stream to decode typed,
which `review.diff` does since the native diff sheet.

## The MCP page (`--mcp`)

The fake can play a gateway that serves the fork's MCP endpoint, as far as the app is concerned: the
page of Settings that shows the endpoint, the `claude mcp add` command, the JSON config and the
connected clients, with Revoke. It speaks no OAuth and no MCP; no client under test does. The shapes
are `contract/gateway/mcp.md`; this file says how to drive them.

| How                                                                     | What it does                                                                                              |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `npm run fake-gateway -- --auth cookie --mcp`                           | serves the two routes, advertises `per_message_author_via`; `--mcp-label <name>` renames the server       |
| `startFakeGateway({ mcp: true \| { enabled?, endpointUrl?, label? } })` | the same in-process. `enabled: false` knows the feature and has it off: 404 for the GET, 405 for the POST |
| `gateway.enableMcp(options)`                                            | the same at run time (`gateway.mcp()` is the store and settings, or `null`)                               |

Without `--mcp` nothing changes: `/api/auth/mcp` is unknown (404) and the capability is not there. It
needs `--auth cookie` or `native`; with `none` or `token` nobody is signed in and the routes answer
`403 no_identity`.

| Route or call                               | Behaviour                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/auth/mcp`                         | `{v, enabled, endpoint_url, issuer, label, claude_command, config_json, instructions, grants}`; the caller's own active grants, newest first. Endpoint defaults to `<own address>/mcp`                                                                     |
| `POST /api/auth/mcp/grants/{id}/revoke`     | `{ok: true}` for the caller's own active grant, `404 not_found` for any other id (one body). A cookie write needs an `Origin` of the fake's own (or `--public-host`); a bearer needs none. Body: a JSON object, at most 16 KiB. Emits `mcp.changed`        |
| `GET /__fake/mcp/grants`                    | every grant, revoked and expired ones too, with `user_id`, `revoked_at`, `revoked_by`                                                                                                                                                                      |
| `POST /__fake/mcp/grants {…}`               | seed a grant (`user`, `client_name`, `scopes`, `created_at`, `created_ip`, `created_user_agent`, `last_used_at`, `last_used_ip`, `expires_at`, `id`, `client_id`, `announce`); emits `mcp.changed` `granted` unless `announce: false`. 409 without `--mcp` |
| `POST /__fake/inject {author, replayed_by}` | `{id, name?, via?: {kind, client}}` stamps a row an agent sent for a person (`display_metadata.author.via`), and the retry presser (`replayed_by`), with or without `--mcp`                                                                                |

`mcp.changed {change: "granted" | "revoked", grant: {id, client_name}, at}` goes to every live
connection signed in as the grant's person and to nobody else, like `passkey.changed`.

Tests: `src/mcp/routes.test.ts` (the routes, the frame, the control calls, the capability and the
CLI) and `src/inject-author.test.ts` (the `via` stamp).
