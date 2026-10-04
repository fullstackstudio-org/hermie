# Gateway MCP: the app's page and the `via` author

What a client needs to know about the gateway's MCP endpoint (HERM-247), and nothing
else. The gateway fork serves a remote MCP
endpoint that Claude Code (or any MCP client that does OAuth 2.1) connects to **as the signed-in
person**. Hermie never speaks MCP and runs no server. It does three things:

1. shows what the gateway says about its MCP endpoint, and the clients connected to it
   (`GET /api/auth/mcp`);
2. lets the person revoke a connected client (`POST /api/auth/mcp/grants/{id}/revoke`), and
   refreshes when something changes (`mcp.changed`);
3. draws a row an agent sent on the person's behalf as `<name> via <client>`, never as the
   person alone (`display_metadata.author.via`).

This file is written by hand. The shapes are additive: a reader ignores keys it does not know,
and every object here may grow. The fake gateway (`packages/fake-gateway`, `--mcp`) serves
exactly these shapes; the fork's `hermes_cli/dashboard_auth/mcp/api_routes.py` is the real thing.
The rest of the endpoint (OAuth, the tools) is not a client concern and is not described here.

Conventions. **Time** is a Unix timestamp in whole seconds (an integer). **Nullable** means the key
is always present and its value may be `null`; **optional** means the key may be absent. Strings
that came from somebody else (a client's name, an address, a user agent) are **untrusted**: draw
them as plain text, never as Markdown, HTML or a link, and never log them.

## 1. `author.via` on a row

The gateway stamps who wrote each message of a person's turn in `display_metadata.author`
(`per_message_author`). When the turn was sent by an **agent through MCP** on that person's behalf,
the author stays the **person** (`id`, `name`: whose turn it is, whose memory and limits apply) and
`via` says that an agent typed it:

```json
{
  "role": "user",
  "display_metadata": {
    "author": { "id": "authentik:7f3a…", "name": "Robin", "via": { "kind": "mcp", "client": "Claude Code" } },
    "turn_id": "…"
  }
}
```

A retry (`/retry`) pressed by an agent keeps the original author and marks the presser:

```json
"display_metadata": {
  "author": { "id": "authentik:7f3a…", "name": "Robin" },
  "replayed_by": { "id": "authentik:91bc…", "name": "Sam", "via": { "kind": "mcp", "client": "Claude Code" } }
}
```

`replayed_by` is present only when the presser is somebody other than the author, or an agent.

| Field                       | Type   | Nullable | Notes                                                                                                                   |
| --------------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------- |
| `author.id`                 | string | no       | `<provider>:<user id>`, exactly as before. Required for the author to exist at all                                      |
| `author.name`               | string | no       | Optional. The gateway's display name for the person. Untrusted                                                          |
| `author.via`                | object | no       | Optional. Present only for a row an agent sent for the person                                                           |
| `author.via.kind`           | string | no       | Non-empty. `"mcp"` today. A reader treats every kind the same way and does not branch on it                             |
| `author.via.client`         | string | no       | Non-empty, one line, at most 80 characters: the client's own name from its registration (`Claude Code`). Untrusted      |
| `replayed_by`               | object | no       | Optional. Same shape as `author`, with the same optional `via`                                                          |
| any other key               | any    | n/a      | Unknown keys are ignored, on `author`, on `via` and on `replayed_by`                                                    |

There is no grant id on a row: it is a registry key, not transcript content.

### How a reader reads it

- `via` is read from `author` and `replayed_by` by one rule: an object with a non-empty string
  `kind` and a string `client` that is not empty once cleaned. The cleaning is: format characters
  (Unicode `Cf`: bidi overrides, zero-width space) removed, other control characters and line or
  paragraph separators turned into a space, whitespace collapsed and trimmed, held to 80 code points.
- A `via` of any other shape is **absent**. The author keeps its `id` and `name`; the marker alone
  is lost. (The rest of `author` keeps the existing rule: no usable `id`, or a `name` that is not a
  string, and there is no author.) A `via` without an author is nothing.
- The engine (`@hermie/transcript`) puts it on the item: `UserItem.author.via` and
  `UserItem.replayedBy` (a `MessageAuthor`, with its own `via`).

### The label

A row whose author carries `via` is shown as **one label**: `<name> via <client>`, for example
`Robin via Claude Code`. It is the person's name, then the plain word `via`, then the agent's name.

- `authorLabel(author, name)` in `@hermie/transcript` makes it. `name` is whatever the caller
  would have shown for that author (its resolved, sanitised display name); with no `via` the label
  is `name` unchanged; with a blank `name` it is `via <client>`.
- The engine words it in English. A client that localises its own chrome may spell the join word in
  its own language around the same two parts; `name` and `client` are never translated.
- It is **plain text, never Markdown**: `via` is a word, not emphasis. Where a label goes into a
  Markdown file, the whole label is escaped as one piece of somebody else's text (the export does
  this: `**You via My\_\*Agent\***`).
- The marker is **not gated**. The engine hides a person's own name in a one-to-one chat and
  shows a colleague's only in the group chat, but a row carrying `via` is never drawn as the person
  typing: in an export it is `You via Claude Code` for the reader's own row, and a chat preview leads
  with `Robin via Claude Code` wherever it is shown (it still needs the caller's name resolver).
- The same label applies to `replayed_by`.

The golden files carry it: `contract/transcript/fixtures/rows.json` (`viaRow`, `viaReplayedRow`,
`viaMalformedRows`), `contract/transcript/golden/{author,preview}.json`, and
`contract/gateway/vectors/author-id.json` (`authorViaOf`, `authorStampOf`).

### The capability

`gateway.capabilities` gains `per_message_author_via: true` when the gateway may stamp `via`.
Additive; a reader tests by membership. It is advisory: a client reads `via` whether or not the
capability was advertised.

## 2. `GET /api/auth/mcp`

The page's data source. Behind the gateway's sign-in (cookie or bearer). Answers the caller's own
view only: the identity is the session's, never a parameter.

**200**, `Cache-Control: no-store`:

| Field            | Type   | Nullable | Notes                                                                                                                                                   |
| ---------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`              | int    | no       | `1`. Bumped only for a change a reader could not ignore                                                                                                 |
| `enabled`        | bool   | no       | Always `true` on a 200: a gateway with MCP off answers 404                                                                                              |
| `endpoint_url`   | string | no       | The URL an MCP client connects to, built from the gateway's primary public URL (`https://…/mcp`). The app never builds it itself                        |
| `issuer`         | string | no       | The OAuth issuer (today the same as `endpoint_url`). Shown, never used for a request                                                                    |
| `label`          | string | no       | The server name used in the command and the config: a slug of the operator's `dashboard.mcp.label` (`hermie-<host>` when that is empty)                |
| `claude_command` | string | no       | `claude mcp add --transport http <label> <endpoint_url>`, ready to copy. Show it and copy it as text, never run it                                      |
| `config_json`    | string | no       | The `.mcp.json` fragment as pretty-printed JSON **text** (`{"mcpServers": {"<label>": {"type": "http", "url": "<endpoint_url>"}}}`). Copy it verbatim  |
| `instructions`   | string | no       | English prose for the person, a few sentences. A client localises its own chrome, never this text                                                       |
| `grants`         | array  | no       | The caller's active grants (below), newest `created_at` first, ties by `id`. Empty when none                                                            |

A **grant** is one MCP client the person has allowed. Revoked and expired grants are not listed.

| Field                | Type     | Nullable | Notes                                                                                                                        |
| -------------------- | -------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string   | no       | Opaque, `[A-Za-z0-9_-]{1,64}`. The key for revoking                                                                          |
| `client_name`        | string   | no       | The name the client registered under (`Claude Code`). Untrusted. The same as `author.via.client` on rows it sends, up to the 80-character cleaning |
| `client_id`          | string   | no       | The client's OAuth id. Untrusted                                                                                             |
| `scopes`             | string[] | no       | OAuth scope strings, possibly empty. Shown verbatim if at all; a client does not interpret them                              |
| `created_at`         | int      | no       | When the person allowed it                                                                                                   |
| `created_ip`         | string   | **yes**  | The address of the client that exchanged the code for its first tokens (not the consenting browser's). `null` when the gateway did not record one. Untrusted |
| `created_user_agent` | string   | **yes**  | The user agent of the client that exchanged the code (not the consenting browser's). `null` when not recorded. Untrusted     |
| `last_used_at`       | int      | **yes**  | The last time the client used its token. `null` when it never has                                                            |
| `last_used_ip`       | string   | **yes**  | The address of that use. `null` when never used or not recorded. Untrusted                                                   |
| `expires_at`         | int      | no       | When the grant ends (90 days after consent) and the person must allow it again                                               |

The answer never carries the person, a token, a code or a client secret.

**Other answers.** Every error body is JSON.

| Status | Body                                                | When                                                                                                                    |
| ------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 401    | the gateway's sign-in answer                        | no session. Handled as for any other REST call                                                                          |
| 403    | `{"error": "no_identity", "detail": string}`        | signed in without a person (a session-token or ungated gateway). The page says to sign in                               |
| 404    | `{"detail": "No such API endpoint: /api/auth/mcp"}` | the gateway has no MCP endpoint, or it is switched off. The page says this gateway does not offer MCP, and shows nothing else |
| 405    | `{"detail": "Method Not Allowed"}`, `Allow`         | another method                                                                                                          |

## 3. `POST /api/auth/mcp/grants/{id}/revoke`

Ends one grant: every token of it stops working at once. It closes nothing else (the endpoint is
stateless).

- Body: a JSON object of at most 16 KiB; the app sends `{}`. Anything else is 400 or 413. A body
  never names a user.
- A request with a **cookie** must carry an `Origin` the gateway lists, else 403
  `origin_not_listed`. A **bearer** (the native app) needs none.
- **200** `{"ok": true}`, `Cache-Control: no-store`, for one of the caller's active grants.
- **404** `{"error": "not_found", "detail": "No such grant."}` for **every** other id: unknown,
  somebody else's, already revoked, expired, or not shaped like an id. One answer, so there is no
  way to ask whether somebody else's grant exists. A client treats a 404 as "it is gone": it
  refreshes the list rather than showing an error.
- 403 `no_identity`, 405, 404 (MCP off) as in section 2.

After a successful revoke the grant is no longer listed, and `mcp.changed` goes out.

## 4. `mcp.changed`

A WebSocket **event** frame to every live connection of the person (every tab, the app), so an
open Settings page refreshes without being asked. Like `passkey.changed`:

```json
{ "jsonrpc": "2.0", "method": "event",
  "params": { "type": "mcp.changed", "session_id": "",
              "payload": { "change": "revoked", "grant": { "id": "mcg_…", "client_name": "Claude Code" }, "at": 1790000000 } } }
```

| Field                  | Type   | Nullable | Notes                                                                                 |
| ---------------------- | ------ | -------- | ------------------------------------------------------------------------------------- |
| `type`                 | string | no       | `"mcp.changed"`                                                                       |
| `session_id`           | string | no       | Always `""`: it belongs to the person, not to a chat                                  |
| `payload.change`       | string | no       | `"granted"` (a client was allowed) or `"revoked"` (from the app, by the client itself, or by the gateway when a code or refresh token of it was used twice). A reader treats an unknown value as "something changed" |
| `payload.grant.id`     | string | no       | The grant's id                                                                        |
| `payload.grant.client_name` | string | no  | The client's name. Untrusted                                                          |
| `payload.at`           | int    | no       | When it happened                                                                      |

It is a **hint to reload**, not the state: a client re-reads `GET /api/auth/mcp`. It names the
client, so a toast may say "Claude Code was revoked", as text. A revoke done on the operator's side
(`hermes dashboard mcp revoke`, another process) may produce no frame at all, so the page also
reloads when it is opened and when the app returns to the foreground.

## 5. The fake gateway

`npm run fake-gateway -- --auth cookie --mcp [--mcp-label <name>]` (or `startFakeGateway({ mcp })`;
`--auth native` works too). Without `--mcp` the routes are unknown and `gateway.capabilities` does not
say `per_message_author_via`. With `mcp: { enabled: false }` it knows the feature and has it off (404 / 405).

| Call                                    | What it does                                                                                                                                                                                  |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /__fake/mcp/grants`                | every grant, revoked and expired ones too, with `user_id`, `revoked_at`, `revoked_by` (`user` / `operator` / `null`) added to the fields above                                                |
| `POST /__fake/mcp/grants {…}`           | seed a grant as a consent would. Body, all optional: `user` (username, user id or `<provider>:<id>`; default the first account), `client_name` (default `Claude Code`), `client_id`, `id`, `scopes` (default `["mcp"]`), `created_at`, `created_ip`, `created_user_agent`, `last_used_at`, `last_used_ip` (each of those four may be `null`), `expires_at` (default `created_at` + 90 days), `announce` (default true: emits `mcp.changed` `granted`). Answers `{grant, delivered}`; 409 without `--mcp` |
| `POST /__fake/inject {author, replayed_by}` | `author` and `replayed_by` take `{id, name?, via?: {kind, client}}`, staging a row an agent sent for a person                                                                             |

The fake keeps grants in memory and speaks no OAuth and no MCP. `packages/fake-gateway/README.md`
has the rest.

## 6. What a client does

- Show the page only for a gateway that answers 200; for a 404 say this gateway does not offer MCP.
- Every string from the gateway (`client_name`, `client_id`, addresses, user agent, `instructions`,
  `claude_command`, `config_json`) is displayed as literal text.
- Copy `claude_command` and `config_json` exactly as received; build neither from the endpoint.
- Ask for confirmation before revoking, send `{}`, treat 200 and 404 alike afterwards by reloading.
- Reload on `mcp.changed`, on opening the page and on returning to the foreground.
- Draw a row whose author carries `via` as `<name> via <client>` wherever the author's name would
  appear, and never as the person alone. Do not branch on `kind`.
