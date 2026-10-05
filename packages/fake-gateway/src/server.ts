import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import { type AddressInfo } from 'node:net'
import { URL } from 'node:url'

import { WebSocket, WebSocketServer } from 'ws'

import {
  AnswerRefused,
  buildText,
  ConfirmGate,
  buildFields,
  ConfirmParamsError,
  draftDetail,
  type ConfirmHost,
  type RaiseResult
} from './passkey/confirm'
import {
  applySettings,
  type Identity,
  PasskeyGateway,
  type PasskeyOptions,
  SettingsError,
  userKey
} from './passkey/gateway'
import {
  EXPIRED_TEXT as REAUTH_EXPIRED_TEXT,
  PROVIDER as REAUTH_PROVIDER,
  REAUTH_COOKIE,
  complete as completeReauth,
  grantForLogin as reauthGrantForLogin,
  nativeGrantForLogin as reauthNativeGrantForLogin,
  outcomeBody as reauthOutcomeBody,
  beginAttempt as reauthBeginAttempt,
  type SignInScript
} from './passkey/reauth'
import { clearedReauthCookie, cookieValue, handlePasskeyRoute, PREFIX as PASSKEY_PREFIX } from './passkey/routes'
import { GRANT_FAILURES, type GrantFailure } from './passkey/store'
import { InteractiveGate, type RaisedInteractive } from './interactive-gate'
import {
  calendarItemOf,
  CalendarItemRefused,
  defaultParams,
  INTERACTIVE_METHODS,
  isInteractiveMethod,
  type InteractiveMethod
} from './interactive'
import { scheduleRefusal } from './cron-schedule'
import { type AttachedImageSource, readAttachedImage } from './attached-images'
import {
  answerOutbox,
  type OutboxFile,
  type OutboxRequest,
  sampleOf,
  type ScenarioAttachment,
  storeFile,
  type WireAttachment,
  wireOf
} from './outbox'
import { DiffError, headOldPath, headPath, parseDiff } from './diff-hunks'
import {
  anthropicAccountLines,
  daysRefusal,
  defaultAccountProviders,
  emptyUsageStage,
  insights as insightsAnswer,
  nousBars,
  usageAnalytics,
  usageDaysOf,
  type AccountUsageProvider,
  type UsageDay,
  type UsageStage
} from './usage'
import {
  APPROVAL_GRANTS_METHODS,
  APPROVAL_MODES,
  approvalCall,
  ApprovalGrantsError,
  approvalView,
  emptyApprovalGrantsStage,
  stagedGrant,
  type ApprovalGrantsStage
} from './approval-grants'
import {
  emptyVaultStage,
  MANAGER as VAULT_MANAGER,
  VAULT_METHODS,
  vaultCall,
  VaultError,
  vaultView,
  type VaultStage
} from './vault'
import { ReviewRegister } from './review-register'
import { grantView as mcpGrantView, handleMcpRoute, PREFIX as MCP_PREFIX } from './mcp/routes'
import { McpGateway, type McpGrantInput, type McpOptions } from './mcp/store'
import {
  type AudioRequest,
  elevenLabsVoicesBody,
  DEFAULT_ELEVENLABS_VOICES,
  type FakeAudioOptions,
  MP3_SAMPLE,
  pcmClip,
  previewVoiceId,
  speakBody,
  STREAM_CHUNK_FRAMES,
  STREAM_CHUNKS,
  STREAM_SAMPLE_RATE,
  voiceConfigBody
} from './audio'

import { b64u } from './passkey/encoding'
import { LOGIN_PAGE, loginUrlFor, PLUGIN_ASSET_CACHE_CONTROL, readPluginAsset, tokenIndexHtml } from './plugin-assets'

export type { Identity, PasskeyOptions } from './passkey/gateway'
export type { ConfirmOutcome, RaiseResult } from './passkey/confirm'
export type { InteractiveOutcome, InteractiveView, RaisedInteractive } from './interactive-gate'

/**
 * What `raiseInteractive` answers: raised, no session for the profile, or params the gateway refuses to build: a
 * `review.diff` whose diff it will not read (`diff_refused`) or a `device.calendar` whose item it will not take
 * (`item_refused`).
 */
export type RaiseInteractiveResult =
  | RaisedInteractive
  | { kind: 'no_session'; profile: string }
  | { kind: 'refused'; error: 'diff_refused' | 'item_refused'; detail: string }
export type { McpOptions } from './mcp/store'
export type { AudioRequest, FakeAudioOptions } from './audio'

/**
 * A stand-in for `hermes serve` that speaks enough of the gateway contract to
 * drive the real client: the public status endpoints, both auth flows, the
 * native PKCE round trip, single-use WebSocket tickets, and the JSON-RPC
 * surface Hermie calls.
 *
 * Shapes follow `apps/shared/src/gateway-contract.generated.ts`. Behaviour that
 * only exists for tests (forcing a close code, dropping a socket without a
 * close frame) is on the handle, never on the wire.
 */

/**
 * How the fake gateway authenticates.
 *
 * `cookie` is the browser flow: a sign-in page, a session cookie, and REST plus
 * the ticket mint gated on that cookie rather than on a bearer. It exists so
 * the browser client can be driven end to end without a real `hermes serve` —
 * and, with `publicHost`, so the Host/Origin guard a page has to satisfy is
 * actually enforced rather than assumed.
 */
export type FakeAuthMode = 'none' | 'token' | 'native' | 'cookie'

/** The same row with every field settled, which is what the handlers read. */
interface ResolvedAccount {
  username: string
  password: string
  userId: string
  email: string
  displayName: string
  roles: string[]
  picture: string | undefined
}

/** One sign-in the fake accepts, and the identity it answers with afterwards. */
export interface FakeAccount {
  username: string
  password: string
  /** `/api/auth/me`'s `user_id`. Defaults to `<username>@example.invalid`. */
  userId?: string
  email?: string
  displayName?: string
  /** `/api/auth/me`'s `roles`, which upstream sends on some deployments. */
  roles?: string[]
  /**
   * This person's profile picture as the gateway holds it: a `data:image/…;base64,…` URL or bare
   * base64 of the image. `/api/auth/me` then answers `picture_url`, and `/api/auth/picture` serves
   * it under `self-hosted:<user_id>`. Absent: no `picture_url`, and a 404 for that id.
   */
  picture?: string
}

export interface ScenarioReply {
  /** Substring of the prompt this reply answers; omitted means "anything". */
  match?: string
  deltas?: string[]
  text?: string
  /**
   * Chunks of the model's reasoning, streamed BEFORE the first `message.delta`.
   *
   * The real gateway sends these from `agent_callbacks._agent_cbs` while the model
   * is still thinking, which means the client's assistant item comes into existence
   * — and therefore the transcript's typing header comes and goes — before a single
   * word of the reply exists. Nothing here emitted them, so the one transcript bug
   * that depends on that ordering could not be reproduced against this server at
   * all. See the 2026-09-20 section of docs/platform-notes.md.
   */
  reasoning?: string[]
  /**
   * One `reasoning.available` frame, which REPLACES the accumulated reasoning
   * rather than appending to it. `tool_progress._progress_reasoning` sends it, and
   * the client's reducer treats the two differently, so a fake that only ever sent
   * deltas left half of that branch unexercised.
   */
  reasoningAvailable?: string
  /**
   * Announce the tool by name before its call id exists (`tool.generating`).
   *
   * The real gateway does this whenever a tool is being drafted; the reason it is a
   * flag rather than automatic is that the in-process tests pass their own scenarios
   * and several of them count frames. The default scenario turns it on, so
   * `npm run fake-gateway` exercises it.
   */
  toolGenerating?: boolean
  /**
   * `id` is the provider's own id for the call (`tool_call_id` on the stored row,
   * `tool_id` on the frames). Absent, every call gets a fresh one. A real
   * provider counts from `call_0` again in every turn, so a scenario that sets it
   * is the only way to reproduce the ids a chat actually holds: the same id on two
   * different calls, which only the call's identity (`call_row_id` +
   * `call_index`) tells apart.
   */
  tool?: { id?: string; name: string; args?: Record<string, unknown>; summary?: string; result?: unknown }
  /**
   * How many deltas go out BEFORE the tool call, so the tool lands mid-reply.
   *
   * Absent puts the whole tool block after the last delta, which is the shape
   * every existing scenario expects. With a number, the reply is cut in two and
   * the tool goes in the cut — which is the only way to produce the turn the
   * client's `sealAssistantForTool` exists for: the half-streamed bubble is
   * sealed as an INTERIM note, a tool row lands under it, and the deltas that
   * follow open a second bubble that `message.complete` then settles. Three item
   * kinds arriving in one turn, in the order a real agent produces them.
   */
  toolAfterDeltas?: number
  /**
   * Mid-turn notes, each followed by the call it announces: what a turn with
   * `display.interim_assistant_messages` on (upstream's default) sends before
   * its answer.
   *
   * The order is the fork's, from `agent/turn_tool_round.py`: the note streams
   * as `message.delta`, the assistant row is PERSISTED, and only then does
   * `message.interim {text, already_streamed}` go out ("emit interim commentary
   * after the DB append"). The call follows, and its tool row lands in the
   * history after the tool ran.
   *
   * So a client can see a note's row before the frame that announces it, and see
   * the frames again (`session.events.since`) after a reload has already brought
   * the rows: the two orders the transcript has to settle into one bubble per
   * note.
   *
   * With `rowIdentity` on, every frame names the row it became (`message.interim`
   * `row_id`, the call as `call_row_id` + `call_index`, the tool result row as
   * `tool.complete.row_id`); with it off the rows are still written, the frames
   * carry no identity and there is no `message.interim`, which is the gateway
   * before the identity existed.
   */
  notes?: { text: string; tool: NonNullable<ScenarioReply['tool']> }[]
  /**
   * Files the bot shares with this reply (`contract/outbox/`): a sample (`{ sample: 'image' }`, see
   * `outbox-samples.ts`) or a name with its bytes. They are kept under a fresh token for the session's profile,
   * sent as `attachments` on `message.complete`, written on the reply's row (`session.history`, `session.resume`
   * and the REST transcript show them there) and served by `GET /api/files/outbox/{id}/{name}`.
   */
  attachments?: ScenarioAttachment[]
}

export interface Scenario {
  replies?: ScenarioReply[]
}

export interface FakeGatewayOptions {
  port?: number
  host?: string
  auth?: FakeAuthMode
  token?: string
  /** Close code used when a WebSocket upgrade fails auth (default 4401). */
  closeCode?: number
  /**
   * The host this gateway believes it is served on (`dashboard.public_url`).
   *
   * When set, the DNS-rebinding guard upstream runs is enforced here too: a
   * request whose `Host`, or whose `Origin`, names a different host is refused.
   * That is the guard a browser page served by the gateway satisfies by being
   * same-origin, so a test that does not turn it on proves nothing about the
   * client's own origin handling.
   */
  publicHost?: string
  /** User name and password accepted by `/auth/password-login` in cookie mode. */
  password?: { username: string; password: string }
  /**
   * Several accounts, for a test about two people on one gateway.
   *
   * `password` is one account and stays the default; this replaces it with a
   * list, and each one signs in to a session of its own. `/api/auth/me` then
   * answers the CALLER's identity rather than a fixed one, which is what
   * upstream does and what the fake could get away with not doing for as long
   * as nothing in this repository had two readers.
   */
  accounts?: FakeAccount[]
  /**
   * Pictures `GET /api/auth/picture?id=<provider>:<sub>` serves, by that id: a `data:image/…;base64,…`
   * URL or bare base64. For the people who only appear as the author of a message
   * (`/__fake/inject`'s `author`); an account's own picture is `FakeAccount.picture`. Every other id
   * answers 404, which is what the gateway says for a person it holds no picture of.
   */
  pictures?: Record<string, string>
  scenario?: Scenario
  /**
   * Whether this gateway carries the transcript row identity of the fork
   * (the transcript row identity plan). Default true.
   *
   * On: every turn-stream frame carries `turn_id` on its envelope and the user
   * row `display_metadata.turn_id`; `message.interim`, `message.complete` and
   * `tool.complete` name their persisted row; `tool.start` / `tool.complete`
   * name their call (`call_row_id` + `call_index`) and history tool rows carry
   * the same; `session.resume` says which streamed text no sealed note shows
   * (`inflight.assistant_unsealed`); `gateway.capabilities` advertises
   * `transcript_row_identity`.
   *
   * Off: none of it, and no `message.interim`. That is a gateway that predates
   * the identity (Alsycon, an older fork), the one a client must still read as
   * it did before.
   */
  rowIdentity?: boolean
  /**
   * Whether `gateway.capabilities` advertises `per_message_author`: the fork stamps who wrote each
   * message, so a client may draw a turn by somebody else as theirs. Default false, which is a
   * gateway that stamps nobody (and every turn is the reader's own).
   */
  perMessageAuthor?: boolean
  /**
   * The text-to-speech routes under `/api/audio/` (`voice-config`, `elevenlabs/voices`, `speak` and the
   * `speak-stream` socket), as the fork serves them (see `audio.ts`). On by default with the provider
   * `edge`; `false` is a gateway that has none of the routes (an older fork: they answer 404).
   */
  audio?: FakeAudioOptions | false
  version?: string
  /** How many events per session the replay ring keeps. */
  replayRingSize?: number
  /** Delay between streamed frames, in ms. */
  streamDelayMs?: number
  /**
   * How long `POST /api/files/upload-stream` holds its answer after the body
   * arrived, in ms (default 0). Lets a black-box test cancel an upload that is
   * still in flight; a real gateway is slow here for the size of the file.
   */
  uploadDelayMs?: number
  /**
   * Whether the interactive requests are limited as the gateway limits them (default false): one open per
   * conversation, twelve per ten minutes and six `device.*` per ten minutes (`already_pending`, `rate_limited`).
   * Off, a test raises as many as it likes at once (the gateway never would); `true` is the gateway's behaviour, and
   * `POST /__fake/request-limits {enabled, reset}` changes it while running.
   */
  interactiveLimits?: boolean
  /**
   * Extra history to put in front of every Bot Chat, in ROWS.
   *
   * The scroll of a long transcript could not be measured against this server:
   * the fixtures are a dozen rows each, and the only way to make four hundred
   * was two hundred send-and-reply round trips through the live socket, which
   * measures the socket. This is the history a real gateway would already have
   * had — written straight into the session, ahead of the fixture, so the
   * fixture's own shapes stay where the tests that read them expect.
   *
   * The rows are deliberately MIXED. A transcript of four hundred identical
   * one-line bubbles measures a list of identical one-line bubbles: what makes
   * scrolling expensive is rows of different heights, a markdown lexer running
   * on some of them and not others, and a tool card that measures itself. So
   * the cycle is prose, a longer paragraph, a fenced code block and a tool call,
   * in the proportion an actual session has them.
   *
   * Zero, absent, or a Bot Chat created at runtime: nothing is added.
   */
  historyRows?: number
  /**
   * Delay between two frames of a delegation, in ms.
   *
   * Deliberately its own knob and deliberately slow by default: the agents bar,
   * the sheet's stream lines and Steer/Stop only exist while children are
   * RUNNING, and a fan-out that finishes inside one frame cannot be looked at,
   * let alone steered. A test that only cares about the end state passes 1.
   */
  subagentStepMs?: number
  /**
   * Devices registered for push, seeded into `hermie-app.push` on the DEFAULT
   * profile ([ADR-0017](../../../docs/adr/0017-push-through-hermie-web.md)).
   *
   * A fixture rather than a fixed shape: what the push daemon reads is a bag of
   * JSON off a wire, and half of what it has to get right is refusing a bag it
   * cannot address. A test that could only produce well-formed registrations
   * could not check any of that.
   */
  pushRegistrations?: Record<string, unknown>
  /** `push.seen`: the heartbeat a device writes while a chat is on screen. */
  pushSeen?: Record<string, number>
  /**
   * The gateway-side plugin's advert, under its own `hermie-plugin` key.
   *
   * Present by default, because a gateway WITH the plugin is the case the app
   * is built for and a fixture that omits it by default would let the "get the
   * plugin" screen become the one every test exercises. `false` omits the key
   * entirely, which is the state the app must read as "not installed" — a
   * plugin too old to write the key, a plugin that is disabled, and no plugin
   * at all are the same thing from the outside, and that is exactly the shape
   * worth being able to stage.
   *
   * An object replaces the default, so a test can stage a `v` from the future,
   * a build with fewer capabilities, or a module switched off.
   */
  plugin?: Record<string, unknown> | false
  /**
   * What the plugin's display-name route does.
   *
   * `PATCH /api/plugins/hermie/profiles/{name}` is the plugin's answer to a
   * display name a client can actually write — core's own route renames the
   * profile instead — and the app has to cope with three gateways rather than
   * one, so all three are stageable:
   *
   *  - `on` (the default): the capability is advertised and the route writes.
   *  - `forbidden`: advertised, and the route answers 403. A gateway whose
   *    signed-in user may read profiles and not edit them.
   *  - `absent`: NOT advertised, and the route answers 404. A plugin older than
   *    the route, which is the state every gateway is in until it is updated.
   *
   * It is one option with three values rather than two booleans because the
   * three answers are what the app branches on, and a combination like
   * "unadvertised but writable" is not a gateway anybody has.
   */
  profileDisplayName?: 'on' | 'forbidden' | 'absent'
  /**
   * Whether the plugin's turn-claim route is there.
   *
   * `POST /api/plugins/hermie/context/turn` is the courtesy call the app makes
   * right before `prompt.submit` starts a turn, naming which bot is about to
   * speak on a gateway a plugin watches from the outside. Default true — the
   * capability is advertised and the route claims a live runtime session.
   * `false` drops the capability from the advert AND answers 404, staging a
   * plugin that predates the route, the same shape `profileDisplayName:
   * 'absent'` stages for the display-name route.
   */
  turnClaim?: boolean
  /**
   * Whether the plugin lets memory be changed (`memory.edit`).
   *
   * Default true. `false` drops the capability from whichever advert is in play, and the plugin's
   * `edit` route then answers 403 with its own sentence: a gateway where memory can be read and
   * not written, the state the Memory page has to draw without any control that could only fail.
   */
  memoryEdit?: boolean
  /**
   * Whether connectors are available (`manage_connections`, the connector service). Default true.
   * `false` is a gateway or bot with them off: `connectors.list` answers `available: false` as a
   * success and `connectors.connect` refuses with 4031.
   */
  connectors?: boolean
  /**
   * Whether the Kanban plugin is mounted. Default true. `false` is a gateway without it: every route
   * under `/api/plugins/kanban` answers 404, and the Boards page says so.
   */
  kanban?: boolean
  /**
   * Whether the plugin advertises `push.relay`.
   *
   * Default true: the plugin can deliver to a `transport: "relay"` row. `false`
   * drops the capability from whichever advert is in play, staging a notifier
   * that predates the relay — the gateway a native Apple build must leave its
   * Expo row alone on. The rows themselves are stored either way: `ui_meta`
   * holds whatever a client writes, and the fake's `/__fake/push` reads them
   * back unvalidated.
   */
  pushRelay?: boolean
  /**
   * Answer every request with a 301 to this origin instead of serving it.
   *
   * Staged because of a cache, not because a gateway does this. The iOS URL
   * cache keeps a 301 keyed by bundle id and it outlives the app, so a gateway
   * that moved domains once left a redirect behind that a fresh install's first
   * probe was answered out of — reaching a host the owner had left. The only
   * way to exercise the client's refusal to follow one silently is to have
   * something issue one.
   */
  redirectTo?: string
  /**
   * Whether the gateway has `POST /auth/native/revoke`.
   *
   * Default true, as a gated gateway of our fork answers: `native_revoke` in
   * `auth_flows` and a public route that ends a native grant. `false` stages a
   * gateway that predates the route: not advertised, and a POST there falls
   * through to the auth gate like any path this gateway does not serve. That is
   * the gateway a sign-out must leave alone.
   */
  nativeRevoke?: boolean
  /**
   * Who signs a native (RFC 8252) sign-in in.
   *
   * `single`, the default: the fake is its own identity provider, and its
   * authorize page approves in one step (`auto=1`), which is all most tests need.
   *
   * `staged`: the chain a real gateway runs, with an identity provider shaped
   * like the FullStack Studio one behind it, all on this one server. Authorize
   * keeps a pending broker in the gateway's own PKCE cookie and 302s to
   * `/__idp/authorize`; that remembers where to go after signing in in a cookie
   * of its own and sends the browser to a password form, then to a one-time-code
   * form (`stagedTotpCode`). A wrong code is burned, like the real provider burns
   * its challenge, so a second try is sent back to the password form. Only then
   * does the provider redirect to the gateway's `/auth/callback`, which checks
   * the PKCE cookie and the state and 302s to the client's loopback redirect.
   * A browser that drops a cookie anywhere along the way ends where the real
   * one ends: at the password form again, or at a 400 from the callback.
   */
  idp?: 'single' | 'staged'
  /** The one-time code the staged provider accepts. Default `246810`. */
  stagedTotpCode?: string
  /**
   * A directory served as the plugin's dashboard files, at
   * `GET /dashboard-plugins/hermie/<path>`.
   *
   * It stages the dashboard's static route for a plugin
   * (`hermes_cli/web_routers/dashboard_ui.py::serve_plugin_asset`), so a built
   * web client can be served the way a real gateway serves it: `<dir>/app/index.html`
   * is the client. The route's semantics are copied, not improved: a suffix
   * allow-list, 404 for a directory or a missing file, 403 for a traversal, and
   * `Cache-Control: no-store` on every answer. Files are read on every request, so
   * a test can replace one between two loads.
   *
   * Absent: the plugin has no dashboard directory here and every
   * `/dashboard-plugins/...` request answers 404.
   */
  pluginAssets?: string
  /**
   * Where each profile's home is on this machine, for `GET /api/files/images/{name}?profile=<profile>`: a
   * profile name to a directory whose `images/` folder holds the pictures that profile's chats attached.
   *
   * It stages `<profile home>` of the real gateway (`hermes_cli/web_routers/files.py::get_attached_image`),
   * with the route's own rules (`attached-images.ts`): one path component with an image suffix, a regular
   * file directly in `images/`, no link, at most 25 MB, a 404 for everything else. A profile with no entry
   * has no images; `default` is the profile a request without `profile` is for. The paths a transcript names
   * (`/root/.hermes/images/…`) never have to exist: the bytes come from here.
   *
   * Absent: every request answers 404.
   */
  profileHomes?: Record<string, string>
  /**
   * Whether the plugin advertises the web client: `web.client`, the `web`
   * block and `modules.web`.
   *
   * Default true. `false` stages a plugin older than the bundled client, from
   * whichever advert is in play: the three are withdrawn together, which is what
   * the real plugin does when its bundle fails its integrity check. It does not
   * touch the static route, because the real route serves the files either way.
   */
  webClient?: boolean
  /**
   * Whether the plugin publishes its Web Push key: `webPush` and
   * `push.webpush.key`.
   *
   * Default true. `false` stages a plugin that still holds the key to itself,
   * which is what every plugin was until it learned to publish it.
   */
  webPushKey?: boolean
  /**
   * Whether an accepted `session.steer` writes a `display_kind: "steer"` row.
   *
   * Default true, because that is the harder case for a client: it has its own
   * optimistic bubble up and must pair the row with it rather than draw the
   * correction twice. False stages the gateway that keeps no trace of a steer,
   * where the client's bubble is the only record there will ever be.
   */
  steerPersistsRow?: boolean
  /**
   * Whether this gateway knows the confirm level `passkey`, and how it is set up.
   *
   * Absent or `false`: it does not, as a gateway older than the level. `client.capabilities` carries no
   * `confirm_passkey`, the `/api/auth/passkeys` routes are not served, and `confirm` keeps the permissive
   * behaviour this fake always had (any level, any answer).
   *
   * `true` or an object: it does, with the real gateway's rules for `confirm` (gated levels, per-level
   * method sets, 4033 / 4034, five refusals, no downgrade) and the seven passkey routes. Needs a gated
   * `auth` (`cookie` or `native`): in `none` and `token` mode nobody is signed in, and the level answers
   * `no_identity`. The base URL defaults to the gateway's own address, which is private, so the operator's
   * opt-in is on unless `baseUrls` is given. `POST /__fake/passkey/enable` does the same at run time.
   */
  passkey?: boolean | PasskeyOptions
  /**
   * Whether this gateway serves the MCP page of the app's Settings: `GET /api/auth/mcp` and
   * `POST /api/auth/mcp/grants/{id}/revoke`, with `mcp.changed` after a revoke. See
   * `contract/gateway/mcp.md`.
   *
   * Absent or `false`: it does not, as a gateway without the fork's MCP endpoint (the routes are
   * unknown, `gateway.capabilities` does not say `per_message_author_via`). `true` or an object: it
   * does. The routes need a gated `auth` (`cookie` or `native`); with `none` and `token` nobody is
   * signed in and they answer 403 `no_identity`. `GET|POST /__fake/mcp/grants` lists and seeds the
   * grants a page would show. Nothing here speaks MCP or OAuth: no client under test does.
   */
  mcp?: boolean | McpOptions
  /**
   * Whether `gateway.capabilities` advertises `per_message_author_via`: the gateway may stamp
   * `author.via` (an agent sent the row for the person). Default: on exactly when `mcp` is.
   */
  perMessageAuthorVia?: boolean
}

export interface FakeSession {
  id: string
  storedId: string
  profile: string
  title: string
  messages: TranscriptRow[]
  seq: number
  ring: RingEntry[]
  /**
   * Out of the default listing, still resumable by its owner.
   *
   * It is not decoration: upstream's canonical-title guard
   * (`hermes_state_titles.py::_set_session_title`) tests exactly this flag when
   * it decides whether a session called `Bot Chat` may be renamed, so a fake
   * with no notion of hidden cannot reproduce either side of that rule.
   */
  hidden: boolean
  /** `session.create`'s `parent_session_id`: what this conversation succeeds. */
  parentSessionId?: string
  /**
   * `session.close` has popped the runtime session.
   *
   * The stored row lives on and resumes — with a NEW runtime id, because the
   * gateway builds a fresh one — but the old runtime id is gone, and every
   * session-scoped RPC addressed to it answers 4001.
   */
  closed?: boolean
}

export interface TranscriptRow {
  role: string
  text?: string
  row_id?: number
  timestamp?: number
  display_kind?: string | null
  display_metadata?: Record<string, unknown> | null
  /** The files an assistant row shared (`contract/outbox/`), beside its text. */
  attachments?: WireAttachment[]
  name?: string | null
  tool_id?: string | null
  /** What `session_history.py` names a tool row's call by: the id `tool.start` sent as `tool_id`. */
  tool_call_id?: string | null
  /** The assistant row holding this tool row's call, and the call's position in its `tool_calls`. */
  call_row_id?: number | null
  call_index?: number | null
  context?: string | null
  args?: Record<string, unknown> | null
  reasoning?: string | null
}

/**
 * One row as the REST transcript route answers it, rather than as the socket does.
 *
 * `sessions.py` reads `dict(messages_row)`, so the body is **`content`**, with
 * `display_content` and `display_kind` beside it as projections — and it carries
 * `id`, the messages table's own primary key, on every row including a tool
 * call. The socket's `session.history` is the surface that says `text` and
 * `row_id`. The fake used to answer `text` on both, so the path a real gateway
 * ALWAYS takes was the one path nothing here ever exercised.
 */
/**
 * One search hit, built the way `sessions.py::search_sessions` builds one.
 *
 * The payload is `hit_payload` (snippet, role, source, model, session_started)
 * merged with the rich session row, and it deliberately carries NO message id
 * and NO message timestamp: upstream's projection is
 * `("session_id", "role", "snippet", "source", "model", "session_started")`,
 * although `SessionDB.search_messages` can return `id` and `timestamp` too. A
 * fake that offered them would let the app grow a dependency the real gateway
 * cannot satisfy — which is the one failure mode this file exists to prevent.
 */
function searchHitRow(session: FakeSession, snippet: string, role: string | null, at: number): Record<string, unknown> {
  const last = session.messages[session.messages.length - 1]

  return {
    snippet,
    role,
    source: 'hermie',
    model: 'example-provider/example-model',
    session_started: at,
    session_id: session.storedId,
    lineage_root: session.storedId,
    id: session.storedId,
    title: session.title,
    started_at: at,
    ended_at: null,
    last_active: at,
    is_active: true,
    message_count: session.messages.length,
    tool_call_count: 0,
    input_tokens: 0,
    output_tokens: 0,
    preview: last?.text ?? '',
    parent_session_id: null,
    archived: false
  }
}

/**
 * The FTS5 query shapes the route actually reaches this fake with.
 *
 * Upstream appends `*` to every bare token before it hands the query to FTS5
 * ("nimb" -> "nimb*"), keeps a quoted phrase whole, and joins them with FTS5's
 * implicit AND. So: every term must hit the SAME message, a bare term matches a
 * word that STARTS with it, and a quoted term matches that substring exactly.
 */
function searchTermsOf(query: string): { needle: string; phrase: boolean }[] {
  const terms: { needle: string; phrase: boolean }[] = []

  for (const raw of query.trim().match(/"[^"]*"|\S+/g) ?? []) {
    const phrase = raw.startsWith('"')
    const needle = (phrase ? raw.slice(1, -1) : raw.replace(/\*+$/, '')).trim().toLowerCase()

    if (needle) {
      terms.push({ needle, phrase })
    }
  }

  return terms
}

function messageMatches(text: string, terms: readonly { needle: string; phrase: boolean }[]): boolean {
  const haystack = text.toLowerCase()
  const words = haystack.split(/[^\p{L}\p{N}]+/u).filter(Boolean)

  return terms.every(term =>
    term.phrase ? haystack.includes(term.needle) : words.some(word => word.startsWith(term.needle))
  )
}

/** Where the first term lands in this message, or -1. */
function matchOffsetOf(text: string, terms: readonly { needle: string; phrase: boolean }[]): number {
  const first = terms[0]

  return first ? text.toLowerCase().indexOf(first.needle) : -1
}

/**
 * `snippet(messages_fts, -1, '>>>', '<<<', '...', 40)`, near enough.
 *
 * Near enough because the marker pair and the ellipsis are the parts the client
 * parses; the exact token budget is FTS5's business and no test may depend on
 * it. The matched run is wrapped where it was found, and a window that starts
 * or ends inside the message says so with `...`, exactly as the real one does.
 */
function snippetFor(text: string, terms: readonly { needle: string; phrase: boolean }[]): string {
  const at = matchOffsetOf(text, terms)

  if (at < 0) {
    return text.slice(0, 120)
  }

  const length = terms[0]?.needle.length ?? 0
  const start = Math.max(0, at - 40)
  const end = Math.min(text.length, at + length + 80)

  return `${start > 0 ? '...' : ''}${text.slice(start, at)}>>>${text.slice(at, at + length)}<<<${text.slice(at + length, end)}${end < text.length ? '...' : ''}`
}

/**
 * Sessions that match, one hit each, id matches before content matches.
 *
 * "One hit each" is the behaviour worth holding onto: upstream keys `seen` by
 * the lineage root and lets the first hit win, so forty matching messages in a
 * chat are ONE result. This fake has no compression lineage, so the key is the
 * session id — the same collapse by a shorter route.
 */
export function searchFakeSessions(
  sessions: readonly FakeSession[],
  query: string,
  limit: number
): Record<string, unknown>[] {
  const terms = searchTermsOf(query)
  const needle = query.trim().toLowerCase()
  const seen = new Map<string, Record<string, unknown>>()
  const at = nowSeconds() - 60

  for (const session of sessions) {
    if (seen.size >= limit) {
      break
    }

    if (session.storedId.toLowerCase().includes(needle) || session.id.toLowerCase().includes(needle)) {
      const preview = session.messages[session.messages.length - 1]?.text ?? ''

      seen.set(session.storedId, searchHitRow(session, preview || `Session ID: ${session.storedId}`, null, at))
    }
  }

  if (terms.length) {
    for (const session of sessions) {
      if (seen.size >= limit || seen.has(session.storedId)) {
        continue
      }

      const hit = session.messages.find(row => messageMatches(row.text ?? '', terms))

      if (hit) {
        seen.set(session.storedId, searchHitRow(session, snippetFor(hit.text ?? '', terms), hit.role, at))
      }
    }
  }

  return [...seen.values()]
}

function restMessageRow(row: TranscriptRow, index: number): Record<string, unknown> {
  return {
    id: row.row_id ?? index + 1,
    role: row.role,
    content: row.text ?? '',
    ...(row.display_kind ? { display_content: row.text ?? '', display_kind: row.display_kind } : {}),
    ...(row.display_metadata ? { display_metadata: row.display_metadata } : {}),
    ...(row.attachments ? { attachments: row.attachments } : {}),
    ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp }),
    ...(row.name === undefined || row.name === null ? {} : { name: row.name }),
    ...(row.tool_id === undefined || row.tool_id === null ? {} : { tool_id: row.tool_id }),
    ...(row.tool_call_id === undefined || row.tool_call_id === null ? {} : { tool_call_id: row.tool_call_id }),
    ...(row.call_row_id === undefined || row.call_row_id === null ? {} : { call_row_id: row.call_row_id }),
    ...(row.call_index === undefined || row.call_index === null ? {} : { call_index: row.call_index }),
    ...(row.context === undefined || row.context === null ? {} : { context: row.context }),
    ...(row.args === undefined || row.args === null ? {} : { args: row.args }),
    ...(row.reasoning === undefined || row.reasoning === null ? {} : { reasoning: row.reasoning })
  }
}

interface RingEntry {
  type: string
  session_id: string
  seq: number
  /** The turn this frame belongs to; part of the envelope, so a replayed frame names it as the live one did. */
  turn_id?: string
  payload: unknown
}

/**
 * One MCP server as the gateway's config holds it, before any of the four
 * `mcp.servers.*` views project it.
 *
 * The fake keeps the CONFIG and derives every answer from it, because that is
 * how upstream works: `mcp.servers.list` summarises `_get_mcp_servers()`,
 * `status` joins it with cached runtime state, and `test` actually connects. A
 * fake that stored three independent fixtures could report a server as
 * connected in one view and absent from another.
 */
export interface FakeMcpServer {
  name: string
  /** `http` servers can do OAuth; `stdio` ones authenticate with env keys. */
  transport: 'http' | 'stdio'
  url?: string
  command?: string
  args: string[]
  /** Env KEY NAMES only. Upstream never ships the values over the socket. */
  env: string[]
  auth?: 'oauth' | 'bearer' | null
  /** Whether a token is on disk. Only meaningful for `auth: 'oauth'`. */
  oauthTokensPresent: boolean
  /** `disabled: true` in config is the absence of this. */
  enabled: boolean
  /** What a probe would find. `null` means the connection itself fails. */
  tools: { name: string; description: string }[] | null
  /** The error a failing probe reports. */
  probeError?: string
}

/**
 * One row of the connector catalogue, as the vendor's list route shapes it.
 *
 * `statusReason` is declared here although the VENDORED `ConnectorRow` has no
 * such field: upstream's `ConnectorListItem` carries it, and both models are
 * open on purpose because the connector service owns the key set.
 */
export interface FakeConnector {
  connector: string
  connected: boolean
  enabled: boolean
  connectionStatus: string
  statusReason: string | null
  name?: string
  description?: string
}

/** `ConnectorOwner` (`tui_gateway/contracts/common.py`): whose connectors a call is about. */
export type FakeConnectorOwner = { type: 'session'; session_id: string } | { type: 'account' }

/**
 * A live connection operation, the way `tools/connectors/live.py` holds one.
 *
 * `seq` is the monotonic write counter every snapshot is stamped with, and the
 * reason it matters here is that a client has to ORDER frames: the gateway's
 * own account watcher moves a target on its own tick while a client is
 * polling, so a snapshot can arrive older than one already applied.
 *
 * `reads` plus `woken` is how this fake reproduces the watcher's latency
 * WITHOUT a timer: a target settles after two status reads, or immediately
 * after `connectors.operation.wake` — which is exactly what that method is for.
 */
export interface FakeConnectorOp {
  opId: string
  /**
   * The session that owns it (a stored or runtime id), or `''` for an
   * account-wide operation. A call reaches the operation only through the
   * owner that holds it (`live.get(session_key, op_id)` upstream).
   */
  sessionId: string
  /** Opened under `owner: {type: 'account'}` (the settings screen), not a chat's. */
  account?: boolean
  seq: number
  deadlineAt: number
  settled: boolean
  settledBy: string | null
  reads: number
  woken: boolean
  targets: {
    name: string
    kind: 'connector' | 'mcp'
    action: string
    state: string
    connectUrl: string | null
    detail: string | null
    /** Where the target lands once the flow resolves. */
    resolvesTo: string
  }[]
}

/** A PKCE flow `mcp.servers.oauth.start` opened and `…poll` walks. */
interface FakeOauthFlow {
  name: string
  /** `poll` answers `pending` this many more times before it approves. */
  pendingPolls: number
  status: 'pending' | 'approved' | 'error'
  errorMessage?: string
}

/**
 * The per-profile half of the capability state, which is NOT the same shape in
 * the three sections `profiles.configure` writes:
 *
 * - skills are stored as the DISABLED set (`skills.disabled` in config), so a
 *   skill nobody has ever mentioned is on;
 * - toolsets are stored as an optional PIN of enabled names, and `null` means
 *   no pin at all — which is a different state from "pinned to nothing", and
 *   the difference is what `toolsets_pinned` reports;
 * - MCP servers are stored per server as `disabled: true`, so the enabled list
 *   is the complement and always exists.
 *
 * Modelling all three as one enabled-set would make the fake agree with a
 * client that got any of them backwards.
 */
interface FakeProfileCapabilities {
  /** Lower-cased names, as `get_disabled_skills` normalises them. */
  disabledSkills: Set<string>
  /** `null` = unpinned: `_describe_toolsets` then falls back to the platform defaults. */
  pinnedToolsets: Set<string> | null
  /** Servers this profile has switched off. */
  disabledMcpServers: Set<string>
}

/**
 * The configurable toolsets, as `_get_effective_configurable_toolsets()` yields
 * them, plus the platform default that decides `enabled` for an UNPINNED
 * profile.
 *
 * Upstream filters two groups out of this list before a client ever sees them —
 * toolsets not allowed on the `cli` platform, and `_DEFAULT_OFF_TOOLSETS` that
 * are not already enabled — so the fake ships one of each: `kanban` is
 * default-off and therefore invisible until something enables it, which is the
 * behaviour a client that expects a stable list will get wrong.
 */
const FAKE_TOOLSETS: {
  name: string
  label: string
  description: string
  toolCount: number
  platformDefault: boolean
  defaultOff?: boolean
}[] = [
  {
    name: 'files',
    label: 'Files',
    description: 'Read and write files in the workspace.',
    toolCount: 6,
    platformDefault: true
  },
  { name: 'web', label: 'Web', description: 'Fetch pages and search the web.', toolCount: 3, platformDefault: true },
  { name: 'terminal', label: 'Terminal', description: 'Run shell commands.', toolCount: 2, platformDefault: true },
  {
    name: 'memory',
    label: 'Memory',
    description: 'Remember things between sessions.',
    toolCount: 4,
    platformDefault: false
  },
  {
    name: 'kanban',
    label: 'Kanban',
    description: 'Track work on a board.',
    toolCount: 5,
    platformDefault: false,
    defaultOff: true
  }
]

/** The hub catalogue `skills.manage` search / browse / inspect answer from. */
const FAKE_SKILL_HUB: { name: string; description: string; source: string; trust: string }[] = [
  { name: 'pdf', description: 'Read and fill PDF files.', source: 'bundled', trust: 'official' },
  { name: 'docx', description: 'Read and write Word documents.', source: 'bundled', trust: 'official' },
  { name: 'web-search', description: 'Search the web and cite results.', source: 'bundled', trust: 'official' },
  { name: 'xlsx', description: 'Read and write spreadsheets.', source: 'hub', trust: 'community' },
  { name: 'changelog-video', description: 'Turn a changelog into a video.', source: 'hub', trust: 'community' }
]

/**
 * The curated MCP presets `mcp.catalog` lists (`hermes_cli/mcp_catalog.py`): the name, what it is for,
 * the env keys it needs and how it talks. `installed` and `enabled` are derived from the profile's
 * own servers, never stored here.
 */
const FAKE_MCP_CATALOG: {
  name: string
  description: string
  requires: string[]
  transport: 'http' | 'stdio'
  command?: string
  args?: string[]
  url?: string
}[] = [
  {
    name: 'github',
    description: 'Issues, pull requests and repositories.',
    requires: ['GITHUB_TOKEN'],
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github']
  },
  {
    name: 'fetch',
    description: 'Fetch a web page as text.',
    requires: [],
    transport: 'stdio',
    command: 'uvx',
    args: ['mcp-server-fetch']
  },
  {
    name: 'linear',
    description: 'Linear issues and projects.',
    requires: [],
    transport: 'http',
    url: 'https://mcp.linear.example.test/mcp'
  }
]

/** The env var a server's API key is written under unless the caller names one. */
const mcpKeyName = (server: string): string => `MCP_${server.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}_API_KEY`

export interface FakeGatewayState {
  auth: FakeAuthMode
  token: string
  closeCode: number
  replayEpoch: string
  /** Access tokens the gateway currently honours. */
  accessTokens: Set<string>
  ticketsMinted: number
  ticketsConsumed: number
  tokenExchanges: number
  refreshCalls: number
  /** Successful WebSocket sessions since boot. */
  connections: number
  /** WebSocket upgrades rejected with a close code. */
  rejectedUpgrades: number
  /** Force the next N upgrades to fail auth even with a valid credential. */
  rejectNextUpgrades: number
  /**
   * Answer the next N ticket mints with 503.
   *
   * A dial can fail for a reason that has nothing to do with the credential, and
   * the mint is where that is cheapest to stage: upstream's ws-ticket route is an
   * ordinary authenticated POST, so a proxy hiccup in front of it looks exactly
   * like this and must NOT count as a rejection of the credential.
   */
  failNextTicketMints: number
  /** The ids `GET /api/auth/picture` was asked for, in order: a picture fetched twice shows twice. */
  pictureRequests: string[]
  /** What `GET /api/files/images/{name}` was asked for and answered, in order. */
  attachedImageRequests: { name: string; profile: string | null; status: number }[]
  /** The files a bot shared, by token (`outbox.ts`). */
  outboxFiles: Map<string, OutboxFile>
  /** What `GET /api/files/outbox/{id}/{name}` was asked for and answered, in order. */
  outboxRequests: OutboxRequest[]
  /** Ticket mints answered with 503 because of `failNextTicketMints`. */
  ticketMintsFailed: number
  /** What the audio routes were asked, oldest first (`speak` and `speak-stream`). */
  audioRequests: AudioRequest[]
  /** Streams the client ended before the gateway had sent `end`: a barge-in, or a client that gave up. */
  audioStreamsCancelled: number
  /**
   * Refresh tokens this gateway has already rotated away.
   *
   * Upstream keeps no refresh-token store of its own — rotation and invalidation
   * happen at the identity provider — but a rotating IdP with reuse detection is
   * the case that costs a session, so the fake models it: presenting a spent
   * token is refused rather than quietly accepted.
   */
  spentRefreshTokens: Set<string>
  /** Refresh calls that presented an already-rotated token. */
  refreshReuseAttempts: number
  /**
   * Every `POST /auth/native/revoke` this gateway answered, oldest first: what
   * the body named and whether an `Authorization` header came with it (the
   * route is public, so a client has no reason to send one).
   */
  revokeCalls: { refreshToken: string; provider: string; authorization: boolean }[]
  /** `session.events.since` calls, newest last. */
  eventsSinceCalls: { session_id: string; last_seen: number }[]
  /**
   * Every answer a client gave to a server→client request, oldest first: the
   * request's id and method, and the result or the error frame it sent back.
   */
  serverRequestAnswers: { id: string; method: string; result?: unknown; error?: unknown }[]
  /**
   * Every `client.capabilities` call, oldest first: what the client said it
   * handles. `confirm` is the list of `confirm` levels it offered, empty when it
   * sent none. Recorded as sent, whatever the level is called, because the fake
   * is there to be told things the real gateway would filter.
   */
  clientCapabilities: {
    server_requests: boolean
    confirm: string[]
    confirm_passkey?: unknown
    /** The interactive methods (`input.form`, ...) the gateway accepted; present only when the call carried `requests`. */
    requests?: string[]
  }[]
  /** Every JSON-RPC method the server handled, in order. */
  methodLog: string[]
  /** Mark the next replay answer as truncated. */
  truncateNextReplay: boolean
  /**
   * Chats another Hermes window or terminal has open: stored session id → the gateway's own line about who
   * holds it (`session … opened by cli 4m ago.`). A `prompt.submit` on one is refused with 4090 and
   * `data.reason: "SESSION_NOT_OWNED"` (the fork's `SessionOwnership`), the way a real gateway refuses it.
   * A new conversation is another session, so it goes through.
   */
  ownedElsewhere: Map<string, string>
  /** While set, every `prompt.submit` fails with 5000 and this message (any length: a client must bound what it draws). */
  promptFailure: string | null
  /** Methods the server accepts and never answers, so a caller's timeout fires. */
  hangMethods: Set<string>
  sessions: Map<string, FakeSession>
  profiles: ProfileRow[]
  /** Profile name → that profile's two memory files, as lists of entries. */
  memory: Map<string, Record<MemoryTarget, string[]>>
  /** Capability state per profile name, filled in on first read. */
  profileCapabilities: Map<string, FakeProfileCapabilities>
  /** Skills installed under each profile, which is what `profiles.describe` lists. */
  profileSkills: Map<string, string[]>
  /** The gateway-wide MCP catalogue every `mcp.servers.*` view is derived from. */
  mcpServers: FakeMcpServer[]
  /**
   * `approvals.mcp_reload_confirm`. While it is true, a `reload.mcp` without
   * `confirm` answers `confirm_required` instead of reloading — the prompt-cache
   * warning — and `always` is what turns it off for good.
   */
  mcpReloadConfirm: boolean
  /** Completed `reload.mcp` runs, so a test can prove one actually happened. */
  mcpReloads: number
  /** OAuth flows opened by `mcp.servers.oauth.start`, by flow id. */
  mcpOauthFlows: Map<string, FakeOauthFlow>
  /**
   * What `mcp.servers.set_api_key` and an `add` with a `bearer_token` wrote to a profile's `.env`,
   * by server name. The gateway never sends a value back, so this is how a test sees one arrive.
   */
  mcpSecrets: Map<string, { envVar: string; value: string }>
  /** Skill names installed from the hub over the socket, newest last. */
  skillsInstalled: string[]
  /**
   * The connector catalogue one session can see.
   *
   * Upstream reaches this through `manage_connections`, so the rows are the
   * vendor's `ConnectorListItem` shape — an OPEN model whose key set the
   * connector service owns, which is why `statusReason` rides here without
   * being in the vendored contract's `ConnectorRow`.
   */
  connectors: FakeConnector[]
  /**
   * `manage_connections` being off for the session.
   *
   * When it is true `connectors.list` answers `{available: false,
   * connectors: []}` with NO error frame, and `connectors.connect` refuses
   * with 4031.
   */
  connectorsUnavailable: boolean
  /**
   * The Kanban plugin's boards, or `null` when the plugin is not mounted.
   *
   * `null` is the state worth having: `web_server_dashboard.py` only mounts the
   * router for a plugin that is bundled or enabled, so a gateway without it
   * 404s the PREFIX and every route with it.
   */
  kanbanBoards: FakeKanbanBoard[] | null
  /** Completed `POST /dispatch` nudges, so a test can prove a write kicked one. */
  kanbanDispatches: number
  /** Live connection operations by `op_id`. */
  connectorOps: Map<string, FakeConnectorOp>
  /**
   * The monotonic write counter every operation snapshot is stamped with.
   *
   * It is gateway-wide rather than per operation, the way upstream's is, so a
   * client cannot get away with comparing two operations' counters.
   */
  connectorSeq: number
  /** Every `connection.respond` the contract accepted, as it was sent, oldest first. */
  connectionResponses: Record<string, unknown>[]
  cronJobs: CronJob[]
  /**
   * The profile `hermes serve` was launched with. `cron.manage` binds
   * HERMES_HOME to its `profile` param and falls back to this one, so it is the
   * only store an unscoped socket call can see.
   */
  cronLaunchProfile: string
  /**
   * `gateway_running` in every `cron.manage` answer: whether the scheduler
   * process is up. Flip it to false to drive the Crons banner.
   */
  cronGatewayRunning: boolean
  /** Stored ids of the sessions the gateway reports as busy. */
  runningSessions: Set<string>
  /** Session-scoped configuration `config.get` / `config.set` read and write. */
  sessionConfig: Map<string, Record<string, string>>
  /** Approvals raised and not yet answered, by queue id. */
  pendingApprovals: Map<string, { session_id: string; payload: Record<string, unknown> }>
  /**
   * Server→client requests still waiting on an answer, by request id.
   *
   * The real gateway reports these as `open_requests` on `session.resume` and
   * `session.events.since`, and the channel re-delivers them to the client's
   * request handlers BEFORE the call they rode in on resolves. A fake without
   * them cannot reproduce the window where an inherited approval arrives for a
   * session nothing has bound yet.
   */
  openServerRequests: Map<
    string,
    {
      session_id: string
      method: string
      params: Record<string, unknown>
      /** Who this request may be shown to; absent means every connection (a gated `confirm` sets it). */
      viewer?: (socket: WebSocket) => boolean
    }
  >
  /**
   * Pictures `profiles.set_asset` has written, by `<profile>:<asset>`.
   *
   * Kept beside the roster rather than on the row: a `ProfileRow` is what
   * `profiles.list` answers with, and a real roster row carries no bytes — only
   * `has_avatar` and the revision a client re-fetches on.
   */
  profileAssets: Map<string, { mime: string; bytes: Buffer }>
  /** Each profile's `SOUL.md`, which `profiles.describe` reads and `profiles.configure` writes. */
  profileSouls: Map<string, string>
  /**
   * Methods this gateway refuses with a code and a message, whatever the caller: how a test stages
   * an account that may read a profile and not write it (`POST /__fake/deny`).
   */
  deniedMethods: Map<string, { code: number; message: string }>
  /**
   * What the usage calls answer with beyond what is derived (`usage.ts`): a profile's staged days, the
   * Nous balance, the account lines `session.usage` carries, and whether the gateway has the calls at all
   * (`POST /__fake/usage`).
   */
  usage: UsageStage
  /**
   * What `session.interrupt_all` answers beyond the sessions it stops (`POST /__fake/stop-all`): the number it
   * says it may not stop (other people's turns in a shared chat) and the number whose stop failed, and
   * whether the gateway has the method at all (an older one answers `-32601`).
   */
  stopAll: { unsupported: boolean; notAllowed: number; failed: number }
  /**
   * Every profile's credential vault and the one password manager on the "host" (`vault.ts`), with what a test
   * staged through `POST /__fake/vault`.
   */
  vault: VaultStage
  /**
   * Every profile's standing approvals, every live session's session approvals and the approval mode
   * (`approval-grants.ts`), with what a test staged through `POST /__fake/approvals`.
   */
  approvals: ApprovalGrantsStage
  /** Images accepted through `image.attach_bytes`, newest last. */
  attachedImages: { session_id: string; filename: string; bytes: number }[]
  /**
   * Files accepted through `POST /api/files/upload-stream`, by resolved path.
   *
   * Held in memory rather than written anywhere: a test wants to know that the
   * bytes arrived, how many there were, and at which path — and to read them back
   * (`GET /__fake/files/content`) without a disk it then has to clean up. Reading
   * what the gateway received, not what the browser says it sent, is what lets a
   * check on an upload body run on an engine that hides Blob and FormData bodies
   * from request interception (WebKit).
   */
  uploadedFiles: Map<
    string,
    { path: string; filename: string; bytes: number; contentType: string; sha256: string; content: Buffer }
  >
  /**
   * Children a delegation has spawned and not yet finished, by subagent id.
   *
   * `subagent.list` and `delegation.status` both read this. A real gateway only
   * knows about LIVE children — a finished one is dropped from the registry and
   * lives on only in the transcript — so a completed child is deleted here too,
   * which is exactly the case a client's reconcile has to survive.
   */
  liveSubagents: Map<string, LiveSubagent>
  /**
   * Background processes `agents.list` reports. A queued `message_agent` puts a
   * `bot_mode_dm.py --run-delivery` row in here until the reply lands.
   */
  agentProcesses: Map<string, { session_id: string; command: string; status: string; startedAt: number }>
}

/** One live delegated child, in the shape `subagent.list` projects. */
export interface LiveSubagent {
  subagent_id: string
  parent_id: string | null
  depth: number
  goal: string
  delegation_id: string
  model: string
  started_at: number
  status: string
  tool_count: number
  last_tool: string | null
  accepting_steer: boolean
  child_session_id: string
  owner_session_id: string
}

interface ProfileRow {
  name: string
  path: string
  description: string
  display_name: string
  model: string
  provider: string
  has_avatar: boolean
  ui_meta_revisions: Record<string, number>
  is_default?: boolean
  canonical_session?: {
    id: string
    resolved_id: string
    title: string
    preview: string
    last_active: number
    message_count: number
  }
  ui_meta?: Record<string, unknown>
}

/**
 * A cron job as the store holds it.
 *
 * The two gateway surfaces disagree about its shape and the fake reproduces
 * that on purpose, because a client that only ever sees one of them breaks the
 * first time it meets the other: `cron.manage` answers `_format_job` rows
 * (`job_id`, `prompt_preview`, no full prompt), the REST detail route answers
 * the stored job (`id`, full `prompt`).
 */
interface CronJob {
  id: string
  name: string
  /**
   * Whose cron store holds it. There is no such field on a real stored job —
   * each profile has its own `cron/jobs.json` — so it is stripped from every WS
   * row and re-attached on HTTP ones the way `_annotate_cron_job` does.
   */
  profile: string
  schedule: string
  prompt: string
  deliver: string
  enabled: boolean
  state: string
  next_run_at: string | null
  last_run_at: string | null
  last_status: string | null
  last_error: string | null
  paused_at: string | null
  paused_reason: string | null
  repeat: number | null
  skills: string[]
  model: string | null
  runs: CronRunRow[]
}

/**
 * A run session, in the `list_sessions_rich` row shape `/runs` answers with.
 *
 * `end_reason` and NOT `status`: a session row is `dict(sqlite_row)` over the
 * sessions table, and that table has no status column at all. The fake used to
 * invent one, which meant the app's run history read "ok" against this server
 * whatever it said — and would have read "ok" against a real gateway for every
 * run, including the ones that died.
 */
interface CronRunRow {
  id: string
  source: string
  title: string
  end_reason: string | null
  started_at: number
  ended_at: number | null
  last_active: number
  message_count: number
  preview: string
  archived: boolean
  is_active: boolean
  profile: string
}

export interface FakeGateway {
  port: number
  url: string
  wsUrl: string
  state: FakeGatewayState
  /** Publish one gateway event to every connected socket. */
  emit(type: string, options?: { sessionId?: string; payload?: unknown }): void
  /** Push a server→client `approval` request and resolve with the client's answer. */
  requestApproval(params: Record<string, unknown>): Promise<unknown>
  /** The same for any server→client method, so `clarify` can be driven too. */
  requestServerSide(method: string, params: Record<string, unknown>): Promise<unknown>
  /** Close every live socket with a code, the way the gateway does on a policy refusal. */
  closeSockets(code: number, reason?: string): void
  /** Kill every live socket without a close frame: the client sees 1006. */
  dropSockets(): void
  /** Rewrite `hermie-app.push` on the default profile, the way a device would. */
  setPushRegistrations(registrations: Record<string, unknown>, seen?: Record<string, number>): void
  /**
   * Deliver a cron report into a bot's chat, header and all.
   *
   * A cron delivery has NO wire marker: the scheduler injects it as an ordinary
   * inbound `user` row with a header spliced in front, and that header is the
   * whole signal. So the fake has to splice the same header, or a reader tested
   * against it is tested against nothing.
   */
  deliverCron(options?: { profile?: string; job?: string; report?: string; reply?: string; failed?: boolean }): void
  /** The same for a bot-to-bot delivery, which is recognised the same way. */
  deliverBotDm(options?: { profile?: string; from?: string; handle?: string; body?: string; reply?: string }): void
  /**
   * Raise an approval on a profile's canonical chat.
   *
   * `queueOnly` stages the case a push daemon on its safe default has to cope
   * with: a question that opened while nothing was attached, so there is no live
   * server→client frame to receive and the only trace of it is the approval
   * queue — which `session.resume` reports as `pending_approval` and
   * `approval.pending` lists.
   */
  raiseApprovalOn(options?: { profile?: string; command?: string; queueOnly?: boolean }): Promise<unknown>
  /**
   * The passkey level: its store, settings and limits, or `null` while this gateway does not know the
   * level (`startFakeGateway({ passkey })`, `POST /__fake/passkey/enable`).
   */
  passkey(): PasskeyGateway | null
  /** Make this gateway know the level, or change how it is set up. The same as `POST /__fake/passkey/enable`. */
  enablePasskey(options?: PasskeyOptions): PasskeyGateway
  /** The MCP feature: its grants and settings, or `null` while this gateway does not serve it (`startFakeGateway({ mcp })`). */
  mcp(): McpGateway | null
  /** Make this gateway serve MCP, or change how it is set up (`enabled: false` switches it off). */
  enableMcp(options?: McpOptions): McpGateway
  /**
   * Raise a `confirm` on a profile's chat through the gated path (the gateway must know the level).
   * `unavailable` with the reason when nothing was sent; otherwise `done` resolves with the outcome the
   * agent would learn: `{outcome, method, verified, reason}`.
   */
  raiseConfirm(options: {
    profile?: string
    title?: string
    summary: string
    detail?: string
    level?: 'plain' | 'passkey'
    /**
     * Structured facts (`{kind, label, value, currency?, id?}`, at most 8): a request with fields goes only to
     * connections that advertised `confirm_fields: true` (at `passkey` also `confirm_passkey {v: 2}`).
     */
    fields?: unknown
    /** After a `review.draft` approval: the `draft_id`; the detail is that approved text, verbatim. */
    draftId?: string
    /** `<provider>:<user id>` the request is for; `null` is nobody (a turn nobody signed in submitted). */
    user?: string | null
    /** Seconds before it times out (default 120). */
    timeoutSeconds?: number
    turnIsolation?: boolean
  }): RaiseResult
  /**
   * Raise an interactive request (`input.form`, `input.file`, `review.draft`, `review.diff`, `input.signature`,
   * `device.location`, `device.contact`, `device.calendar`, `device.scan`) on a profile's chat, as `POST /__fake/request` does: `params` laid over the contract's example, sent only to the
   * connections that advertised the method. `unavailable` when none did; otherwise `settled` resolves with how
   * it ended (`answered` with what the gateway took, `timeout`, `too_many_attempts`, `unavailable` after a
   * client's error response, `withdrawn`).
   *
   * A `review.diff` may be raised from the agent's own unified diff: `params.diff` (one file; `params.path`
   * names it when the diff has no `---`/`+++` lines) is read by the gateway's parser, which numbers the
   * hunks, computes each `anchor` and reads `kind`/`path`/`old_path` from the header. A diff the gateway
   * would refuse comes back as `{kind: 'refused', error: 'diff_refused', detail}` and nothing is sent. The
   * approved answer then carries `approved_patch`, recomposed from the approved hunks.
   */
  raiseInteractive(options: {
    profile?: string
    method: InteractiveMethod
    params?: Record<string, unknown>
    /** `null`: the turn acts for nobody (a shared conversation); `review.*`, `input.signature` and `device.*` go to no one. */
    user?: string | null
  }): RaiseInteractiveResult
  /**
   * Turn the interactive limits on or off, and/or forget what they have counted
   * (`POST /__fake/request-limits {enabled?, reset?}`).
   */
  interactiveLimits(options: { enabled?: boolean; reset?: boolean }): { enabled: boolean }
  close(): Promise<void>
}

/**
 * The profile `hermes serve` runs as. The fixture bots (`researcher`,
 * `writer`) are secondary profiles, so a cron in one of them is only reachable
 * with an explicit scope.
 */
const LAUNCH_PROFILE = 'default'

/**
 * The only thing `set_profile_display_name` validates besides `.strip()`.
 *
 * Read off `hermes_cli/profiles.py`: no character set and no uniqueness check,
 * so a fake that refused anything else would refuse names that really work.
 */
const PROFILE_NAME_LIMIT = 64

/**
 * The plugin's own cap on a display name, which is NOT core's 64.
 *
 * Deliberately a different number from the line above: the two limits are set
 * by two different pieces of software, and a fake that gave them the same value
 * would let a client that only ever checked one of them look correct.
 */
const DISPLAY_NAME_LIMIT = 60

/**
 * What a memory file joins its entries with, and what the store spends on it.
 *
 * Defined by Hermes' own `MemoryStore`; repeated in the plugin as
 * `memory/__init__.py::ENTRY_DELIMITER`, where a test keeps the two equal. A
 * usage count that summed the entries instead would disagree with the store
 * about how full a file is, and somebody would delete entries to fix a number
 * that was never true.
 */
const ENTRY_DELIMITER = '\n§\n'

/** Hermes' defaults, as the plugin's own fixture reads them off the store. */
const MEMORY_LIMITS: Record<MemoryTarget, number> = { memory: 2200, user: 1375 }

/** The two targets there are. The store dispatches on a bare `target === 'user'`. */
const MEMORY_TARGETS = ['memory', 'user'] as const

type MemoryTarget = (typeof MEMORY_TARGETS)[number]

/** `memory/browse.py::EXCERPT_CHARS`. A graph is drawn, not read. */
const EXCERPT_CHARS = 120

/** `memory/browse.py::DEFAULT_PAGE`. The graph pages over ENTRIES, not nodes. */
const MEMORY_PAGE = 100

/** `memory/browse.py::MAX_NODES` / `MAX_EDGES`: a last defence, not the paging. */
const MEMORY_MAX_NODES = 400
const MEMORY_MAX_EDGES = 1200

/**
 * The plugin's cheap topics, character for character.
 *
 * None of this is NLP and the plugin says so: a capitalised word that is not a
 * sentence opener, an `@handle`, a `#hashtag`, an ISO date. It is ported rather
 * than approximated because the graph the app draws is these nodes, and a fake
 * that clustered differently would stage a picture no gateway produces.
 */
const TOPIC_HANDLE = /(?<![\w@])@([A-Za-z0-9_][A-Za-z0-9_.-]{1,30})/g
const TOPIC_HASHTAG = /(?<![\w#])#([A-Za-z][A-Za-z0-9_-]{1,30})/g
const TOPIC_DATE = /\b(\d{4}-\d{2}-\d{2})\b/g
const TOPIC_CAPITALISED = /\b([A-Z][a-zA-Z0-9]{2,}(?:\s+[A-Z][a-zA-Z0-9]{2,}){0,2})\b/g

const TOPIC_STOPWORDS = new Set(
  `the this that these those they them their there here when where what which who whom whose
   and but for nor yet with from into onto upon about after before during until while because
   should would could must might will shall have has had been being does did doing not never
   always often sometimes usually prefer prefers wants needs uses using user memory note notes`.split(/\s+/)
)

function topicsIn(text: string): string[] {
  const found: string[] = []

  for (const pattern of [TOPIC_HANDLE, TOPIC_HASHTAG, TOPIC_DATE]) {
    for (const match of text.matchAll(pattern)) {
      found.push(match[1] as string)
    }
  }

  for (const match of text.matchAll(TOPIC_CAPITALISED)) {
    const phrase = (match[1] as string).trim()

    if (!TOPIC_STOPWORDS.has(phrase.toLowerCase()) && phrase.length > 2) {
      found.push(phrase)
    }
  }

  return [...new Set(found)]
}

function memoryExcerpt(text: string): string {
  const flat = text.split(/\s+/).filter(Boolean).join(' ')

  return flat.length <= EXCERPT_CHARS ? flat : `${flat.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`
}

interface MemoryEntryRow {
  id: string
  target: MemoryTarget
  index: number
  text: string
  chars: number
  topics: string[]
}

/** `memory/browse.py::entry_rows`. The id is POSITIONAL and deliberately not a handle. */
function memoryRows(entries: readonly string[], target: MemoryTarget): MemoryEntryRow[] {
  return entries.map((text, index) => ({
    id: `${target}:${index}`,
    target,
    index,
    text,
    chars: text.length,
    topics: topicsIn(text)
  }))
}

/**
 * `memory/browse.py::graph` — nodes and edges an app can draw.
 *
 * The page is over ENTRIES, not over nodes, and that is the property to keep: a
 * page whose topic nodes happened to fill the cap would silently drop entries,
 * and an app paging through would never learn it had missed one. The caps are a
 * last defence and `truncated` says when one bit.
 *
 * An edge never names an entry the caller was not sent — entry-to-entry edges
 * are built inside the page only — because an edge to a node that is not in the
 * answer is an edge the app cannot draw.
 */
function memoryGraph(
  files: Record<MemoryTarget, string[]>,
  profile: string,
  offset: number,
  limit: number
): Record<string, unknown> {
  const rows = MEMORY_TARGETS.flatMap(target => memoryRows(files[target], target))
  const from = Math.max(0, Math.floor(Number.isFinite(offset) ? offset : 0))
  const size = Math.max(1, Math.floor(limit || MEMORY_PAGE))
  const page = rows.slice(from, from + size)

  const profileNode = { id: `profile:${profile}`, type: 'profile', label: profile }
  const nodes: Record<string, unknown>[] = [profileNode]
  const edges: Record<string, unknown>[] = []
  const seenTopics = new Map<string, string>()
  const byTopic = new Map<string, string[]>()
  let truncated = false

  for (const row of page) {
    if (nodes.length >= MEMORY_MAX_NODES) {
      truncated = true

      break
    }

    nodes.push({ id: row.id, type: 'entry', target: row.target, label: memoryExcerpt(row.text), chars: row.chars })
    edges.push({ from: row.id, to: profileNode.id, type: 'in_profile' })

    for (const topic of row.topics) {
      let nodeId = seenTopics.get(topic)

      if (nodeId === undefined) {
        if (nodes.length >= MEMORY_MAX_NODES) {
          truncated = true

          break
        }

        nodeId = `topic:${topic}`
        seenTopics.set(topic, nodeId)
        nodes.push({ id: nodeId, type: 'topic', label: topic })
      }

      edges.push({ from: row.id, to: nodeId, type: 'mentions' })
      byTopic.set(topic, [...(byTopic.get(topic) ?? []), row.id])
    }
  }

  for (const [topic, members] of byTopic) {
    for (let first = 0; first < members.length; first += 1) {
      for (let second = first + 1; second < members.length; second += 1) {
        if (edges.length >= MEMORY_MAX_EDGES) {
          truncated = true

          break
        }

        edges.push({ from: members[first], to: members[second], type: 'shares_topic', topic })
      }
    }
  }

  return {
    nodes,
    edges: edges.slice(0, MEMORY_MAX_EDGES),
    page: {
      offset: from,
      limit: size,
      returned: page.length,
      total: rows.length,
      hasMore: from + page.length < rows.length
    },
    truncated
  }
}

/** `memory/browse.py::matches`: every word, in any order, case-insensitively. */
function memoryMatches(text: string, query: string): boolean {
  const haystack = text.toLowerCase()
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return words.length > 0 && words.every(word => haystack.includes(word))
}

const FAKE_WEB_PUSH_PUBLIC_KEY =
  'BB4V0uA3Mhr24OQdSBvpiQbXxekA10YihCyW0_L4zE616vb3_kTg5WvgJ_rP5L6QUdFKymkHRs2SDtj8M9czWIw'

/**
 * The `hermie-plugin` advert, as the gateway-side plugin publishes it.
 *
 * Copied from the plugin's own `contract.py` rather than invented here: the
 * app reads capability STRINGS and never a version number, so a fixture that
 * spelled one of them differently would stage a gateway whose plugin exists
 * and offers nothing, which is not a state any real gateway is in.
 *
 * `dm` is not among the types, and that is the point of the fixture as much as
 * anything in it: Hermes fires no hook when a bot-to-bot DM arrives, so a
 * plugin cannot produce one and does not advertise it.
 */
export const PLUGIN_ADVERT: Record<string, unknown> = {
  v: 1,
  version: '0.2.0',
  capabilities: [
    'context.per_bot',
    'context.system_prompt',
    'context.turn_claim',
    'push.expo',
    'push.mute',
    'push.preview',
    'push.relay',
    'push.seen.per_chat',
    'push.type.turn_done',
    'memory.browse',
    'memory.edit',
    'push.type.turn_failed',
    'push.webpush',
    'push.webpush.key',
    'profiles.display_name',
    'ui_meta.per_user',
    'web.client'
  ],
  modules: {
    attachments: 'planned',
    context: 'on',
    memory: 'on',
    presence: 'planned',
    profiles: 'on',
    push: 'on',
    search: 'planned',
    sessions: 'planned',
    transcripts: 'planned',
    usage: 'planned',
    web: 'on'
  },
  limits: { payloadBytes: 3500, contextChars: 1200 },
  relayOrigins: ['https://push.hermie.dev'],
  /*
    The bundled web client, as the plugin describes it once its files match
    their manifest. The numbers are a fixture, not a measurement of any
    directory handed to `pluginAssets`.
  */
  web: {
    path: '/dashboard-plugins/hermie/app/index.html',
    version: '0.2.0',
    commit: '0123456789ab',
    files: 37,
    bytes: 1_432_211
  },
  /*
    The plugin's VAPID public key: the uncompressed P-256 point, 87 base64url
    characters. A fixed key whose private half does not exist anywhere, so a
    test can tell it from any real one.
  */
  webPush: { publicKey: FAKE_WEB_PUSH_PUBLIC_KEY },
  updatedAt: 1_790_001_453
}

/** `profiles.display_name`, which `--profile-display-name absent` takes away. */
const DISPLAY_NAME_CAPABILITY = 'profiles.display_name'

/** `context.turn_claim`, which `turnClaim: false` takes away. */
const TURN_CLAIM_CAPABILITY = 'context.turn_claim'

/** `memory.edit`, which `memoryEdit: false` takes away. */
const MEMORY_EDIT_CAPABILITY = 'memory.edit'

/** `push.relay`, which `pushRelay: false` takes away. */
const PUSH_RELAY_CAPABILITY = 'push.relay'

/** `web.client`, which `webClient: false` takes away together with the `web` block. */
const WEB_CLIENT_CAPABILITY = 'web.client'

/** `push.webpush.key`, which `webPushKey: false` takes away together with the `webPush` block. */
const WEB_PUSH_KEY_CAPABILITY = 'push.webpush.key'

/**
 * The advert this gateway serves, or `null` when it has no plugin.
 *
 * One reader for the `ui_meta` key and for the plugin's own routes, so a
 * capability a route refuses to honour cannot also be advertised by accident —
 * which is the one inconsistency a fake can have that a real gateway cannot.
 * `profileDisplayName: 'absent'`, `turnClaim: false`, `pushRelay: false`, `webClient: false` and
 * `webPushKey: false` each filter their own
 * string out of whichever advert is in play, including one a test passed in
 * itself: a plugin that does not have a route does not advertise it, whoever
 * wrote the rest of the advert.
 */
function advertOf(options: FakeGatewayOptions): Record<string, unknown> | null {
  if (options.plugin === false) {
    return null
  }

  const advert = (options.plugin ?? PLUGIN_ADVERT) as Record<string, unknown>
  const drop = new Set<string>()

  if (options.profileDisplayName === 'absent') {
    drop.add(DISPLAY_NAME_CAPABILITY)
  }

  if (options.turnClaim === false) {
    drop.add(TURN_CLAIM_CAPABILITY)
  }

  if (options.memoryEdit === false) {
    drop.add(MEMORY_EDIT_CAPABILITY)
  }

  if (options.pushRelay === false) {
    drop.add(PUSH_RELAY_CAPABILITY)
  }

  if (options.webClient === false) {
    drop.add(WEB_CLIENT_CAPABILITY)
  }

  if (options.webPushKey === false) {
    drop.add(WEB_PUSH_KEY_CAPABILITY)
  }

  if (drop.size === 0) {
    return advert
  }

  const filtered: Record<string, unknown> = {
    ...advert,
    capabilities: (Array.isArray(advert.capabilities) ? advert.capabilities : []).filter(
      entry => typeof entry !== 'string' || !drop.has(entry)
    )
  }

  if (options.webClient === false) {
    delete filtered.web

    if (advert.modules && typeof advert.modules === 'object') {
      const { web: _web, ...modules } = advert.modules as Record<string, unknown>
      filtered.modules = modules
    }
  }

  if (options.webPushKey === false) {
    delete filtered.webPush
  }

  return filtered
}

/**
 * `cron/scheduler_delivery.py::_deliver_to_bot_chat`'s header, verbatim.
 *
 * Load-bearing text: a cron delivery carries no `display_kind` and no metadata,
 * so this sentence is the only thing that distinguishes it from the owner
 * typing. A fake that paraphrased it would make every reader that parses it look
 * correct while failing on a real gateway.
 */
const CRON_BOT_CHAT_HEADER = (job: string): string =>
  `[Cronjob "${job}" output — scheduled job, not the user. Review it, act on anything that needs action, and summarize for the chat.]`

const WS_PATH = '/api/ws'
const GATEWAY_WS_PROTOCOL = 'hermes-gateway-v1'
const TICKET_PROTOCOL_PREFIX = 'hermes-gateway-ticket.'
/** The access-token cookie, as `dashboard_auth/cookies.py` names it over plain HTTP. */
const SESSION_COOKIE = 'hermes_session_at'
const TICKET_TTL_SECONDS = 30

/** Frames one delegated child runs through: requested, start, thinking, tool, progress, complete. */
const FRAMES_PER_CHILD = 6

/**
 * The context window every fake session reports.
 *
 * A round number on purpose: the app derives the percentage it draws by
 * dividing, so a window a reader can divide in their head is a window they can
 * check the ring against.
 */
const FAKE_CONTEXT_MAX = 200_000

/**
 * A reply long enough to fold, cut in half by a tool call.
 *
 * The transcript's own bug — the column jumping while a reply streams — needs a
 * turn that lasts long enough to watch and that produces all three item kinds:
 * an interim note sealed by the tool, the tool row, and a second bubble that
 * grows past the fold's fourteen lines before it settles. Two deltas of
 * `Looking that up for you.` produce none of that and finish inside one frame.
 *
 * Reached with a prompt containing `long`, so the short default is still what
 * every other manual run and every test gets.
 */
const LONG_REPLY_DELTAS: string[] = [
  'Right — let me walk through what I found, ',
  'because there are a few threads here and they do not all point the same way.\n\n',
  'First, the **release notes**. ',
  'The changelog for 0.21 lists the gateway rewrite, ',
  'but it does not mention the token refresh path at all, ',
  'which is the part you were actually asking about.\n\n',
  'Second, the tests. ',
  'There are two suites that cover this and they disagree: ',
  'one asserts the refresh happens before the socket opens, ',
  'the other asserts it happens on the first 401. ',
  'Both pass, because they stub different layers.\n\n',
  'Let me read the file before I say which one is right.\n\n',
  'So: the refresh is attempted **before** the socket opens, ',
  'and the 401 path is a fallback that only runs when the stored token ',
  'was still inside its validity window when the attempt started.\n\n',
  'That means the second suite is testing a path that a healthy client ',
  'reaches roughly never, which is why nobody noticed it had drifted.\n\n',
  'Three things follow from that:\n\n',
  '1. The refresh timer is the thing to instrument, not the 401 handler.\n',
  '2. The second suite needs a comment saying which case it pins down.\n',
  '3. The changelog entry is worth writing before this is forgotten again.\n\n',
  'I can start with the first of those if you want.'
]

/**
 * A reply whose body is a `mermaid` fence, reached with a prompt containing `mermaid`.
 *
 * Split across deltas ON PURPOSE, and the fence opens in one delta and closes in a
 * later one: every flush in between hands the renderer a half-arrived diagram,
 * which is exactly the state `parseMermaid` answers `null` for and the block falls
 * back to a fenced listing. A fixture that arrived whole in one frame would never
 * show that the fallback works, and the fallback is the part that keeps a streaming
 * reply from flickering a picture in and out.
 *
 * The graph itself stays inside the supported subset (ADR-0020): `flowchart`, plain
 * shapes, labelled and dotted edges, no `subgraph` and no `style`.
 */
const MERMAID_REPLY_DELTAS: string[] = [
  'Here is the refresh path as a picture.\n\n',
  '```mermaid\n',
  'flowchart TD\n',
  '  start([Client wakes]) --> check{Token still valid?}\n',
  '  check -- yes --> open[Open socket]\n',
  '  check -- no --> refresh[Refresh token]\n',
  '  refresh --> open\n',
  '  open --> ok([Connected])\n',
  '  open -. on 401 .-> refresh\n',
  '```\n\n',
  'The dotted edge is the fallback, and it is the one that almost never runs.'
]

/**
 * A reply carrying both block and inline mathematics, reached with a prompt
 * containing `math`.
 *
 * It deliberately also contains a PRICE — `$12` — because the whole of
 * `marked-math.ts`'s dollar defence is about not turning money into mathematics,
 * and a fixture without one cannot show that the defence holds.
 */
const MATH_REPLY_DELTAS: string[] = [
  'The backoff is a geometric series, so the total wait has a closed form.\n\n',
  '$$\n',
  '\\sum_{k=0}^{n-1} b \\cdot r^k = b \\cdot \\frac{1 - r^n}{1 - r}\n',
  '$$\n\n',
  'With $b = 250$ ms and $r = 2$, five attempts wait $3.75$ s in total.\n\n',
  'That is the same ceiling the guide quotes, and the plan costs $12 a month either way.'
]

/**
 * The events that belong to one turn's stream, and so carry its `turn_id`
 * (`tui_gateway/row_identity.py::TURN_STREAM_EVENTS`). Everything else on the
 * wire is session chrome that can fire with no turn running and names no turn.
 */
const TURN_STREAM_EVENTS: ReadonlySet<string> = new Set([
  'message.start',
  'message.delta',
  'message.interim',
  'message.complete',
  'reasoning.delta',
  'reasoning.available',
  'thinking.delta',
  'tool.generating',
  'tool.start',
  'tool.complete',
  'tool.output_risk',
  'error'
])

const DEFAULT_SCENARIO: Scenario = {
  replies: [
    {
      // Files a bot shares with its reply (`contract/outbox/`): two pictures, a clip, a sound, a PDF and two files
      // that are only ever downloaded. The note is what the gateway adds when a file could not be shared.
      match: 'share files',
      deltas: ['Here are the files. ', '(1 file could not be shared.)'],
      text: 'Here are the files. (1 file could not be shared.)',
      attachments: [
        { sample: 'image' },
        { sample: 'image2' },
        { sample: 'video' },
        { sample: 'audio' },
        { sample: 'pdf' },
        { sample: 'html' },
        { sample: 'zip' }
      ]
    },
    {
      match: 'mermaid',
      deltas: MERMAID_REPLY_DELTAS,
      text: MERMAID_REPLY_DELTAS.join('')
    },
    {
      match: 'math',
      deltas: MATH_REPLY_DELTAS,
      text: MATH_REPLY_DELTAS.join('')
    },
    {
      match: 'long',
      reasoning: ['Reading the ', 'refresh path.'],
      reasoningAvailable: 'Read the refresh path.',
      toolGenerating: true,
      deltas: LONG_REPLY_DELTAS,
      text: LONG_REPLY_DELTAS.join(''),
      // In the cut after "Let me read the file", which is where a real agent
      // would reach for one.
      toolAfterDeltas: 12,
      tool: {
        name: 'read_file',
        args: { path: 'gateway/auth.py' },
        summary: 'read gateway/auth.py',
        result: 'def refresh(...):'
      }
    },
    {
      // A turn that writes notes before it answers, as a real agent with interim
      // assistant messages on does: two tool rounds, then the reply.
      match: 'ledger',
      notes: [
        {
          text: 'Entry 90 is marked paid. Now the cent on the payables account: first see how it is booked.',
          tool: { name: 'terminal', args: { command: 'ledger show 17201' }, summary: 'ledger show 17201', result: 'ok' }
        },
        {
          text: 'Looking the transfer up through the API myself: the payout of 16-09.',
          tool: { name: 'terminal', args: { command: 'payouts get 16-09' }, summary: 'payouts get 16-09', result: 'ok' }
        }
      ],
      deltas: ['Everything checks out ', 'and nothing was filed.'],
      text: 'Everything checks out and nothing was filed.'
    },
    {
      // A provider that numbers its calls from `call_0` in every turn, as the real
      // ones do: ask twice and two different calls carry one id, which only the
      // call's row and position (`call_row_id` + `call_index`) tell apart. The
      // second ask says different words, so no two bubbles read alike.
      match: 'recount the entries again',
      notes: [
        {
          text: 'Counting once more, this time the file itself.',
          tool: {
            id: 'call_0',
            name: 'terminal',
            args: { command: 'wc -l ledger.csv' },
            summary: 'wc -l ledger.csv',
            result: '12'
          }
        }
      ],
      deltas: ['Counted again: ', 'still twelve entries.'],
      text: 'Counted again: still twelve entries.'
    },
    {
      match: 'recount',
      notes: [
        {
          text: 'Counting the entries in the ledger file.',
          tool: {
            id: 'call_0',
            name: 'terminal',
            args: { command: 'wc -l ledger.csv' },
            summary: 'wc -l ledger.csv',
            result: '12'
          }
        }
      ],
      deltas: ['Twelve ', 'entries.'],
      text: 'Twelve entries.'
    },
    {
      // Thinking first, then words: the order a real turn arrives in, and the order
      // the transcript's typing header has to survive.
      reasoning: ['Checking the ', 'README first.'],
      reasoningAvailable: 'Checked the README.',
      toolGenerating: true,
      deltas: ['Looking that up', ' for you.'],
      text: 'Looking that up for you.',
      tool: { name: 'read_file', args: { path: 'README.md' }, summary: 'read README.md', result: '# Hermie' }
    }
  ]
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000)
}

/** base64url(SHA-256(verifier)) — the `code_challenge` the client sent (RFC 7636 S256). */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

/**
 * One Kanban card, as `hermes_cli/kanban_db.py::Task` shapes it.
 *
 * Only the columns a client reads are modelled; upstream's dataclass carries
 * about forty. `parents` is here because it is what makes a `ready` move
 * REFUSABLE, which is the behaviour worth pinning.
 */
export interface FakeKanbanTask {
  id: string
  title: string
  body: string | null
  status: string
  assignee: string | null
  priority: number
  /** Epoch SECONDS, as every timestamp on this router is. */
  created_at: number
  /** Cards that must be done or archived before this one may become ready. */
  parents: string[]
  comments: { id: number; author: string; body: string; created_at: number }[]
}

/** One board on disk: a slug, a display name and its own pile of cards. */
export interface FakeKanbanBoard {
  slug: string
  name: string
  description: string
  tasks: FakeKanbanTask[]
}

/** `plugin_api.BOARD_COLUMNS` — fixed, server-owned, left to right. */
const KANBAN_COLUMNS = ['triage', 'todo', 'scheduled', 'ready', 'running', 'blocked', 'review', 'done']

/** `_apply_status` raises before anything else for this one. */
const KANBAN_RUNNING_REFUSAL = "Cannot set status to 'running' directly; use the dispatcher/claim path"

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/** A `data:` URL's payload, or bare base64, as bytes. */
function pictureBytes(source: string): Buffer {
  const comma = source.startsWith('data:') ? source.indexOf(',') : -1

  return Buffer.from(comma >= 0 ? source.slice(comma + 1) : source, 'base64')
}

/** What an image is, by its first bytes: PNG, JPEG, GIF or WebP; PNG when nothing says otherwise. */
function pictureContentType(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return 'image/jpeg'
  }

  if (bytes.subarray(0, 3).toString('latin1') === 'GIF') {
    return 'image/gif'
  }

  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }

  return 'image/png'
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  const raw = Buffer.concat(chunks).toString('utf8')

  if (!raw.trim()) {
    return {}
  }

  try {
    const parsed: unknown = JSON.parse(raw)

    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * A stamp as the fork writes it under `display_metadata.author` (and `replayed_by`): the person, and
 * `via` when an agent sent the row on their behalf (`contract/gateway/mcp.md`).
 */
interface InjectedAuthor {
  id: string
  name?: string
  via?: { kind: string; client: string }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A form body (`application/x-www-form-urlencoded`), as a browser posts one. */
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/** One `Set-Cookie` value of the staged provider: HttpOnly and Lax, like the real ones. */
function stagedCookie(name: string, value: string, { path, maxAge }: { path: string; maxAge: number }): string {
  return `${name}=${encodeURIComponent(value)}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`
}

function stagedPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
  <body style="font-family: system-ui; margin: 3rem auto; max-width: 30rem">
    <h1>${escapeHtml(title)}</h1>
    ${body}
  </body>
</html>`
}

function stagedLoginForm(error: string): string {
  return `${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/__idp/login">
      <input name="username" autocomplete="username">
      <input name="password" type="password" autocomplete="current-password">
      <button type="submit">Sign in</button>
    </form>`
}

function stagedVerifyForm(error: string): string {
  return `${error ? `<p role="alert">${escapeHtml(error)}</p>` : ''}
    <form method="post" action="/__idp/verify">
      <input name="code" inputmode="numeric" autocomplete="one-time-code">
      <button type="submit">Verify</button>
    </form>`
}

/**
 * The delivery command a `message_agent` hand-off spawns. The transcript engine
 * recognises bot-to-bot traffic from this string, so it is copied verbatim from
 * `tools/bot_mode_dm.py`.
 */
const DM_DELIVERY_COMMAND =
  '/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file ' +
  '/root/.hermes/dm/2f9c.json hermes -p writer chat -c "Bot Chat" -Q -q @/root/.hermes/dm/2f9c.json'

const DM_REPLY_PROCESS_TEXT = [
  '[IMPORTANT: Background process proc-2f9c completed (exit code 0).',
  `Command: ${DM_DELIVERY_COMMAND}`,
  'Output:',
  'Message from 🤖 Writer (@writer): Draft is ready, I pushed it to the shared folder.]'
].join('\n')

/**
 * One outbound `message_agent` plus, optionally, the `process_complete` row that
 * carries the answer back.
 *
 * A run of these is what the app rolls up into one "five messages to Researcher"
 * card, so the fixture has to produce the run the way a real transcript does: the
 * dispatch is a tool row with no result, and the reply is a separate row later,
 * joined by the recipient named in the background command. A dispatch without one
 * is a hand-off still in flight, which is the state the roll-up has to survive.
 */
function dispatchRunRows(
  target: string,
  index: number,
  message: string,
  reply: { text: string; rowId: number; timestamp: number } | null
): TranscriptRow[] {
  const suffix = `dm${index}`
  const command =
    `/usr/bin/python3 /opt/hermes/tools/bot_mode_dm.py --run-delivery query-file ` +
    `/root/.hermes/dm/${suffix}.json hermes -p ${target} chat -c "Bot Chat" -Q -q @/root/.hermes/dm/${suffix}.json`

  const rows: TranscriptRow[] = [
    {
      role: 'tool',
      name: 'message_agent',
      tool_id: `call_${suffix}`,
      context: `message_agent(${target})`,
      args: { target: `@${target}`, message }
    }
  ]

  if (reply !== null) {
    const display = `${target[0]?.toUpperCase()}${target.slice(1)}`

    rows.push({
      role: 'user',
      text: [
        `[IMPORTANT: Background process proc-${suffix} completed (exit code 0).`,
        `Command: ${command}`,
        'Output:',
        `Message from 🤖 ${display} (@${target}): ${reply.text}]`
      ].join('\n'),
      row_id: reply.rowId,
      timestamp: reply.timestamp,
      display_kind: 'process_complete',
      display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
    })
  }

  return rows
}

/**
 * The header `cron/scheduler_delivery.py::_deliver_to_bot_chat` splices in front
 * of a report it injects into a bot's chat, verbatim: the em dash, the quotes
 * around the job name and the BLANK line before the body are all part of it.
 *
 * The row carries no `display_kind` and no metadata, exactly as upstream writes
 * it — which is the whole reason the transcript engine has to recognise it from
 * the header. The name matches `job-inbox-scan`, the fixture cron that delivers
 * to `bot-chat:researcher`, so the report and the job that produced it agree.
 */
const CRON_DELIVERY_TEXT = [
  '[Cronjob "Source scan" output — scheduled job, not the user. Review it, act on ' +
    'anything that needs action, and summarize for the chat.]',
  '',
  '### Source scan — 4 new items',
  '',
  '| Source | Item | Why it matters |',
  '| --- | --- | --- |',
  '| docs.example.com | Retry semantics rewritten | Contradicts our own guide |',
  '| status.example.org | Two incidents, both closed | No action |',
  '| blog.example.net | Long post on session resume | Worth reading in full |',
  '| docs.example.com | Changelog for 1.4 | Three flags renamed |',
  '',
  'The first one needs a decision: our guide still documents the old behaviour.',
  '',
  'Nothing else is urgent. Next scan in four hours.'
].join('\n')

/**
 * A report long enough that the app has to fold it, with the three structures
 * that make folding awkward: a table, a fenced code block and a nested list.
 * Well over twenty rendered lines on purpose.
 */
const LONG_REPORT_MARKDOWN = [
  '## Retry semantics: what actually changed',
  '',
  'Short version: the backoff is now computed per attempt instead of per call, so a',
  'long-running request no longer inherits the delay of the one before it.',
  '',
  '| Behaviour | Before | After |',
  '| --- | --- | --- |',
  '| First retry delay | 1s | 1s |',
  '| Second retry delay | 1s | 2s |',
  '| Ceiling | none | 30s |',
  '| Jitter | none | ±20% |',
  '| Budget | per call | per attempt |',
  '',
  'Where this bites us:',
  '',
  '- The reconnect loop, which assumed a flat delay.',
  '  - It reads the delay once and caches it.',
  '  - Caching it is what makes the ceiling invisible.',
  '- The upload path, which retries on its own.',
  '  - Two retry budgets now overlap.',
  '    - Worst case is eight attempts where we documented three.',
  '- Nothing in the transcript path: it does not retry.',
  '',
  'The shape we should move to:',
  '',
  '```ts',
  'export function backoff(attempt: number): number {',
  '  const base = Math.min(2 ** attempt * 1000, 30_000)',
  '  // Jitter is not decoration: without it every client in a fleet retries',
  '  // on the same tick and the recovery looks like a second outage.',
  '  return base * (0.8 + Math.random() * 0.4)',
  '}',
  '',
  'export async function withRetries<T>(run: () => Promise<T>, attempts = 3): Promise<T> {',
  '  for (let attempt = 0; ; attempt += 1) {',
  '    try {',
  '      return await run()',
  '    } catch (error) {',
  '      if (attempt >= attempts - 1) {',
  '        throw error',
  '      }',
  '',
  '      await new Promise(resolve => setTimeout(resolve, backoff(attempt)))',
  '    }',
  '  }',
  '}',
  '```',
  '',
  '> The ceiling matters more than the curve. A retry that waits four minutes is',
  '> indistinguishable from a hang.',
  '',
  'I would change the reconnect loop first — it is the one a user can see.'
].join('\n')

/**
 * A 1×1 half-opaque red PNG. Deliberately NOT transparent: scaled up behind an
 * avatar's tint it paints a visible dot, which is how a run against this server
 * shows at a glance that `profiles.get_asset` was fetched and rendered rather
 * than quietly falling back to the generated initial.
 */
const AVATAR_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * The bytes behind `profiles.set_asset`'s `data`, which the contract describes
 * as "a data URL or bare base64". Both spellings have to land the same picture:
 * a client that pastes what `get_asset` answered sends the prefix, and one that
 * encoded a file itself usually does not.
 */
function decodeAssetData(data: string): Buffer {
  const comma = data.startsWith('data:') ? data.indexOf(',') : -1

  return Buffer.from(comma === -1 ? data : data.slice(comma + 1), 'base64')
}

/**
 * The type read from the BYTES, the way the contract's "PNG/JPEG/WebP, sniffed"
 * says it is read — never from what a data URL claimed it was. A client that
 * labels its JPEG `image/png` is the whole reason a sniff exists, and a fake
 * that echoed the label back would make that client look correct here and
 * broken against a real gateway.
 *
 * Anything the three magic numbers do not cover falls back to `image/png`,
 * which is what a viewer assumes when nothing better is named.
 */
function sniffImageMime(bytes: Buffer): string {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }

  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp'
  }

  return 'image/png'
}

/**
 * A canonical Bot Chat with enough shape to exercise the whole engine: a tool
 * row, an outbound `message_agent` dispatch and the `process_complete` row that
 * carries the teammate's answer back.
 */
/**
 * A JSON-RPC error with the gateway's OWN code, not the generic -32603.
 *
 * Upstream refuses things with four- and five-digit codes — 4018 for "wrong
 * method for this command", 5030 for a worker that died — and a client that
 * branches on which of those it got could not be tested against a server that
 * only ever sent one.
 */
export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string,
    /** The error's `data`, when the contract gives it one (4034 names its `reason` there). */
    readonly data?: Record<string, unknown>
  ) {
    super(message)
    this.name = 'RpcFault'
  }
}

/**
 * The words `config.set {key:'fast'}` takes, and the mode each one means.
 *
 * Upstream parses this key against a word list of its own
 * (`methods_config_set.py::_set_fast`, `_FAST_WORDS`) rather than against the
 * boolean list every other switch uses, and it refuses anything outside it with
 * 4002. A fake that stored whatever it was handed hid that completely: a client
 * sending `true` — which is a perfectly good `yolo` — looked like it worked here
 * and failed against every real gateway.
 *
 * `status` and `toggle` are left out on purpose. They are READ and FLIP verbs
 * upstream answers without setting a named mode, and nothing in the app sends
 * either.
 */
const FAST_MODES: Record<string, string> = {
  fast: 'fast',
  on: 'fast',
  normal: 'normal',
  off: 'normal',
  auto: 'auto',
  cold: 'cold'
}

/**
 * `_BOOL_WORDS`: what upstream reads as yes and no for every switch that is not
 * fast mode.
 *
 * Read rather than compared against one spelling. This server used to decide
 * `yolo` with `value === 'on' || value === '1'`, so a client sending `true` —
 * which upstream accepts, and which the options sheet sends — switched yolo on
 * and was told in the same answer that it was still off. The app believed the
 * answer, because believing the gateway is the whole point of a fake.
 */
const TRUE_WORDS = new Set(['1', 'on', 'true', 'yes'])

/** Does this value mean yes? Anything unrecognised means no, as upstream has it. */
function boolWord(value: string | undefined): boolean {
  return TRUE_WORDS.has((value ?? '').trim().toLowerCase())
}

/**
 * `hermes_constants.py::is_truthy_value`, which is what every `bool | str`
 * parameter in the contract goes through.
 *
 * The contract types these as `boolean | string | null` and means it: the REST
 * twin of `profiles.create` takes form values, so `"true"` has to mean the same
 * thing as `true`. A fake that only accepted the boolean would let a client
 * through that a real gateway reads as false.
 */
function isTruthy(value: unknown): boolean {
  return value === true || (typeof value === 'string' && boolWord(value))
}

/** The stored mode for one `config.set` value, or a 4002 like upstream's. */
function fastMode(value: string): string {
  const mode = FAST_MODES[value.trim().toLowerCase()]

  if (!mode) {
    throw new RpcFault(4002, `unknown fast mode: ${value}`)
  }

  return mode
}

/** Catalogue names this server treats as SKILLS: `slash.exec` refuses them. */
const FAKE_SKILL_COMMANDS = new Set(['release-notes'])

/** Built-ins upstream reroutes into `command.dispatch` from inside `slash.exec`. */
const FAKE_DISPATCH_COMMANDS = new Set(['queue', 'q', 'undo'])

/**
 * A worker command's text, shaped like the real thing rather than like one
 * cheerful line: `/status` answers a block and `/help` answers a table, and the
 * client has to put a multi-line answer somewhere a reader can fold it away.
 */
function slashOutput(name: string, arg: string): string {
  switch (name) {
    case 'model':
      return arg ? `  ✓ Model set to '${arg}' (this session)` : 'Current model: example-provider/example-model'

    case 'reasoning':
      return arg
        ? `  ✓ Reasoning effort set to '${arg}' (this session — use --global to persist)`
        : 'Current reasoning effort: medium'

    case 'yolo':
      return '  ⚡ YOLO mode ON — all commands auto-approved. Use with caution.'

    case 'status':
      return [
        'Hermes TUI Status',
        '',
        'Session ID: bot-chat-fake',
        'Model: example-provider/example-model',
        'Tokens: 0',
        'Agent Running: No'
      ].join('\n')

    case 'help':
      return [
        '+-------------------------------------------------------+',
        '|                   Available Commands                  |',
        '+-------------------------------------------------------+',
        '',
        '  ── Session ──',
        '    /status         - Show session, model, token, and context info',
        '',
        '  ── Configuration ──',
        '    /model          - Switch model (session-scoped)',
        '    /reasoning      - Set the reasoning effort',
        '    /yolo           - Toggle YOLO mode'
      ].join('\n')

    default:
      return `${name} is not a real command on a fake gateway, but it ran.`
  }
}

/**
 * `command.dispatch`'s structured answer.
 *
 * The union is the point: a client that only reads `output` sees nothing here,
 * and a client that renders `message` shows the reader model-facing scaffolding
 * it was never meant to see.
 */
function dispatchCommand(name: string, arg: string): Record<string, unknown> {
  switch (name) {
    case 'release-notes':
      return {
        type: 'skill',
        name: 'release-notes',
        display: arg ? `/release-notes ${arg}` : '/release-notes',
        message: [
          '[IMPORTANT: The user has invoked the "release-notes" skill, indicating they want you to follow its instructions.]',
          '',
          '---',
          'name: release-notes',
          'description: Draft release notes.',
          '---',
          '',
          'Read the changelog, group the entries, and write them up.',
          arg
        ]
          .filter(Boolean)
          .join('\n')
      }

    case 'q':
    case 'queue':
      return { type: 'send', message: arg, notice: arg ? '' : 'Nothing queued.' }

    case 'undo':
      return { type: 'prefill', message: 'the message being taken back', notice: '↶ rewound one turn' }

    default:
      return { type: 'exec', output: slashOutput(name, arg) }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** `_MANAGED_FILE_MAX_BYTES` in `hermes_cli/web_server.py`. */
const MANAGED_FILE_MAX_BYTES = 100 * 1024 * 1024

/** `_ATTACH_BYTES_MAX_BYTES` in `tui_gateway/prompt_attachments.py`: the cap of `image.attach_bytes`. */
const ATTACH_BYTES_MAX_BYTES = 25 * 1024 * 1024

/** `_IMAGE_EXTENSIONS` in `hermes_cli/cli_terminal_input.py`: what `image.attach_bytes` accepts. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.svg', '.ico'])

/**
 * `_sniff_image_ext`: the filename's extension when it has one, else the magic
 * bytes (WebP's RIFF container, PNG, JPEG, GIF, BMP), else `.png`.
 */
function sniffImageExtension(bytes: Buffer, filename: string): string {
  const base = filename.split(/[/\\]/u).pop() ?? ''
  const dot = base.lastIndexOf('.')

  if (dot > 0) {
    return base.slice(dot).toLowerCase()
  }

  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return '.webp'
  }

  const head = bytes.subarray(0, 8)

  if (head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return '.png'
  }

  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return '.jpg'
  }

  const text = head.toString('latin1')

  if (text.startsWith('GIF87a') || text.startsWith('GIF89a')) {
    return '.gif'
  }

  return text.startsWith('BM') ? '.bmp' : '.png'
}

interface MultipartForm {
  fields: Record<string, string>
  file: { filename: string; contentType: string; bytes: number; sha256: string; content: Buffer } | null
}

/**
 * Enough of RFC 7578 to read what the upload route declares: a few small text
 * fields and one file part: its size, its SHA-256 and its bytes.
 *
 * Deliberately not a general parser and deliberately not a dependency.
 */
async function readMultipart(req: IncomingMessage): Promise<MultipartForm> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(req.headers['content-type'] ?? '')
  const marker = boundary?.[1] ?? boundary?.[2]

  if (!marker) {
    throw new Error('Multipart body has no boundary')
  }

  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  const form: MultipartForm = { fields: {}, file: null }
  // `binary` (latin1) is one JS character per byte, so a part's length IS its
  // byte count and a split on the boundary cannot cut a multi-byte sequence.
  const parts = Buffer.concat(chunks).toString('binary').split(`--${marker}`)

  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n')

    if (split === -1) {
      // The preamble and the closing `--`: neither is a part.
      continue
    }

    const headers = part.slice(0, split)
    const name = /name="([^"]*)"/i.exec(headers)?.[1]

    if (!name) {
      continue
    }

    // A part's body ends with the CRLF that precedes the next boundary.
    const raw = part.slice(split + 4).replace(/\r\n$/, '')
    const filename = /filename="([^"]*)"/i.exec(headers)?.[1]

    if (filename === undefined) {
      form.fields[name] = Buffer.from(raw, 'binary').toString('utf8')

      continue
    }

    form.file = {
      filename,
      contentType: /content-type:\s*([^\r\n;]+)/i.exec(headers)?.[1]?.trim() || 'application/octet-stream',
      bytes: raw.length,
      sha256: createHash('sha256').update(raw, 'binary').digest('hex'),
      content: Buffer.from(raw, 'binary')
    }
  }

  return form
}

/**
 * `tools/cronjob_job_args.py::_format_job` — the row `cron.manage list` answers
 * with. Deliberately carries NO `profile`: the socket answers out of one
 * profile's store, so a row has no owner to name, and a client that wants to
 * know has to use the REST list. Dropping it here is what makes a client that
 * lists over the socket and then mutates fail in the test rather than in the app.
 */
function formatCronJob(job: CronJob): Record<string, unknown> {
  return {
    job_id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt_preview: job.prompt.slice(0, 120),
    deliver: job.deliver,
    enabled: job.enabled,
    state: job.state,
    next_run_at: job.next_run_at,
    last_run_at: job.last_run_at,
    last_status: job.last_status,
    last_error: job.last_error,
    paused_at: job.paused_at,
    paused_reason: job.paused_reason,
    repeat: job.repeat,
    skills: job.skills,
    model: job.model
  }
}

/**
 * `hermes_cli/web_server_cron.py::_annotate_cron_job` — what the REST routes
 * add to a stored job on the way out. The dashboard reads `profile` off this,
 * and so does Hermie: it is the only surface that says which store a job came
 * from, because the stored record itself does not know.
 *
 * `runs` is dropped: the run sessions live behind `/runs` on a real gateway,
 * not inside the job.
 */
function annotateCronJob(job: CronJob): Record<string, unknown> {
  const { runs: _runs, ...stored } = job

  return {
    ...stored,
    profile: job.profile,
    profile_name: job.profile,
    hermes_home: `/root/.hermes/profiles/${job.profile}`,
    is_default_profile: job.profile === 'default',
    scheduler_heartbeat_age_s: 4
  }
}

/**
 * A cron run: an ordinary session whose id is `cron_{job_id}_{timestamp}`.
 *
 * That is the whole binding between a job and its runs on a real gateway — the
 * id prefix plus `source='cron'` — so the fake keeps run transcripts in the
 * same session map as chats and answers `session.history` for them unchanged.
 */
function makeCronRunSession(
  jobId: string,
  startedAt: number,
  prompt: string,
  answer: string,
  profile: string
): FakeSession {
  const id = `cron_${jobId}_${startedAt}`

  return {
    id,
    storedId: id,
    profile,
    title: `Cron: ${jobId}`,
    hidden: false,
    seq: 0,
    ring: [],
    messages: [
      { role: 'user', text: prompt, row_id: 1, timestamp: startedAt },
      {
        role: 'tool',
        name: 'read_file',
        tool_id: `call_${jobId}_${startedAt}`,
        context: 'read_file(status.md)',
        args: { path: 'status.md' }
      },
      { role: 'assistant', text: answer, row_id: 2, timestamp: startedAt + 12 }
    ]
  }
}

/**
 * `historyRows` worth of plausible back-history, oldest first.
 *
 * Four shapes on a cycle of four, so a run of any length holds them in a fixed
 * ratio: a short exchange, a paragraph long enough to wrap several times, a
 * fenced code block and a tool call with a result. Row ids and timestamps run
 * backwards from the fixture's own base so the real fixture stays newest and
 * the day separators fall where a week of conversation would put them.
 */
function historyRows(profile: string, count: number, base: number): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  // One row a minute, ending an hour before the fixture starts.
  const start = base - 3600 - count * 60

  for (let index = 0; index < count; index += 1) {
    const at = start + index * 60
    const rowId = -(count - index)

    switch (index % 4) {
      case 0:
        rows.push({ role: 'user', text: `Question ${index + 1}: what changed in the retry path?`, row_id: rowId, timestamp: at }) // prettier-ignore
        break

      case 1:
        rows.push({
          role: 'assistant',
          text:
            `Answer ${index + 1}. The backoff is computed per attempt rather than per call, so a long ` +
            'request no longer inherits the delay of the one before it. The ceiling is thirty seconds ' +
            'and the jitter is twenty per cent either way, which matters more than the curve: a fleet ' +
            'that retries on the same tick turns a recovery into a second outage.',
          row_id: rowId,
          timestamp: at
        })
        break

      case 2:
        rows.push({
          role: 'assistant',
          text: [
            'Here is the shape:',
            '',
            '```ts',
            `export const attempt${index} = (n: number) => 2 ** n * 1000`,
            '```'
          ].join('\n'),
          row_id: rowId,
          timestamp: at
        })
        break

      default:
        rows.push({
          role: 'tool',
          name: 'read_file',
          tool_id: `call_history_${profile}_${index}`,
          context: `read_file(notes/${index}.md)`,
          args: { path: `notes/${index}.md` }
        })
    }
  }

  return rows
}

/**
 * The canonical Bot Chat title.
 *
 * A registry key rather than a label: upstream resolves a profile's forever-chat
 * with `db.get_session_by_title('Bot Chat')`, which answers ONE row, and guards
 * that row against being renamed while it is hidden.
 */
const CANONICAL_CHAT_TITLE = 'Bot Chat'

function makeSession(profile: string, title: string, history = 0): FakeSession {
  const storedId = `stored-${profile}-${randomUUID().slice(0, 8)}`
  const base = nowSeconds() - 600

  const messages: TranscriptRow[] = [
    ...(history > 0 ? historyRows(profile, history, base) : []),
    { role: 'user', text: 'Introduce yourself in one line.', row_id: 1, timestamp: base },
    {
      role: 'assistant',
      text: `I am ${profile}, at your service.`,
      reasoning: 'Keep it to one line.',
      row_id: 2,
      timestamp: base + 1
    },
    {
      role: 'tool',
      name: 'read_file',
      tool_id: `call_read_${profile}`,
      context: 'read_file(SOUL.md)',
      args: { path: 'SOUL.md' }
    }
  ]

  if (profile === 'researcher') {
    messages.push(
      {
        role: 'tool',
        name: 'message_agent',
        tool_id: 'call_dm_1',
        context: 'message_agent(writer)',
        args: { target: '@writer', message: 'Can you draft the announcement?' }
      },
      {
        role: 'user',
        text: DM_REPLY_PROCESS_TEXT,
        row_id: 3,
        timestamp: base + 60,
        display_kind: 'process_complete',
        display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
      },
      { role: 'assistant', text: 'Thanks — I will fold that in.', row_id: 4, timestamp: base + 61 }
    )

    // The scheduled job's report, exactly as the scheduler injects it: a plain
    // `user` row with NO display_kind, recognised only by its header. This is the
    // row Hermie used to draw as the owner's own bubble with raw markdown in it.
    messages.push({ role: 'user', text: CRON_DELIVERY_TEXT, row_id: 5, timestamp: base + 120 })

    // …and the summary the header asked for: long enough to need folding, with a
    // table, a fenced code block and a nested list inside it.
    messages.push({ role: 'assistant', text: LONG_REPORT_MARKDOWN, row_id: 6, timestamp: base + 140 })
  }

  if (profile === 'writer') {
    // A RUN of dispatches to the same target, back to back, because the app shows
    // one roll-up instead of five near-identical cards. The joined replies emit no
    // item of their own, so all five stay consecutive in the projection; the last
    // two are still in flight and have no answer yet.
    //
    // It lives in the writer's chat rather than the researcher's so that the two
    // DM fixtures stay separable: one exchange to read, one run to collapse.
    messages.push(
      ...dispatchRunRows('researcher', 3, 'Which sources back the retry claim?', {
        text: 'Two: the changelog and the long post. I sent both links.',
        rowId: 3,
        timestamp: base + 70
      }),
      ...dispatchRunRows('researcher', 4, 'Is the ceiling documented anywhere upstream?', {
        text: 'Only in the changelog, not in the guide.',
        rowId: 4,
        timestamp: base + 80
      }),
      ...dispatchRunRows('researcher', 5, 'Any incident that was actually caused by the old backoff?', {
        text: 'One, last quarter. I noted the reference.',
        rowId: 5,
        timestamp: base + 90
      }),
      ...dispatchRunRows('researcher', 6, 'Can you re-check the second source before I quote it?', null),
      ...dispatchRunRows('researcher', 7, 'And whether the guide has an owner listed.', null)
    )
  }

  return {
    id: `runtime-${randomUUID().slice(0, 8)}`,
    storedId,
    profile,
    title,
    // Canonical chats are born hidden — `session.create {hidden: true}` on every
    // client that mints one, this app's included.
    hidden: title === CANONICAL_CHAT_TITLE,
    seq: 0,
    ring: [],
    messages
  }
}

function initialState(options: FakeGatewayOptions): FakeGatewayState {
  const history = Math.max(0, Math.trunc(options.historyRows ?? 0))
  const researcher = makeSession('researcher', CANONICAL_CHAT_TITLE, history)
  const writer = makeSession('writer', CANONICAL_CHAT_TITLE, history)
  const sessions = new Map<string, FakeSession>()

  for (const session of [researcher, writer]) {
    sessions.set(session.storedId, session)
  }

  const cronJobs = initialCronJobs()

  for (const job of cronJobs) {
    for (const run of job.runs) {
      const session = makeCronRunSession(
        job.id,
        run.started_at,
        job.prompt,
        run.end_reason === 'done' ? 'Done — nothing needs your attention.' : 'The check did not complete.',
        job.profile
      )

      session.id = run.id
      session.storedId = run.id
      sessions.set(run.id, session)
    }
  }

  /**
   * Writer deliberately has NO avatar.
   *
   * Every profile used to answer `has_avatar: true`, so the generated-initial
   * fallback — the thing a real gateway shows for most bots, because uploading a
   * picture is opt-in — was unreachable from a run against this server and went
   * unlooked-at for two passes. One bot with a picture and one without is what
   * makes both paths visible side by side in the same list.
   */
  const hasAvatar = (profile: string): boolean => profile !== 'writer'

  /** Read once: every profile row carries the same answer. */
  const advert = advertOf(options)

  /**
   * `is_default` marks the profile `hermes serve` is running as.
   *
   * It matters to more than a badge in the roster: ADR-0016 puts Hermie's
   * app-wide section (`hermie-app`) on the default profile, because that is the
   * one row every client can find without being told which bot to ask. A roster
   * with no default row is a gateway with nowhere to keep app-wide settings, and
   * the fake answered exactly that until this round — so the client's
   * local-only fallback was the only path a test could ever reach.
   */
  const profileRow = (session: FakeSession, description: string): ProfileRow => ({
    name: session.profile,
    path: `/root/.hermes/profiles/${session.profile}`,
    is_default: session.profile === researcher.profile,
    description,
    display_name: session.profile[0]?.toUpperCase() + session.profile.slice(1),
    model: 'example-provider/example-model',
    provider: 'example-provider',
    has_avatar: hasAvatar(session.profile),
    ui_meta_revisions: hasAvatar(session.profile) ? { avatar: 1 } : {},
    canonical_session: {
      id: session.storedId,
      resolved_id: session.storedId,
      title: session.title,
      preview: session.messages[session.messages.length - 1]?.text ?? '',
      last_active: nowSeconds() - 60,
      message_count: session.messages.length
    },
    /*
      `hermes-bots` is the marker another tool owns, and it sits on every
      profile. It is here so a client that writes its own key can be caught
      wiping it: ADR-0016's per-key compare-and-swap is the only thing that
      stops a settings write from un-botting every profile it touches.
    */
    ui_meta: {
      'hermes-bots': {},
      ...(session.profile === researcher.profile && (options.pushRegistrations || options.pushSeen)
        ? {
            'hermie-app': {
              v: 1,
              push: { registrations: options.pushRegistrations ?? {}, seen: options.pushSeen ?? {} }
            }
          }
        : {}),
      /*
        The plugin's own key, on the default profile, written by the gateway
        side and never by the app. It carries its own revision, which is the
        point of it being a separate key: a write from behind `hermie-app`
        would make the app's next settings write fail.
      */
      ...(session.profile === researcher.profile && advert ? { 'hermie-plugin': advert } : {})
    }
  })

  return {
    auth: options.auth ?? 'none',
    token: options.token ?? 'fake-session-token',
    closeCode: options.closeCode ?? 4401,
    replayEpoch: randomUUID(),
    accessTokens: new Set<string>(),
    ticketsMinted: 0,
    ticketsConsumed: 0,
    tokenExchanges: 0,
    refreshCalls: 0,
    connections: 0,
    rejectedUpgrades: 0,
    rejectNextUpgrades: 0,
    failNextTicketMints: 0,
    pictureRequests: [],
    attachedImageRequests: [],
    outboxFiles: new Map(),
    outboxRequests: [],
    ticketMintsFailed: 0,
    audioRequests: [],
    audioStreamsCancelled: 0,
    spentRefreshTokens: new Set<string>(),
    refreshReuseAttempts: 0,
    revokeCalls: [],
    eventsSinceCalls: [],
    serverRequestAnswers: [],
    clientCapabilities: [],
    methodLog: [],
    truncateNextReplay: false,
    ownedElsewhere: new Map<string, string>(),
    promptFailure: null,
    hangMethods: new Set<string>(),
    sessions,
    profiles: [profileRow(researcher, 'Finds things out.'), profileRow(writer, 'Writes things down.')],
    /*
      Seeded so a browser has something to draw and a graph has something to
      cluster on: the capitalised phrases, the `@handle` and the ISO date are
      the four kinds of topic the plugin mints, and two entries deliberately
      share one so an edge between entries exists.

      **Every proper noun here is invented.** These entries used to name this
      repository's owner, his company, his city and a colleague, and the memory
      graph draws each of them as a labelled node — which made the one fixture
      in the project that cannot be shown to anybody. It is the screen a store
      listing most wants (`design/store/screenshots/ios/`), and the reason
      `docs/CONTRIBUTING.md` says a published capture must contain no real
      gateway, bot or person. Keep the SHAPE when editing: one capitalised
      organisation, one `@handle`, one ISO date, one place, one person.
    */
    memory: new Map([
      [
        researcher.profile,
        {
          memory: [
            'Northwind Trading invoices on the first of the month.',
            'The tailnet address is the one to use from outside; @dana set it up on 2026-09-21.',
            'Prefers footnotes to parentheses.'
          ],
          user: ['Robin works from Lisbon and answers fastest in the morning.', 'Reads Dutch and English.']
        }
      ],
      [writer.profile, { memory: ['Drafts open with the verb, never with the subject.'], user: [] }]
    ]),
    profileCapabilities: new Map<string, FakeProfileCapabilities>([
      // `researcher` has never been edited: no toolset pin, nothing disabled.
      // That is the state a fresh profile is really in, and the one a client
      // that treats "unpinned" as "everything off" gets wrong.
      [researcher.profile, { disabledSkills: new Set(), pinnedToolsets: null, disabledMcpServers: new Set() }],
      // `writer` has been edited, so every section is in its non-default state.
      [
        writer.profile,
        {
          disabledSkills: new Set(['pdf']),
          pinnedToolsets: new Set(['files', 'web']),
          disabledMcpServers: new Set(['weather'])
        }
      ]
    ]),
    profileSkills: new Map<string, string[]>([
      [researcher.profile, ['pdf', 'docx', 'web-search']],
      [writer.profile, ['pdf', 'docx']]
    ]),
    /*
      Three servers, one per outcome the MCP page has to draw: an http one that
      probes clean, an http one behind OAuth with no token on disk (which is the
      "needs auth" row, and the one upstream deliberately reports as ok:false
      even though its tools/list would answer anonymously), and a stdio one
      whose command is not installed. `weather` is also the server `writer` has
      switched off, so the per-bot list and the gateway-wide list disagree about
      it on purpose.
    */
    mcpServers: [
      {
        name: 'files',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
        env: [],
        auth: null,
        oauthTokensPresent: false,
        enabled: true,
        tools: [
          { name: 'read_file', description: 'Read a file from disk.' },
          { name: 'write_file', description: 'Write a file to disk.' }
        ]
      },
      {
        name: 'calendar',
        transport: 'http',
        url: 'https://calendar.example.test/mcp',
        args: [],
        env: [],
        auth: 'oauth',
        oauthTokensPresent: false,
        enabled: true,
        tools: [{ name: 'list_events', description: 'List events in a range.' }]
      },
      {
        name: 'weather',
        transport: 'stdio',
        command: 'weather-mcp',
        args: [],
        env: ['WEATHER_API_KEY'],
        auth: null,
        oauthTokensPresent: false,
        enabled: true,
        tools: null,
        probeError: 'spawn weather-mcp ENOENT'
      }
    ],
    mcpReloadConfirm: true,
    mcpReloads: 0,
    mcpOauthFlows: new Map<string, FakeOauthFlow>(),
    mcpSecrets: new Map<string, { envVar: string; value: string }>(),
    skillsInstalled: [],
    connectors: [
      { connector: 'gmail', connected: true, enabled: true, connectionStatus: 'active', statusReason: null },
      {
        connector: 'notion',
        connected: false,
        enabled: true,
        connectionStatus: 'not_connected',
        statusReason: null
      },
      {
        connector: 'slack',
        connected: false,
        enabled: false,
        connectionStatus: 'failed',
        statusReason: 'the workspace revoked the token'
      }
    ],
    kanbanBoards:
      options.kanban === false
        ? null
        : [
            {
              slug: 'default',
              name: 'Default',
              description: '',
              tasks: [
                {
                  id: 't_aa11bb22',
                  title: 'Write the release notes',
                  body: 'Pull them from the changelog.',
                  status: 'todo',
                  assignee: null,
                  priority: 0,
                  created_at: 1_760_000_000,
                  parents: [],
                  comments: [{ id: 1, author: 'writer', body: 'Started on this.', created_at: 1_760_000_100 }]
                },
                {
                  id: 't_cc33dd44',
                  title: 'Ship the build',
                  body: null,
                  status: 'todo',
                  assignee: 'writer',
                  priority: 2,
                  // Gated on the notes above, which is what makes a `ready` move refusable.
                  created_at: 1_760_000_050,
                  parents: ['t_aa11bb22'],
                  comments: []
                },
                {
                  id: 't_ee55ff66',
                  title: 'Tidy the worktrees',
                  body: null,
                  status: 'running',
                  assignee: 'writer',
                  priority: 0,
                  created_at: 1_760_000_075,
                  parents: [],
                  comments: []
                }
              ]
            },
            { slug: 'sprint', name: 'Sprint', description: 'This fortnight', tasks: [] }
          ],
    kanbanDispatches: 0,
    connectorsUnavailable: options.connectors === false,
    connectorOps: new Map<string, FakeConnectorOp>(),
    connectorSeq: 0,
    connectionResponses: [],
    runningSessions: new Set<string>(),
    sessionConfig: new Map<string, Record<string, string>>(),
    pendingApprovals: new Map<string, { session_id: string; payload: Record<string, unknown> }>(),
    openServerRequests: new Map(),
    profileAssets: new Map<string, { mime: string; bytes: Buffer }>(),
    profileSouls: new Map<string, string>(),
    deniedMethods: new Map<string, { code: number; message: string }>(),
    usage: emptyUsageStage(),
    stopAll: { unsupported: false, notAllowed: 0, failed: 0 },
    vault: emptyVaultStage(),
    approvals: emptyApprovalGrantsStage(),
    attachedImages: [],
    uploadedFiles: new Map(),
    liveSubagents: new Map<string, LiveSubagent>(),
    agentProcesses: new Map<string, { session_id: string; command: string; status: string; startedAt: number }>(),
    cronGatewayRunning: true,
    cronLaunchProfile: LAUNCH_PROFILE,
    cronJobs
  }
}

/**
 * The rows the list has to draw: a healthy one with run history, one whose last
 * attempt failed (with the exception-wrapped `last_error` the scheduler really
 * writes), and a paused one — all three in the launch profile — plus one that
 * lives in `researcher`'s own cron store.
 *
 * That last one is the whole point of the fixture set. It is invisible to
 * `cron.manage {action:'list'}` without a `profile`, exactly as on a real
 * gateway, so a client that lists over the socket silently loses it while the
 * dashboard shows it.
 */
/**
 * One run row, with the keys a session row really carries.
 *
 * `hermes_state_portability.py::list_sessions_rich` hands back the whole
 * sessions row plus `preview` and `last_active`, and the cron route stamps
 * `is_active`, `archived` and `profile` on top. The outcome lives in
 * `end_reason`; there is no status column to read.
 */
function cronRunRow(row: {
  id: string
  title: string
  profile: string
  started_at: number
  ended_at: number
  preview: string
  end_reason?: string
}): CronRunRow {
  return {
    id: row.id,
    source: 'cron',
    title: row.title,
    end_reason: row.end_reason ?? 'done',
    started_at: row.started_at,
    ended_at: row.ended_at,
    last_active: row.ended_at,
    message_count: 3,
    preview: row.preview,
    archived: false,
    is_active: false,
    profile: row.profile
  }
}

function initialCronJobs(): CronJob[] {
  const hourAgo = Math.floor(Date.now() / 1000) - 3_600
  const yesterday = hourAgo - 86_400

  return [
    {
      id: 'job-heartbeat',
      profile: LAUNCH_PROFILE,
      name: 'VM heartbeat',
      schedule: 'every 2h',
      prompt: 'Check the VM, summarize disk and memory, and flag anything unusual.',
      deliver: 'local',
      enabled: true,
      state: 'scheduled',
      next_run_at: new Date(Date.now() + 7_200_000).toISOString(),
      last_run_at: new Date(hourAgo * 1000).toISOString(),
      last_status: 'ok',
      last_error: null,
      paused_at: null,
      paused_reason: null,
      repeat: null,
      skills: [],
      model: null,
      runs: [
        cronRunRow({
          id: `cron_job-heartbeat_${hourAgo}`,
          title: 'VM heartbeat',
          profile: LAUNCH_PROFILE,
          started_at: hourAgo,
          ended_at: hourAgo + 42,
          preview: 'Done — nothing needs your attention.'
        }),
        // The one that did NOT finish. A run history where every row says the
        // same word cannot show that the row is reading anything at all.
        cronRunRow({
          id: `cron_job-heartbeat_${yesterday}`,
          title: 'VM heartbeat',
          profile: LAUNCH_PROFILE,
          started_at: yesterday,
          ended_at: yesterday + 38,
          end_reason: 'interrupted',
          preview: 'The check did not complete.'
        })
      ]
    },
    {
      id: 'job-digest',
      profile: LAUNCH_PROFILE,
      name: 'Weekly digest',
      schedule: 'every friday 16:30',
      prompt: 'Write a short digest of this week for the team.',
      deliver: 'bot-chat:researcher',
      enabled: true,
      state: 'scheduled',
      next_run_at: new Date(Date.now() + 86_400_000).toISOString(),
      last_run_at: new Date((hourAgo - 7_200) * 1000).toISOString(),
      last_status: 'error',
      last_error: "RuntimeError: Cron job 'Weekly digest' has no model configured. Set one with `hermes cron edit`.",
      paused_at: null,
      paused_reason: null,
      repeat: null,
      skills: ['research'],
      model: null,
      runs: []
    },
    {
      // The profile-owned one: `cron.manage` without a `profile` cannot see it.
      id: 'job-inbox-scan',
      profile: 'researcher',
      name: 'Source scan',
      schedule: 'every 4h',
      prompt: 'Scan the watched sources and note anything new worth reading.',
      deliver: 'bot-chat:researcher',
      enabled: true,
      state: 'scheduled',
      next_run_at: new Date(Date.now() + 14_400_000).toISOString(),
      last_run_at: new Date((hourAgo - 1_800) * 1000).toISOString(),
      last_status: 'ok',
      last_error: null,
      paused_at: null,
      paused_reason: null,
      repeat: null,
      skills: ['research'],
      model: null,
      runs: []
    },
    {
      id: 'job-cleanup',
      profile: LAUNCH_PROFILE,
      name: 'Inbox cleanup',
      schedule: 'every day at 6pm',
      prompt: 'Archive anything already answered and list what is still open.',
      deliver: 'local',
      enabled: false,
      state: 'paused',
      next_run_at: null,
      last_run_at: null,
      last_status: null,
      last_error: null,
      paused_at: new Date((hourAgo - 86_400) * 1000).toISOString(),
      paused_reason: 'Paused from the desktop app',
      repeat: null,
      skills: [],
      model: null,
      runs: []
    }
  ]
}

export async function startFakeGateway(options: FakeGatewayOptions = {}): Promise<FakeGateway> {
  const state = initialState(options)
  const scenario = options.scenario ?? DEFAULT_SCENARIO
  const ringSize = options.replayRingSize ?? 512
  const streamDelayMs = options.streamDelayMs ?? 2
  const subagentStepMs = options.subagentStepMs ?? 900
  const steerPersistsRow = options.steerPersistsRow ?? true
  const rowIdentity = options.rowIdentity ?? true
  const version = options.version ?? '0.21.3-fake'

  const tickets = new Map<string, { expiresAt: number; userId: string; provider: string; identity?: Identity }>()
  /** Issued loopback codes; `reauth` is the re-authentication grant a code completes instead of signing in. */
  const codes = new Map<string, { challenge: string; provider: string; reauth?: string }>()
  const stagedIdp = options.idp === 'staged'
  const stagedTotpCode = options.stagedTotpCode ?? '246810'
  /** Staged provider: pending native sign-ins by broker id, as `native_flow.register_pending` keeps them. */
  const brokers = new Map<
    string,
    {
      challenge: string
      provider: string
      redirectUri: string
      clientState: string
      idpState: string
      reauth?: string
    }
  >()
  /** Staged provider: authorization requests by id, each with the state and redirect it echoes. */
  const idpRequests = new Map<string, { state: string; redirectUri: string }>()
  /** Staged provider: password logins waiting for their code; burned on the first try. */
  const idpChallenges = new Set<string>()
  const idpSessions = new Set<string>()
  /** Staged provider: issued codes, by the state they were issued for. */
  const idpCodes = new Map<string, string>()
  const refreshTokens = new Map<string, { provider: string; userId: string }>()
  const sockets = new Set<WebSocket>()
  /** The `confirm` levels each live socket offered in `client.capabilities`. */
  const confirmLevels = new Map<WebSocket, string[]>()
  /**
   * The live sockets that showed `confirm_fields: true` with at least one level (exactly `true`: anything else
   * does not count). The gated path keeps its own record (`ConfirmGate.showsFields`); this is the permissive one.
   */
  const confirmFields = new Set<WebSocket>()
  const pendingServerRequests = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  let serverRequestSequence = 0

  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer)
      fn()
    }, ms)
    timers.add(timer)
    timer.unref?.()
  }
  /** `later`, under the name a reply's own guarded `later` delegates to. */
  const laterAll = later
  /** Per stored session: moved on by `session.interrupt`, which drops the rest of the running reply. */
  const streamEpochs = new Map<string, number>()
  /** Per stored session: the running reply's text so far, which an interrupt keeps. */
  const interruptedReplies = new Map<string, () => string>()
  /**
   * Per stored session: the turn that is running, as the fork's `inflight_turn` keeps it.
   *
   * `id` is the `turn_id` minted at submit and cleared after `message.complete`;
   * `assistant` is every `message.delta` run together (sealed notes included);
   * `sealedLen` is where it stood at the last interim delivered with
   * `already_streamed`, which `session.resume` turns into `assistant_unsealed`.
   */
  const turns = new Map<
    string,
    { id: string; user: string; assistant: string; sealedLen: number | null; metadata: Record<string, unknown> | null }
  >()

  const gated = () => state.auth === 'native' || state.auth === 'cookie'
  /** `native_revoke` is advertised, and its route answers, on a gated gateway that has it. */
  const revokes = () => gated() && options.nativeRevoke !== false
  const publicHost = options.publicHost ?? ''
  const passwordAccount = options.password ?? { username: 'tester', password: 'hunter2' }
  /**
   * Every account this gateway accepts, and what `/api/auth/me` says about it.
   *
   * One by default, named the way the fake has always named its single tester,
   * so nothing that predates this option sees a different answer.
   */
  const accounts: ResolvedAccount[] = (
    options.accounts ?? [
      {
        username: passwordAccount.username,
        password: passwordAccount.password,
        userId: 'tester@example.invalid',
        email: 'tester@example.invalid',
        displayName: 'Fake Tester'
      }
    ]
  ).map(account => ({
    username: account.username,
    password: account.password,
    userId: account.userId ?? `${account.username}@example.invalid`,
    email: account.email ?? account.userId ?? `${account.username}@example.invalid`,
    displayName: account.displayName ?? account.username,
    roles: account.roles ?? [],
    picture: account.picture
  }))
  /** Picture id (`<provider>:<sub>`) → its bytes, from `pictures` and the accounts' own. */
  const pictures = new Map<string, Buffer>()

  for (const [id, source] of Object.entries(options.pictures ?? {})) {
    pictures.set(id, pictureBytes(source))
  }

  for (const account of accounts) {
    if (account.picture) {
      pictures.set(`self-hosted:${account.userId}`, pictureBytes(account.picture))
    }
  }
  /** Cookie value → the account it signs in. A Map, because who matters now. */
  const sessionCookies = new Map<string, ResolvedAccount>()
  /** Access token → the user id it was issued to (native mode), so a bearer names someone. */
  const accessTokenUsers = new Map<string, string>()
  /** The identity each live socket was minted for (the ticket's), when the gateway is gated. */
  const socketIdentities = new Map<WebSocket, Identity>()
  /** The identity a ticket carried, handed from the upgrade check to the connection. */
  const upgradeIdentities = new WeakMap<IncomingMessage, Identity>()
  /** The passkey level, `null` while this gateway does not know it. */
  let passkey: PasskeyGateway | null = null
  /** The MCP feature, `null` while this gateway does not serve it. */
  let mcp: McpGateway | null = null
  let confirmGate: ConfirmGate<WebSocket> | null = null
  /** The address the fake listens on, set once it does: the default base URL of the passkey level. */
  let ownUrl = ''

  const identityOfAccount = (account: ResolvedAccount): Identity => ({
    provider: 'self-hosted',
    userId: account.userId,
    displayName: account.displayName
  })

  /** Read one cookie out of a request's `Cookie` header. */
  function cookieOf(req: IncomingMessage, name: string): string {
    for (const part of String(req.headers.cookie ?? '').split(';')) {
      const [key, ...rest] = part.trim().split('=')

      if (key === name) {
        return decodeURIComponent(rest.join('='))
      }
    }

    return ''
  }

  /**
   * The DNS-rebinding guard, as `web_server.py` and `web_server_chat.py` run it:
   * the `Host` must be the host we believe we are, and an `Origin`, when there
   * is one, must name the same host. Off unless `publicHost` was given, because
   * every other test in this repository dials `127.0.0.1` directly.
   */
  function hostOriginRejection(req: IncomingMessage): string | null {
    if (!publicHost) {
      return null
    }

    const host = String(req.headers.host ?? '')

    if (host !== publicHost) {
      return `host_mismatch host=${host || '?'} expected=${publicHost}`
    }

    const origin = String(req.headers.origin ?? '')

    if (origin) {
      try {
        if (new URL(origin).host !== publicHost) {
          return `origin_mismatch origin=${origin} expected=${publicHost}`
        }
      } catch {
        return `origin_unparseable origin=${origin}`
      }
    }

    return null
  }

  function bearerOf(req: IncomingMessage): string {
    const header = req.headers.authorization ?? ''

    return header.startsWith('Bearer ') ? header.slice(7) : ''
  }

  function httpAuthorized(req: IncomingMessage): boolean {
    if (state.auth === 'none') {
      return true
    }

    if (state.auth === 'token') {
      return req.headers['x-hermes-session-token'] === state.token
    }

    if (state.auth === 'cookie') {
      const cookie = cookieOf(req, SESSION_COOKIE)

      return cookie.length > 0 && sessionCookies.has(cookie)
    }

    const token = bearerOf(req)

    return token.length > 0 && state.accessTokens.has(token)
  }

  /**
   * Who a request is signed in as, the way the gate names them: the account of the session cookie, or of
   * the user an access token was issued to. `null` on a gateway with a session token or none, where the
   * shared secret names nobody.
   */
  function identityOfRequest(req: IncomingMessage): Identity | null {
    if (state.auth === 'cookie') {
      const account = sessionCookies.get(cookieOf(req, SESSION_COOKIE))

      return account ? identityOfAccount(account) : null
    }

    if (state.auth === 'native') {
      const userId = accessTokenUsers.get(bearerOf(req))
      const account = accounts.find(row => row.userId === userId) ?? accounts[0]

      return userId !== undefined && account ? identityOfAccount(account) : null
    }

    return null
  }

  function issueTokens(provider: string, userId: string) {
    const accessToken = `at-${randomUUID()}`
    const refreshToken = `rt-${randomUUID()}`
    state.accessTokens.add(accessToken)
    accessTokenUsers.set(accessToken, userId)
    refreshTokens.set(refreshToken, { provider, userId })

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: 'Bearer',
      expires_at: nowSeconds() + 3600,
      provider,
      user_id: userId
    }
  }

  function publish(type: string, sessionId: string | undefined, payload: unknown): void {
    let seq: number | undefined
    let turnId: string | undefined

    if (sessionId) {
      const session = state.sessions.get(sessionId) ?? findByRuntimeId(sessionId)

      if (session) {
        session.seq += 1
        seq = session.seq

        // The envelope of a turn-stream frame names the turn, while one is running.
        if (rowIdentity && TURN_STREAM_EVENTS.has(type)) {
          turnId = turns.get(session.storedId)?.id
        }

        session.ring.push({ type, session_id: session.id, seq, ...(turnId ? { turn_id: turnId } : {}), payload })

        if (session.ring.length > ringSize) {
          session.ring.shift()
        }
      }
    }

    const frame = JSON.stringify({
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type,
        ...(sessionId ? { session_id: resolveRuntimeId(sessionId) } : {}),
        ...(seq === undefined ? {} : { seq }),
        ...(turnId ? { turn_id: turnId } : {}),
        ...(payload === undefined ? {} : { payload })
      }
    })

    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(`${frame}\n`)
      }
    }
  }

  function findByRuntimeId(id: string): FakeSession | undefined {
    for (const session of state.sessions.values()) {
      // A closed session's runtime id is GONE — `session.close` pops it out of
      // the live map — so every session-scoped RPC still holding it answers
      // 4001 until the client resumes the stored id.
      if (session.id === id && !session.closed) {
        return session
      }
    }

    return undefined
  }

  /**
   * The one session wearing this title ON THIS PROFILE, the way
   * `get_session_by_title` answers.
   *
   * **Scoped to the profile, and that is a correction rather than a
   * simplification.** This used to scan every session in the gateway, which
   * contradicted the fixtures two hundred lines up: `researcher`, `writer` and
   * `notes` are each born with a session titled `Bot Chat`, because that title
   * is the canonical chat's registry key ON A PROFILE and every bot has one
   * (ADR-0007). A global scan makes `session.create {profile:'writer', title:
   * 'Bot Chat'}` land untitled against a gateway that already ships three of
   * them, which is a refusal the real thing cannot be making or Bot Mode would
   * only ever work for one bot.
   *
   * So the uniqueness `_set_session_title` enforces is read as per profile.
   * That is an inference from ADR-0007's own premise and not from a probe;
   * `docs/platform-notes.md` says so, and it is the reading the canonical
   * lookup in `bots-controller.ts` has always depended on.
   */
  function titleHolder(title: string, profile: string): FakeSession | undefined {
    if (!title) {
      return undefined
    }

    for (const session of state.sessions.values()) {
      if (session.title === title && session.profile === profile) {
        return session
      }
    }

    return undefined
  }

  /**
   * A live session, addressed the way a SESSION-SCOPED method addresses one.
   *
   * The runtime id and nothing else. Upstream's `_sess_nowait` is a plain
   * `_sessions.get(session_id)` over the live map, so a stored id — which
   * resolves perfectly well for `session.list`, `session.resume` and the REST
   * routes — comes back 4001 here. The fake used to accept either for
   * everything, which is exactly how a client can be written against the wrong
   * id and still pass.
   */
  function requireLiveSession(id: string): FakeSession {
    const session = findByRuntimeId(id)

    if (!session) {
      throw new RpcFault(4001, 'session not found')
    }

    return session
  }

  /**
   * The roster, with each profile's canonical chat resolved by TITLE.
   *
   * `methods_profiles.py::_canonical_session_row` looks the row up with
   * `db.get_session_by_title('Bot Chat')` on every call, so a profile whose
   * chat has been renamed away reports no canonical session at all, and one
   * whose title has moved to a new row reports the new row. A fixed snapshot
   * cannot show either.
   */
  function profilesWithCanonical(): ProfileRow[] {
    return state.profiles.map(profile => {
      const holder = [...state.sessions.values()].find(
        session => session.profile === profile.name && session.title === CANONICAL_CHAT_TITLE
      )
      const current = profile.canonical_session

      if (!holder) {
        const { canonical_session: _retired, ...rest } = profile

        return rest
      }

      if (current?.id === holder.storedId) {
        // The row was minted once, at start; the count is the one thing that moves with the chat.
        return current.message_count === holder.messages.length
          ? profile
          : { ...profile, canonical_session: { ...current, message_count: holder.messages.length } }
      }

      return {
        ...profile,
        canonical_session: {
          id: holder.storedId,
          resolved_id: holder.storedId,
          title: holder.title,
          preview: holder.messages[holder.messages.length - 1]?.text ?? '',
          last_active: current?.last_active ?? nowSeconds(),
          message_count: holder.messages.length
        }
      }
    })
  }

  /**
   * A profile's capability state, minted on first touch.
   *
   * A profile created during the run has none, and upstream's answer for it is
   * the same as for one that has never been edited — no pin, nothing disabled —
   * because both are simply a config.yaml without those keys.
   */
  function profileCapabilities(name: string): FakeProfileCapabilities {
    const existing = state.profileCapabilities.get(name)

    if (existing) {
      return existing
    }

    const fresh: FakeProfileCapabilities = {
      disabledSkills: new Set<string>(),
      pinnedToolsets: null,
      disabledMcpServers: new Set<string>()
    }

    state.profileCapabilities.set(name, fresh)

    return fresh
  }

  /**
   * `_describe_toolsets`: the checklist, with `enabled` read from the pin when
   * there is one and from the platform defaults when there is not.
   *
   * The filter is the part worth keeping: a default-off toolset is omitted
   * ENTIRELY until something enables it, so the list a client draws is not a
   * constant and a row can appear that was never there before.
   */
  function describeToolsets(capabilities: FakeProfileCapabilities): Record<string, unknown>[] {
    const pinned = capabilities.pinnedToolsets

    return FAKE_TOOLSETS.filter(toolset => {
      const enabled = pinned ? pinned.has(toolset.name) : toolset.platformDefault

      return !(toolset.defaultOff && !enabled)
    }).map(toolset => ({
      name: toolset.name,
      label: toolset.label,
      description: toolset.description,
      tool_count: toolset.toolCount,
      enabled: pinned ? pinned.has(toolset.name) : toolset.platformDefault
    }))
  }

  /**
   * The params every connector method takes, checked the way the gateway's
   * contract checks them (`tui_gateway/contracts/common.py`, `connectors.py`,
   * `connectors_operation.py`): a `ProfileParams` model, `extra="forbid"`, with
   * `owner: ConnectorOwner` — `{type: 'session', session_id}` (a non-empty
   * RUNTIME id) or `{type: 'account'}` — and whatever `keys` the method adds.
   * Anything else, a top-level `session_id` included, is `4000 INVALID_PARAMS`
   * before anything is looked at (`methods_connectors._parse_params`).
   *
   * The generated `@hermes/shared` contract still spells these params with a
   * top-level `session_id` and no `owner`; the gateway refuses that spelling, so
   * this fake does too (HERM-188).
   */
  function checkConnectorParams(params: Record<string, unknown>, keys: readonly string[]): FakeConnectorOwner {
    const invalid = (message: string): RpcFault => new RpcFault(4000, message, { reason: 'INVALID_PARAMS' })
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
    const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], where: string): void => {
      const extra = Object.keys(value).filter(key => !allowed.includes(key))

      if (extra.length) {
        throw invalid(`${where}: extra inputs are not permitted: ${extra.join(', ')}`)
      }
    }

    onlyKeys(params, ['profile', 'owner', ...keys], 'params')

    if (params.profile !== undefined && params.profile !== null && typeof params.profile !== 'string') {
      throw invalid('profile must be a string')
    }

    const owner = params.owner

    if (!record(owner)) {
      throw invalid('owner required')
    }

    if (owner.type === 'session') {
      onlyKeys(owner, ['type', 'session_id'], 'owner')

      if (typeof owner.session_id !== 'string' || !owner.session_id) {
        throw invalid('owner.session_id required')
      }

      return { type: 'session', session_id: owner.session_id }
    }

    if (owner.type === 'account') {
      onlyKeys(owner, ['type'], 'owner')

      return { type: 'account' }
    }

    throw invalid('owner.type must be session or account')
  }

  /**
   * The open operation `op_id` names under this `owner`, or upstream's
   * `4004 UNKNOWN_OPERATION`: a session reaches only its own operations
   * (`live.get(session_key, op_id)`), the account only the account's
   * (`live.get_by_op_id`). A session is matched by either of its ids, so an
   * operation a test seeded under the stored id answers to the runtime id the
   * client names.
   */
  function ownedConnectorOp(owner: FakeConnectorOwner, opId: string): FakeConnectorOp {
    const op = state.connectorOps.get(opId)
    const owns = (candidate: FakeConnectorOp): boolean => {
      if (owner.type === 'account') {
        return candidate.account === true
      }

      if (candidate.account) {
        return false
      }

      if (candidate.sessionId === owner.session_id) {
        return true
      }

      const held = resolveSession(candidate.sessionId)

      return held !== undefined && held === resolveSession(owner.session_id)
    }

    if (!op || op.settled || !owns(op)) {
      throw new RpcFault(4004, 'No open operation with that op_id.', { reason: 'UNKNOWN_OPERATION' })
    }

    return op
  }

  /** `ConnectionOperationParams`: the owner and an `op_id` (a string; an empty one names nothing). */
  function checkConnectorOpParams(params: Record<string, unknown>): { owner: FakeConnectorOwner; opId: string } {
    const owner = checkConnectorParams(params, ['op_id'])

    if (typeof params.op_id !== 'string') {
      throw new RpcFault(4000, 'op_id required', { reason: 'INVALID_PARAMS' })
    }

    return { owner, opId: params.op_id }
  }

  /**
   * One operation, as `_operation_view` shapes it.
   *
   * `connect_url` is present on a target that has one and absent on one that
   * does not, rather than being sent as `null`: upstream's redaction exempts
   * the key by name, and a client that read a null as "no link yet" and kept
   * polling would behave differently from one that read a missing key.
   */
  function connectorOpView(op: FakeConnectorOp): Record<string, unknown> {
    return {
      op_id: op.opId,
      seq: op.seq,
      deadline_at: op.deadlineAt,
      settled: op.settled,
      settled_at: op.settled ? Math.floor(Date.now() / 1000) : null,
      settled_by: op.settledBy,
      targets: op.targets.map(target => ({
        name: target.name,
        kind: target.kind,
        action: target.action,
        state: target.state,
        detail: target.detail,
        ...(target.connectUrl ? { connect_url: target.connectUrl } : {})
      }))
    }
  }

  /**
   * `connection.respond`'s params, checked in the gateway's order
   * (`methods_connectors.py::connection.respond`, contracts in
   * `tui_gateway/contracts/connectors_operation.py`):
   *
   *  1. everything but `result` is `ConnectionOperationParams` on `ProfileParams`
   *     (`checkConnectorOpParams`), `extra="forbid"`: `4000 INVALID_PARAMS`;
   *  2. `result` is a `ConnectionAnswer` — `{targets?, settled_by?}`, a row
   *     `{name, status: approved|skipped, detail?, env?}`, again `extra="forbid"`:
   *     anything else there is `4002 INVALID_ANSWER`.
   *
   * Nothing is applied when either fails.
   */
  function checkConnectionRespond(params: Record<string, unknown>): {
    owner: FakeConnectorOwner
    opId: string
    targets: { name: string; status: string }[]
    settledBy: string | null
  } {
    const isRecord = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value)
    const invalidAnswer = (message: string): RpcFault => new RpcFault(4002, message, { reason: 'INVALID_ANSWER' })
    const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[], where: string): void => {
      const extra = Object.keys(value).filter(key => !allowed.includes(key))

      if (extra.length) {
        throw invalidAnswer(`${where}: extra inputs are not permitted: ${extra.join(', ')}`)
      }
    }

    const { result, ...envelope } = params
    const { owner, opId } = checkConnectorOpParams(envelope)

    if (!isRecord(result)) {
      throw invalidAnswer('result required')
    }

    onlyKeys(result, ['targets', 'settled_by'], 'result')

    const settledBy = result.settled_by ?? null

    if (settledBy !== null && !['all_resolved', 'continue', 'deadline', 'interrupt'].includes(String(settledBy))) {
      throw invalidAnswer(`result.settled_by: not a settle reason: ${String(settledBy)}`)
    }

    const rows = result.targets ?? []

    if (!Array.isArray(rows)) {
      throw invalidAnswer('result.targets must be a list')
    }

    const targets = rows.map((row, index) => {
      if (!isRecord(row)) {
        throw invalidAnswer(`result.targets[${index}] must be an object`)
      }

      onlyKeys(row, ['name', 'status', 'detail', 'env'], `result.targets[${index}]`)

      if (typeof row.name !== 'string') {
        throw invalidAnswer(`result.targets[${index}].name required`)
      }

      if (row.status !== 'approved' && row.status !== 'skipped') {
        throw invalidAnswer(`result.targets[${index}].status must be approved or skipped`)
      }

      if (row.detail !== undefined && row.detail !== null && typeof row.detail !== 'string') {
        throw invalidAnswer(`result.targets[${index}].detail must be a string`)
      }

      if (
        row.env !== undefined &&
        row.env !== null &&
        (!isRecord(row.env) || Object.values(row.env).some(value => typeof value !== 'string'))
      ) {
        throw invalidAnswer(`result.targets[${index}].env must map names to strings`)
      }

      return { name: row.name, status: row.status }
    })

    return { owner, opId, targets, settledBy: settledBy as string | null }
  }

  /** `mcp.servers.list`'s projection of one config entry. */
  function summariseMcpServer(server: FakeMcpServer): Record<string, unknown> {
    return {
      name: server.name,
      transport: server.transport,
      url: server.url ?? null,
      command: server.command ?? null,
      args: server.args,
      env: server.env,
      auth: server.auth ?? null,
      oauth_tokens_present: server.auth === 'oauth' ? server.oauthTokensPresent : null,
      enabled: server.enabled,
      tools: server.tools ? server.tools.length : null
    }
  }

  function resolveSession(id: string): FakeSession | undefined {
    return state.sessions.get(id) ?? findByRuntimeId(id)
  }

  /**
   * Stop the reply a session is streaming, as `session.interrupt` does and `session.interrupt_all` does for
   * each turn it stops. The agent stops: nothing more of the reply is sent, its own completion included, and
   * what was said stays in the history. Before the `message.complete`, so the interrupted turn's completion is
   * the last frame it produces.
   */
  function interruptReply(session: FakeSession): void {
    streamEpochs.set(session.storedId, (streamEpochs.get(session.storedId) ?? 0) + 1)

    const partial = state.runningSessions.has(session.storedId)
      ? (interruptedReplies.get(session.storedId)?.() ?? '')
      : ''

    if (partial) {
      session.messages.push({
        role: 'assistant',
        text: partial,
        row_id: session.messages.length + 1,
        timestamp: nowSeconds()
      })
    }

    state.runningSessions.delete(session.storedId)
    publish('message.complete', session.storedId, { text: '', status: 'interrupted' })
    turns.delete(session.storedId)
  }

  function resolveRuntimeId(id: string): string {
    return resolveSession(id)?.id ?? id
  }

  /** The live children owned by one session, in spawn order. */
  function liveSubagentsFor(storedId: string | undefined): LiveSubagent[] {
    return [...state.liveSubagents.values()]
      .filter(child => !storedId || child.owner_session_id === storedId)
      .sort((a, b) => a.started_at - b.started_at || a.goal.localeCompare(b.goal))
  }

  // ---------------------------------------------------------------- HTTP ---

  /**
   * `GET /api/files/outbox/{id}/{name}?profile=<profile>` (and `HEAD`): the files a bot shared (`outbox.ts`).
   *
   * Behind the gate like every `/api/` route: a header or the session cookie, never `?token=`.
   */
  function serveOutbox(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const method = req.method ?? 'GET'

    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' })
      res.end(JSON.stringify({ detail: 'Method Not Allowed' }))

      return
    }

    const parts = url.pathname.slice('/api/files/outbox/'.length).split('/')
    let id = ''
    let name = ''

    // `{id}/{name}`: exactly two segments; a slash in the name (encoded or not) leaves the route.
    try {
      id = decodeURIComponent(parts[0] ?? '')
      name = parts.length === 2 ? decodeURIComponent(parts[1] ?? '') : ''
    } catch {
      name = ''
    }

    const header = (key: string): string | undefined => {
      const value = req.headers[key]

      return Array.isArray(value) ? value[0] : value
    }
    const answer =
      name === '' || name.includes('/')
        ? answerOutbox(new Map(), { method, id, name, profile: null, defaultProfile: LAUNCH_PROFILE })
        : answerOutbox(state.outboxFiles, {
            method,
            id,
            name,
            profile: url.searchParams.get('profile'),
            defaultProfile: LAUNCH_PROFILE,
            ...(header('range') === undefined ? {} : { range: header('range') as string }),
            ...(header('if-range') === undefined ? {} : { ifRange: header('if-range') as string }),
            ...(header('if-none-match') === undefined ? {} : { ifNoneMatch: header('if-none-match') as string }),
            ...(header('sec-fetch-dest') === undefined ? {} : { secFetchDest: header('sec-fetch-dest') as string })
          })

    state.outboxRequests.push({
      id,
      name,
      profile: url.searchParams.get('profile'),
      method,
      range: header('range') ?? null,
      status: answer.status
    })
    res.writeHead(answer.status, answer.headers)
    res.end(answer.body)
  }

  /**
   * `GET /api/files/images/{name}?profile=<profile>`, from `options.profileHomes` (`attached-images.ts`).
   *
   * Behind the gate like every `/api/` route, and only by what the gate accepts: a header or the session
   * cookie, never `?token=` (an `<img>` address that carried the token would be a leaked credential).
   */
  function serveAttachedImage(req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
      res.end(JSON.stringify({ detail: 'Method Not Allowed' }))

      return
    }

    let name: string

    try {
      name = decodeURIComponent(url.pathname.slice('/api/files/images/'.length))
    } catch {
      json(res, 404, { detail: 'Not Found' })

      return
    }

    // `{name}` is one path segment: a slash (encoded or not) leaves the route, as it does upstream.
    if (name === '' || name.includes('/')) {
      json(res, 404, { detail: 'Not Found' })

      return
    }

    const source: AttachedImageSource = {
      defaultProfile: LAUNCH_PROFILE,
      profiles: new Set([LAUNCH_PROFILE, ...state.profiles.map(row => row.name)]),
      homes: options.profileHomes ?? {}
    }
    const answer = readAttachedImage(source, name, url.searchParams.get('profile'))

    state.attachedImageRequests.push({ name, profile: url.searchParams.get('profile'), status: answer.status })

    if (answer.status !== 200) {
      json(res, answer.status, { detail: answer.detail })

      return
    }

    res.writeHead(200, {
      'content-type': answer.contentType,
      'content-length': answer.body.length,
      'x-content-type-options': 'nosniff',
      'content-disposition': `inline; filename="${name}"`,
      'cache-control': 'private, max-age=3600'
    })
    res.end(answer.body)
  }

  /**
   * `GET /dashboard-plugins/{plugin_name}/{file_path:path}`, from `options.pluginAssets`.
   *
   * Only `hermie` is a plugin here, and only when the plugin is there at all
   * (`plugin: false` is a gateway without it) and a directory was given; any
   * other name is the route's own 404, `Plugin not found`.
   */
  function servePluginAsset(req: IncomingMessage, res: ServerResponse, pathname: string): void {
    const match = /^\/dashboard-plugins\/([^/]+)\/(.*)$/su.exec(pathname)

    if (!match) {
      json(res, 404, { detail: 'Not Found' })

      return
    }

    if (req.method !== 'GET') {
      // FastAPI registers the route for GET alone, HEAD included.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET' })
      res.end(JSON.stringify({ detail: 'Method Not Allowed' }))

      return
    }

    let name: string
    let filePath: string

    try {
      name = decodeURIComponent(match[1] as string)
      filePath = decodeURIComponent(match[2] as string)
    } catch {
      json(res, 404, { detail: 'File not found' })

      return
    }

    if (name !== 'hermie' || !options.pluginAssets || options.plugin === false) {
      json(res, 404, { detail: 'Plugin not found' })

      return
    }

    const answer = readPluginAsset(options.pluginAssets, filePath)

    if (answer.status !== 200) {
      json(res, answer.status, { detail: answer.detail })

      return
    }

    res.writeHead(200, {
      'content-type': answer.contentType,
      'content-length': answer.body.length,
      'cache-control': PLUGIN_ASSET_CACHE_CONTROL
    })
    res.end(answer.body)
  }

  /**
   * What the gate answers a cookie-mode request that has no session
   * (`middleware._unauth_response`): for `/api` a JSON 401 that names where to
   * sign in, because a `fetch` follows a redirect opaquely, and for a page a 302
   * to the sign-in page.
   *
   * The pages are the ones this fake serves: `/` and the plugin's files. The real
   * gate redirects every path that is not `/api`, but a path nothing here serves
   * keeps the plain JSON 401 it has always had, because a probe of a wrong
   * address (an access-proxy check, as the old Hermie Web's setup made) tells "a gate answered
   * for it" from "a gateway answered" by exactly that.
   *
   * A cookie that is present and no longer good is the other reason, with its own
   * `error`, and is cleared on the way out. Which is which is the one thing a
   * client can act on: "sign in" and "your session ended" read differently.
   */
  function rejectUnauthenticated(req: IncomingMessage, res: ServerResponse, url: URL): void {
    const expired = cookieOf(req, SESSION_COOKIE).length > 0
    const loginUrl = loginUrlFor(url.pathname, url.search)
    const clearing = expired ? { 'set-cookie': `${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/` } : {}

    if (url.pathname.startsWith('/api/')) {
      const text = JSON.stringify({
        error: expired ? 'session_expired' : 'unauthenticated',
        detail: 'Unauthorized',
        reason: expired ? 'invalid_or_expired_session' : 'no_cookie',
        login_url: loginUrl
      })
      res.writeHead(401, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(text),
        ...clearing
      })
      res.end(text)

      return
    }

    if (url.pathname === '/' || url.pathname.startsWith('/dashboard-plugins/')) {
      res.writeHead(302, { location: loginUrl, ...clearing })
      res.end()

      return
    }

    json(res, 401, { detail: 'Unauthorized' })
  }

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch(error => {
      json(res, 500, { error: String(error) })
    })
  })

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    /*
      A gateway that has moved, before anything else is read.

      A 301 is what the whole origin answers, and the client has to refuse it
      wherever it arrives rather than only on the one path a test happened to
      use.
    */
    if (options.redirectTo) {
      res.writeHead(301, { location: `${options.redirectTo.replace(/\/$/u, '')}${req.url ?? '/'}` })
      res.end()

      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    const rejection = hostOriginRejection(req)

    if (rejection !== null) {
      json(res, 403, { detail: rejection })

      return
    }

    if (state.auth === 'cookie' && path === '/login') {
      // The gateway's own sign-in page. A form rather than JSON, because that is
      // what a browser lands on when `/auth/login` redirects a password
      // provider — and because the proxy has to carry HTML as happily as JSON.
      // It signs in and then follows `next`, which is what a client's sign-in
      // bounce relies on to come back.
      html(res, 200, LOGIN_PAGE)

      return
    }

    if (state.auth === 'cookie' && path === '/auth/login') {
      const reauthId = url.searchParams.get('reauth') ?? ''

      if (reauthId) {
        // A sign-in made again to add a passkey (contract §7.2): the fake plays the identity provider.
        handleWebReauthLogin(req, res, url, reauthId)

        return
      }

      // Upstream redirects a password provider to its own /login page and an
      // OAuth provider to the identity provider. The fake has no identity
      // provider, so both land on /login.
      const next = url.searchParams.get('next') ?? '/'
      res.writeHead(302, { location: `/login?next=${encodeURIComponent(next)}` })
      res.end()

      return
    }

    if (state.auth === 'cookie' && path === '/auth/password-login' && method === 'POST') {
      const body = await readBody(req)

      const account = accounts.find(
        row => row.username === String(body.username ?? '') && row.password === String(body.password ?? '')
      )

      if (!account) {
        json(res, 401, { detail: 'Invalid credentials' })

        return
      }

      const value = `sess-${randomUUID()}`
      sessionCookies.set(value, account)
      // `HttpOnly` and `SameSite=Lax`, no `Secure`: this fake is only ever
      // reached over plain HTTP, and a `Secure` cookie there is discarded.
      res.setHeader('set-cookie', `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/`)
      json(res, 200, { ok: true, next: String(body.next ?? '/') })

      return
    }

    if (state.auth === 'cookie' && path === '/auth/logout' && method === 'POST') {
      sessionCookies.delete(cookieOf(req, SESSION_COOKIE))
      res.writeHead(302, {
        location: '/login',
        'set-cookie': [`${SESSION_COOKIE}=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/`, clearedReauthCookie]
      })
      res.end()

      return
    }

    if (path === '/api/status') {
      json(res, 200, {
        version,
        release_date: '2026.9.14',
        gateway_running: true,
        active_sessions: state.sessions.size,
        auth_required: gated(),
        auth_providers: gated() ? ['self-hosted'] : [],
        auth_flows: [
          ...(state.auth === 'cookie' ? ['cookie'] : gated() ? ['cookie', 'native_pkce'] : []),
          // Upstream appends it in every gated mode, after the other two.
          ...(revokes() ? ['native_revoke'] : [])
        ],
        // `status.py` puts the TOPOLOGY rows here, not a list of names. Nothing
        // in the app reads them, which is exactly why the fake could get away
        // with a different type for as long as it did.
        profiles: state.profiles.map(profile => ({
          name: profile.name,
          path: profile.path,
          display_name: profile.display_name,
          is_default: profile.name === LAUNCH_PROFILE
        })),
        overall: 'ok'
      })

      return
    }

    /**
     * The Kanban plugin's own router — `plugins/kanban/dashboard/plugin_api.py`,
     * mounted at `/api/plugins/kanban` by `web_server_dashboard.py`.
     *
     * Mounted ONLY when the plugin is bundled or enabled, which is why a null
     * board list 404s the whole prefix rather than answering an empty board:
     * there is no router to answer with.
     */
    if (path.startsWith('/api/plugins/kanban')) {
      if (state.kanbanBoards === null) {
        json(res, 404, { detail: 'Not Found' })

        return
      }

      await handleKanban(req, res, path.slice('/api/plugins/kanban'.length), method, url.searchParams)

      return
    }

    if (path === '/api/auth/providers') {
      if (!gated()) {
        json(res, 503, { detail: 'No interactive session providers are configured.' })

        return
      }

      json(res, 200, {
        providers: [
          {
            name: 'self-hosted',
            display_name: 'Self-Hosted OIDC',
            supports_password: state.auth === 'cookie'
          }
        ]
      })

      return
    }

    if (path === '/auth/native/authorize') {
      handleAuthorize(req, url, res)

      return
    }

    if (stagedIdp && (path.startsWith('/__idp/') || path === '/auth/callback')) {
      await handleStagedIdp(req, res, url, path, method)

      return
    }

    if (path === '/auth/native/token' && method === 'POST') {
      const body = await readBody(req)
      const code = String(body.code ?? '')
      const verifier = String(body.code_verifier ?? '')
      const issued = codes.get(code)

      // The real gateway consumes the code on every path: no verifier oracle.
      codes.delete(code)

      if (!issued || issued.challenge !== s256(verifier)) {
        json(res, 400, { detail: 'Invalid or expired authorization code.' })

        return
      }

      if (issued.reauth) {
        // A re-authentication code (contract §8): the grant is completed, nothing is signed in, and the app's own
        // token set is untouched. The answer carries the grant's state and, when fresh, its one-time use secret.
        json(res, 200, {
          reauth: passkey
            ? reauthOutcomeBody(completeReauth(passkey, issued.reauth, { client: 'native', secret: null }))
            : { grant_id: issued.reauth, state: 'failed', expires_at: 0, reason: 'unknown' }
        })

        return
      }

      state.tokenExchanges += 1
      json(res, 200, issueTokens(issued.provider, 'tester@example.invalid'))

      return
    }

    if (path === '/auth/native/refresh' && method === 'POST') {
      const body = await readBody(req)
      state.refreshCalls += 1
      const token = String(body.refresh_token ?? '')

      if (!token) {
        // `dashboard_auth/routes.py:501-502` — the one 400 this route answers.
        json(res, 400, { detail: 'refresh_token required' })

        return
      }

      if (state.spentRefreshTokens.has(token)) {
        state.refreshReuseAttempts += 1
      }

      const known = refreshTokens.get(token)

      if (!known) {
        // Upstream collapses expired, unknown and provider-rejected into this one
        // answer, with `error` alongside `detail` — an envelope no other route in
        // `dashboard_auth` uses (`routes.py:517-519`).
        json(res, 401, { error: 'session_expired', detail: 'Refresh token expired or invalid; start a new sign-in.' })

        return
      }

      refreshTokens.delete(token)
      state.spentRefreshTokens.add(token)
      json(res, 200, issueTokens(known.provider, known.userId))

      return
    }

    if (path === '/auth/native/revoke' && method === 'POST' && revokes()) {
      /*
        `dashboard_auth/routes.py` `auth_native_revoke`: public, no bearer read,
        and `200 {"ok": true}` for every well-formed request whatever the token
        was — the answer must not tell a caller whether a token was live. A
        missing token or provider is the one 400.
      */
      const body = await readBody(req)
      const token = typeof body.refresh_token === 'string' ? body.refresh_token : ''
      const provider = typeof body.provider === 'string' ? body.provider : ''

      state.revokeCalls.push({ refreshToken: token, provider, authorization: req.headers.authorization !== undefined })

      if (!token) {
        json(res, 400, { detail: 'refresh_token required' })

        return
      }

      if (!provider) {
        json(res, 400, { detail: 'provider required: send the provider name returned with the token' })

        return
      }

      // The grant is over: the refresh token stops rotating, as it would at an
      // identity provider that revoked it.
      refreshTokens.delete(token)
      json(res, 200, { ok: true })

      return
    }

    if (path === '/__fake/push' && method === 'GET') {
      /*
        Read the section back, for the one question a device cannot answer
        about itself: did my registration actually land?

        It was added because of the owner's report — a `hermie-app.push` with a
        live heartbeat and `registrations: {}` — and the only way to tell that
        state from a working one is to look at the gateway's own copy while the
        app is running against it.
      */
      const profile = state.profiles.find(row => row.is_default) ?? state.profiles[0]
      const app = (profile?.ui_meta?.['hermie-app'] ?? {}) as Record<string, unknown>

      json(res, 200, (app.push ?? { registrations: {}, seen: {} }) as Record<string, unknown>)

      return
    }

    if (path === '/__fake/push' && method === 'POST') {
      // The other half of the control surface: who is registered for push, and
      // which of the four events ADR-0017 names just happened. Never part of
      // the gateway contract — a real gateway has no push machinery at all,
      // which is the whole reason the daemon exists.
      const body = await readBody(req)
      const action = String(body.action ?? '')

      if (action === 'registrations') {
        setPushSection(
          (body.registrations ?? {}) as Record<string, unknown>,
          (body.seen ?? {}) as Record<string, number>
        )
        json(res, 200, { ok: true })

        return
      }

      const profile = String(body.profile ?? 'researcher')
      const session = sessionForProfile(profile)

      if (!session) {
        json(res, 404, { detail: `No Bot Chat for profile ${profile}` })

        return
      }

      if (action === 'cron') {
        injectForeignTurn(session, {
          user: `${CRON_BOT_CHAT_HEADER(String(body.job ?? 'Morning digest'))}\n\n${String(body.report ?? 'Nothing needs your attention.')}`,
          assistant: String(body.reply ?? 'Read it — all clear.'),
          stream: true,
          ...(body.failed === true ? { status: 'error', error: 'the cron run did not complete' } : {})
        })
        json(res, 200, { ok: true, session_id: session.id })

        return
      }

      if (action === 'dm') {
        injectForeignTurn(session, {
          user: `Message from 🤖 ${String(body.from ?? 'Writer')} (@${String(body.handle ?? 'writer')}): ${String(body.body ?? 'the draft is ready.')}`,
          assistant: String(body.reply ?? 'Noted — I will fold that in.'),
          stream: true
        })
        json(res, 200, { ok: true, session_id: session.id })

        return
      }

      if (action === 'approval') {
        // Deliberately not awaited: an approval nobody answers is exactly the
        // state a notification is supposed to be raised about.
        void queueApproval(session, String(body.command ?? 'rm -rf ./build'), body.queueOnly === true).catch(
          () => undefined
        )
        json(res, 200, { ok: true, session_id: session.id })

        return
      }

      json(res, 400, { detail: `Unknown push action: ${action}` })

      return
    }

    if (path === '/__fake/inject' && method === 'POST') {
      // A control surface, never part of the gateway contract: it fakes a turn
      // somebody else ran — a teammate bot, a cron delivery, the same chat open
      // on a desktop — so a client can be checked against a foreign turn it
      // never submitted.
      const body = await readBody(req)
      const profile = String(body.profile ?? 'researcher')
      /*
       * `session_id` (a stored or runtime id) targets one exact conversation —
       * a bot has more than one once sub-chats exist, and "the profile's
       * first session" is always its canonical Bot Chat. Omitted, the lookup
       * is the original one, unchanged.
       */
      const session =
        typeof body.session_id === 'string' && body.session_id
          ? resolveSession(body.session_id)
          : [...state.sessions.values()].find(entry => entry.profile === profile)

      if (!session) {
        json(res, 404, {
          detail:
            typeof body.session_id === 'string' && body.session_id
              ? `No session ${body.session_id}`
              : `No session for profile ${profile}`
        })

        return
      }

      // `{id, name?, via?: {kind, client}}`: the stamp the fork writes. `via` rides only when it is
      // a well-formed marker, so a test cannot stage a half of one by accident.
      const stampOf = (value: unknown): InjectedAuthor | undefined => {
        if (!value || typeof value !== 'object' || typeof (value as { id?: unknown }).id !== 'string') {
          return undefined
        }

        const stamp = value as { id: string; name?: unknown; via?: { kind?: unknown; client?: unknown } | null }

        return {
          id: stamp.id,
          ...(typeof stamp.name === 'string' ? { name: stamp.name } : {}),
          ...(stamp.via && typeof stamp.via.kind === 'string' && typeof stamp.via.client === 'string'
            ? { via: { kind: stamp.via.kind, client: stamp.via.client } }
            : {})
        }
      }
      const author = stampOf(body.author)
      const replayedBy = stampOf(body.replayed_by)

      injectForeignTurn(session, {
        user: String(body.user ?? 'Message from 🤖 Writer (@writer): the draft is ready.'),
        assistant: String(body.assistant ?? 'Noted — I will fold that in.'),
        stream: body.stream !== false,
        ...(typeof body.status === 'string' ? { status: body.status } : {}),
        ...(typeof body.error === 'string' ? { error: body.error } : {}),
        ...(author ? { author } : {}),
        ...(replayedBy ? { replayedBy } : {})
      })

      json(res, 200, { injected: true, session_id: session.id, stored_session_id: session.storedId })

      return
    }

    if (path === '/__fake/state' && method === 'GET') {
      /*
        A read-back for black-box clients (the native integration tests), which
        cannot hold the gateway object the TypeScript tests read `state` from.
        Counters and logs only; nothing a test could use to sign in.
      */
      json(res, 200, {
        connections: state.connections,
        openSockets: sockets.size,
        rejectedUpgrades: state.rejectedUpgrades,
        rejectNextUpgrades: state.rejectNextUpgrades,
        ticketsMinted: state.ticketsMinted,
        ticketsConsumed: state.ticketsConsumed,
        refreshCalls: state.refreshCalls,
        refreshReuseAttempts: state.refreshReuseAttempts,
        eventsSinceCalls: state.eventsSinceCalls,
        methodLog: state.methodLog,
        clientCapabilities: state.clientCapabilities,
        openServerRequests: [...state.openServerRequests.keys()],
        serverRequestAnswers: state.serverRequestAnswers,
        // Every interactive request raised, and how it stands.
        interactiveRequests: interactive.list(),
        // Every `connection.respond` the strict contract accepted, as it was sent.
        connectionResponses: state.connectionResponses,
        // What an MCP server's API key or bearer token was written as, by server: the one place a
        // secret is visible, because the gateway never sends one back.
        mcpSecrets: Object.fromEntries(state.mcpSecrets),
        // Completed Kanban `POST /dispatch` nudges: what a write to a card kicks.
        kanbanDispatches: state.kanbanDispatches,
        // What `GET /api/files/images/{name}` was asked for (name, profile) and answered (status).
        attachedImageRequests: state.attachedImageRequests,
        // What `GET /api/files/outbox/{id}/{name}` was asked for and answered, and the files a bot shared.
        outboxRequests: state.outboxRequests,
        outboxFiles: [...state.outboxFiles.values()].map(file => ({ ...wireOf(file), profile: file.profile })),
        // What the text-to-speech routes were asked, and the streams a client ended before `end`.
        audioRequests: state.audioRequests,
        audioStreamsCancelled: state.audioStreamsCancelled,
        // Stored ids of the sessions with a turn still streaming: how a client
        // that is away can tell the turn it missed has finished.
        runningSessions: [...state.runningSessions],
        // The passkey level's public view; absent while this gateway does not know the level.
        ...(passkey ? { passkey: passkeyView() } : {})
      })

      return
    }

    if (path === '/__fake/drop-sockets' && method === 'POST') {
      /*
        Every live socket goes. Without a `code` it is the abrupt kind (no close
        frame, the client sees 1006), what a proxy restart or a lost route looks
        like; with one it is a deliberate close, 4403 and friends included.
      */
      const body = await readBody(req)
      const code = typeof body.code === 'number' ? body.code : undefined
      const dropped = sockets.size

      for (const socket of [...sockets]) {
        if (code === undefined) {
          socket.terminate()
        } else {
          socket.close(code, typeof body.reason === 'string' ? body.reason : '')
        }
      }

      json(res, 200, { dropped })

      return
    }

    if (path === '/__fake/withdraw-requests' && method === 'POST') {
      /*
        Every server→client request still open is withdrawn, as the real
        gateway does when it stops waiting: `request.cancel` to the sockets, the
        wait itself rejected. A test that shares one gateway with others starts
        from no open question this way, whatever the one before it left.
      */
      const body = await readBody(req)
      const reason = typeof body.reason === 'string' ? body.reason : 'withdrawn'
      const withdrawn = [...state.openServerRequests.entries()]

      for (const [id, request] of withdrawn) {
        // `{id, method, reason}`, as `server_requests._emit_cancel` sends it.
        publish('request.cancel', request.session_id, { id, method: request.method, reason })
        pendingServerRequests.get(id)?.reject(new Error(`withdrawn: ${reason}`))
        pendingServerRequests.delete(id)
        confirmGate?.withdrawn(id, reason)
        interactive.withdrawn(id, reason)
      }

      json(res, 200, { withdrawn: withdrawn.length })

      return
    }

    if (path === '/__fake/deny' && method === 'POST') {
      /*
        Refuse methods with a code and a message, as a gateway does an account that may not call
        them (the access-denial range, `4030` by default). `clear` takes every refusal back. Not
        part of the contract: a test's way of staging a read-only account.
      */
      const body = await readBody(req)

      if (body.clear === true) {
        state.deniedMethods.clear()
      }

      const methods = Array.isArray(body.methods) ? body.methods.filter(entry => typeof entry === 'string') : []

      for (const entry of methods as string[]) {
        state.deniedMethods.set(entry, {
          code: typeof body.code === 'number' ? body.code : 4030,
          message: typeof body.message === 'string' ? body.message : 'This account may not change profiles.'
        })
      }

      json(res, 200, { denied: [...state.deniedMethods.keys()] })

      return
    }

    if (path === '/__fake/approvals' && method === 'POST') {
      /*
        Stage the approvals (`approval-grants.ts`). Not part of the contract.

          { clear: true }                                       no grants, mode manual, supported
          { mode: 'manual' | 'smart' | 'off' }                  the approval mode
          { permanent: [{ profile, label, kind? }] }            add standing grants (a label of several rules
                                                                 joins them with "; ")
          { session: [{ profile, label, tirith? }] }            add session grants to the profile's own chat
          { session: [{ sessionKey, label, tirith? }] }         ... or to the session with that stored id
          { unsupported: true | false }                         the approval methods answer -32601
      */
      const body = await readBody(req)

      if (body.clear === true) {
        state.approvals = emptyApprovalGrantsStage()
      }

      if (typeof body.mode === 'string' && (APPROVAL_MODES as readonly string[]).includes(body.mode)) {
        state.approvals.mode = body.mode as ApprovalGrantsStage['mode']
      }

      for (const row of Array.isArray(body.permanent) ? (body.permanent as Record<string, unknown>[]) : []) {
        const profile = typeof row.profile === 'string' && row.profile ? row.profile : LAUNCH_PROFILE
        state.approvals.permanent.set(profile, [...(state.approvals.permanent.get(profile) ?? []), stagedGrant(row)])
      }

      for (const row of Array.isArray(body.session) ? (body.session as Record<string, unknown>[]) : []) {
        const key =
          typeof row.sessionKey === 'string' && row.sessionKey
            ? row.sessionKey
            : titleHolder('Bot Chat', typeof row.profile === 'string' ? row.profile : LAUNCH_PROFILE)?.storedId

        if (key) {
          state.approvals.sessions.set(key, [...(state.approvals.sessions.get(key) ?? []), stagedGrant(row)])
        }
      }

      if (typeof body.unsupported === 'boolean') {
        state.approvals.unsupported = body.unsupported
      }

      json(res, 200, { methods: [...APPROVAL_GRANTS_METHODS], unsupported: state.approvals.unsupported })

      return
    }

    if (path === '/__fake/approvals' && method === 'GET') {
      // The grants as the fake holds them (labels only) and every approval call's method, profile and keys.
      json(res, 200, approvalView(state.approvals))

      return
    }

    if (path === '/__fake/vault' && method === 'POST') {
      /*
        Stage the vault (`vault.ts`). Not part of the contract.

          { clear: true }                    every profile's vault empty, the manager locked and unstaged
          { managerPassword: '<marker>' }    the master password the manager unlocks with
          { managerItems: [...] }            the logins it lists once unlocked (metadata rows)
          { unsupported: true | false }      the vault methods answer -32601
      */
      const body = await readBody(req)

      if (body.clear === true) {
        state.vault = emptyVaultStage()
      }

      if (typeof body.managerPassword === 'string') {
        state.vault.managerPassword = body.managerPassword
      }

      if (Array.isArray(body.managerItems)) {
        state.vault.managerItems = (body.managerItems as Record<string, unknown>[]).map((row, index) => ({
          created_at: new Date().toISOString(),
          id: typeof row.id === 'string' ? row.id : `${VAULT_MANAGER.name}_${index + 1}`,
          identifier: typeof row.identifier === 'string' ? row.identifier : null,
          identifier_type: typeof row.identifier_type === 'string' ? row.identifier_type : null,
          kind: typeof row.kind === 'string' ? row.kind : 'login',
          label: typeof row.label === 'string' ? row.label : '',
          origin: typeof row.origin === 'string' ? row.origin : null
        }))
      }

      if (typeof body.unsupported === 'boolean') {
        state.vault.unsupported = body.unsupported
      }

      json(res, 200, { methods: [...VAULT_METHODS], unsupported: state.vault.unsupported })

      return
    }

    if (path === '/__fake/vault' && method === 'GET') {
      // A profile's items WITH their secrets, the manager's state and every vault call's method, profile and
      // keys: what reached the gateway, for a test to check. Never part of the contract.
      const profile =
        url.searchParams.get('profile') ?? state.profiles.find(entry => entry.is_default)?.name ?? LAUNCH_PROFILE

      json(res, 200, vaultView(state.vault, profile))

      return
    }

    if (path === '/__fake/usage' && method === 'GET') {
      // What `account.usage` was asked, oldest first: whose profile, and whether the call said `refresh`.
      json(res, 200, { accountCalls: state.usage.accountCalls })

      return
    }

    if (path === '/__fake/stop-all' && method === 'POST') {
      /*
        Stage what `session.interrupt_all` answers beyond the sessions it stops: `notAllowed` and `failed`
        counts, `unsupported` for a gateway that predates the method. `clear: true` takes it all back.
      */
      const body = await readBody(req)

      if (body.clear === true) {
        state.stopAll = { unsupported: false, notAllowed: 0, failed: 0 }
      }

      if (typeof body.unsupported === 'boolean') {
        state.stopAll.unsupported = body.unsupported
      }

      if (typeof body.notAllowed === 'number' && body.notAllowed >= 0) {
        state.stopAll.notAllowed = Math.floor(body.notAllowed)
      }

      if (typeof body.failed === 'number' && body.failed >= 0) {
        state.stopAll.failed = Math.floor(body.failed)
      }

      json(res, 200, state.stopAll)

      return
    }

    if (path === '/__fake/usage' && method === 'POST') {
      /*
        Stage what the usage calls answer (`usage.ts`). Not part of the contract: a test's way of putting a
        day over a limit, of giving a profile no use at all, of making the account a Nous one, of giving
        `session.usage` the provider account lines, or of being a gateway that has none of it.

          { clear: true }                  take every staging back
          { days: { <profile>: [...] } }   a profile's analytics rows, replacing the derived ones
          { bars: true | false }           `usage.bars` answers the Nous balance, or "no balance"
          { accountLines: true | [..] }    `session.usage` carries account lines (the Anthropic ones, or these)
          { creditsLines: [..] }           and credits lines
          { account: [..] | null }         the providers `account.usage` answers with (null: the derived ones)
          { accountUnsupported: bool }     only `account.usage` answers -32601: an older gateway
          { unsupported: true | false }    the route 404s and the methods answer -32601
      */
      const body = await readBody(req)

      if (body.clear === true) {
        state.usage = emptyUsageStage()
      }

      if (body.days && typeof body.days === 'object' && !Array.isArray(body.days)) {
        for (const [profile, rows] of Object.entries(body.days as Record<string, unknown>)) {
          state.usage.days.set(profile, Array.isArray(rows) ? (rows as UsageDay[]) : [])
        }
      }

      if (typeof body.bars === 'boolean') {
        state.usage.bars = body.bars ? nousBars() : null
      }

      if (body.accountLines === true) {
        state.usage.accountLines = anthropicAccountLines()
      } else if (Array.isArray(body.accountLines)) {
        state.usage.accountLines = body.accountLines.filter((line): line is string => typeof line === 'string')
      }

      if (Array.isArray(body.creditsLines)) {
        state.usage.creditsLines = body.creditsLines.filter((line): line is string => typeof line === 'string')
      }

      if (Array.isArray(body.account)) {
        state.usage.account = body.account as AccountUsageProvider[]
      } else if (body.account === null) {
        state.usage.account = null
      }

      if (typeof body.accountUnsupported === 'boolean') {
        state.usage.accountUnsupported = body.accountUnsupported
      }

      if (typeof body.unsupported === 'boolean') {
        state.usage.unsupported = body.unsupported
      }

      json(res, 200, {
        accountLines: state.usage.accountLines.length,
        bars: state.usage.bars !== null,
        days: [...state.usage.days.keys()],
        unsupported: state.usage.unsupported
      })

      return
    }

    if (path === '/__fake/reject-upgrades' && method === 'POST') {
      // The next `count` upgrades fail auth with `--close-code` even with a
      // valid credential: `rejectNextUpgrades`, for a client in another process.
      const body = await readBody(req)
      const count = typeof body.count === 'number' && body.count >= 0 ? Math.floor(body.count) : 1
      state.rejectNextUpgrades = count
      json(res, 200, { rejectNextUpgrades: count })

      return
    }

    if (path === '/__fake/truncate-next-replay' && method === 'POST') {
      /*
        The next `session.events.since` answers `truncated: true`, as the real
        ring does once it has evicted an event newer than the watermark asked
        about: `truncateNextReplay`, for a client in another process.
      */
      state.truncateNextReplay = true
      json(res, 200, { truncateNextReplay: true })

      return
    }

    if (path === '/__fake/session-owned' && method === 'POST') {
      /*
        Another Hermes window or terminal has a chat open: its `prompt.submit` is refused with 4090
        `SESSION_NOT_OWNED` until `owned: false`. `{profile?, session_id?, details?, owned?}`: the
        profile's first chat unless `session_id` (a stored or runtime id) names one.
      */
      const body = await readBody(req)
      const session =
        typeof body.session_id === 'string' && body.session_id
          ? resolveSession(body.session_id)
          : [...state.sessions.values()].find(entry => entry.profile === String(body.profile ?? 'researcher'))

      if (!session) {
        json(res, 404, { detail: 'No such session' })

        return
      }

      if (body.owned === false) {
        state.ownedElsewhere.delete(session.storedId)
      } else {
        state.ownedElsewhere.set(
          session.storedId,
          typeof body.details === 'string' ? body.details : `session ${session.storedId} opened by cli 4m ago.`
        )
      }

      json(res, 200, { session_id: session.storedId, owned: state.ownedElsewhere.has(session.storedId) })

      return
    }

    if (path === '/__fake/connection-request' && method === 'POST') {
      /*
        An agent's `manage_connections` card, for a client in another process:
        an operation is opened on the profile's chat (or the `session_id` given,
        stored or runtime) with one pending row per name in `targets`, and
        announced as `connection.request`, the way the gateway opens one. The
        client's answers go through the strict `connection.respond` and are read
        back from `/__fake/state` under `connectionResponses`.
      */
      const body = await readBody(req)
      const profile = String(body.profile ?? 'researcher')
      const session =
        typeof body.session_id === 'string' && body.session_id
          ? resolveSession(body.session_id)
          : [...state.sessions.values()].find(entry => entry.profile === profile)

      if (!session) {
        json(res, 404, { detail: `No session for ${String(body.session_id ?? profile)}` })

        return
      }

      const names = Array.isArray(body.targets) ? body.targets.map(String) : ['github']
      const opId = typeof body.op_id === 'string' && body.op_id ? body.op_id : `op-${state.connectorOps.size + 1}`
      const deadlineAt = Math.floor(Date.now() / 1000) + 300

      state.connectorSeq += 1
      state.connectorOps.set(opId, {
        opId,
        sessionId: session.id,
        seq: state.connectorSeq,
        deadlineAt,
        settled: false,
        settledBy: null,
        reads: 0,
        woken: false,
        targets: names.map(name => ({
          name,
          kind: 'connector' as const,
          action: 'authorize',
          state: 'pending',
          connectUrl: null,
          detail: null,
          resolvesTo: 'connected'
        }))
      })
      publish('connection.request', session.id, {
        op_id: opId,
        seq: state.connectorSeq,
        tool_call_id: typeof body.tool_call_id === 'string' ? body.tool_call_id : `tc-${opId}`,
        deadline_at: deadlineAt,
        timeout_seconds: 300,
        targets: names.map(name => ({ name, kind: 'connector', action: 'authorize', state: 'pending' }))
      })
      json(res, 200, { op_id: opId, session_id: session.id, stored_session_id: session.storedId })

      return
    }

    if (path === '/__fake/expire-sessions' && method === 'POST') {
      /*
        Every cookie session ends at once, as when the identity provider revokes
        them or the gateway restarts: the next request that carries one of those
        cookies is answered as an expired session, not as a visitor who never
        signed in. A browser test that wants the lapse without reaching into the
        browser's cookie jar uses this. Tokens and tickets already handed out are
        left alone — a live socket keeps its session until it is dropped.
      */
      const expired = sessionCookies.size
      sessionCookies.clear()
      json(res, 200, { expired })

      return
    }

    /*
      The MCP grants, seeded and listed from outside: the consent (OAuth, in a browser, with a client) is
      not something a test can do, and the operator's view includes what the app's page never shows.
    */
    if (path === '/__fake/mcp/grants' && (method === 'GET' || method === 'POST')) {
      if (!mcp) {
        json(res, 409, { detail: 'This gateway does not serve MCP; start it with --mcp or POST enableMcp first' })

        return
      }

      if (method === 'GET') {
        json(res, 200, {
          enabled: mcp.settings.enabled,
          grants: mcp.store.all().map(grant => ({
            ...mcpGrantView(grant),
            user_id: grant.userId,
            revoked_at: grant.revokedAt,
            revoked_by: grant.revokedBy
          }))
        })

        return
      }

      const body = await readBody(req)
      const text = (key: string): string | null | undefined =>
        body[key] === null ? null : typeof body[key] === 'string' ? (body[key] as string) : undefined
      const integer = (key: string): number | null | undefined =>
        body[key] === null ? null : Number.isInteger(body[key]) ? (body[key] as number) : undefined
      const user = 'user' in body ? resolveUser(body.user) : undefined
      const userId = typeof user === 'string' ? user : accounts[0] ? userKey(identityOfAccount(accounts[0])) : ''
      const clientName = text('client_name') ?? 'Claude Code'

      if (!userId || !clientName.trim()) {
        json(res, 400, { detail: 'user must name an account and client_name must say something' })

        return
      }

      if (
        body.scopes !== undefined &&
        !(Array.isArray(body.scopes) && body.scopes.every(scope => typeof scope === 'string'))
      ) {
        json(res, 400, { detail: 'scopes must be a list of strings' })

        return
      }

      const input: McpGrantInput = {
        userId,
        clientName,
        ...(text('id') ? { id: text('id') as string } : {}),
        ...(text('client_id') ? { clientId: text('client_id') as string } : {}),
        ...(Array.isArray(body.scopes) ? { scopes: body.scopes as string[] } : {}),
        ...(typeof integer('created_at') === 'number' ? { createdAt: integer('created_at') as number } : {}),
        ...(text('created_ip') !== undefined ? { createdIp: text('created_ip') as string | null } : {}),
        ...(text('created_user_agent') !== undefined
          ? { createdUserAgent: text('created_user_agent') as string | null }
          : {}),
        ...(integer('last_used_at') !== undefined ? { lastUsedAt: integer('last_used_at') as number | null } : {}),
        ...(text('last_used_ip') !== undefined ? { lastUsedIp: text('last_used_ip') as string | null } : {}),
        ...(typeof integer('expires_at') === 'number' ? { expiresAt: integer('expires_at') as number } : {})
      }

      try {
        const grant = mcp.store.seed(input)
        // A consent is what a person's open Settings page should hear about; a test that has no page
        // open, or wants none, says `announce: false`.
        const delivered = body.announce === false ? 0 : mcp.announce('granted', grant)

        json(res, 200, { grant: { ...mcpGrantView(grant), user_id: grant.userId }, delivered })
      } catch (error) {
        json(res, 400, { detail: error instanceof Error ? error.message : String(error) })
      }

      return
    }

    /*
      The passkey level's control surface. Never part of the gateway contract: it plays the operator (who
      lists base URLs, mints a code with `hermes dashboard passkey invite`, revokes with the CLI) and the
      clock (a request timing out, a window running out), which a client under test has no way to do.
    */
    if (path.startsWith('/__fake/passkey/') && method === 'POST') {
      const body = await readBody(req)
      const action = path.slice('/__fake/passkey/'.length)

      if (action === 'enable') {
        try {
          const gateway = enablePasskey({
            ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
            ...(body.base_urls === undefined ? {} : { baseUrls: body.base_urls as string[] }),
            ...(body.rps === undefined ? {} : { nativeRps: body.rps as Record<string, string[]> }),
            ...(typeof body.allow_private === 'boolean' ? { allowPrivateBaseUrls: body.allow_private } : {}),
            ...(typeof body.user_invites === 'boolean' ? { userInvites: body.user_invites } : {}),
            ...(typeof body.provider_reauth === 'boolean' ? { providerReauth: body.provider_reauth } : {}),
            ...(body.self_enrol === undefined ? {} : { selfEnrol: selfEnrolOptions(body.self_enrol) })
          })

          json(res, 200, passkeyView() ?? { enabled: gateway.settings.enabled })
        } catch (error) {
          if (error instanceof SettingsError) {
            json(res, 400, { detail: error.message })

            return
          }

          throw error
        }

        return
      }

      if (!passkey || !confirmGate) {
        json(res, 409, { detail: 'This gateway does not know the passkey level; POST /__fake/passkey/enable first' })

        return
      }

      if (action === 'code') {
        // `hermes dashboard passkey invite [--user ID] [--ttl]`: the operator's code, optionally bound.
        const bound = 'user' in body ? resolveUser(body.user) : undefined

        if (body.ttl !== undefined && (typeof body.ttl !== 'number' || body.ttl < 60 || body.ttl > 24 * 3600)) {
          json(res, 400, { detail: 'ttl is a number of seconds from 60 to 86400' })

          return
        }

        const invite = passkey.store.mintCode({
          ...(bound ? { userId: bound } : {}),
          ...(typeof body.ttl === 'number' ? { ttl: body.ttl } : {})
        })

        json(res, 200, { code: invite.code, expires_at: invite.expiresAt, user_id: invite.userId })

        return
      }

      if (action === 'revoke') {
        // `hermes dashboard passkey revoke <id prefix>` or `revoke --user ID --all`: the operator's CLI, a
        // different process from the gateway, so nothing is announced unless `announce` asks for it.
        const revoked = []
        const user = 'user' in body ? resolveUser(body.user) : undefined

        if (typeof body.credential_id === 'string' && body.credential_id) {
          for (const found of passkey.store.find(body.credential_id)) {
            const done = passkey.store.revoke(found.credentialId, { by: 'operator' })

            if (done) {
              revoked.push(done)
            }
          }
        } else if (body.all === true && typeof user === 'string') {
          revoked.push(...passkey.store.revokeUser(user, 'operator'))
        } else {
          json(res, 400, { detail: 'name a credential_id (or its prefix), or a user with all: true' })

          return
        }

        if (body.announce === true) {
          for (const credential of revoked) {
            passkey.announce(credential.userId, 'revoked', credential)
          }
        }

        json(res, 200, { revoked: revoked.map(c => ({ id: b64u(c.credentialId), user_id: c.userId })) })

        return
      }

      if (action === 'reauth') {
        // What the next simulated re-authentication reports (contract §7.2): the provider is the fake, so a test
        // says what it saw. `{}` or `clear: true` goes back to a plain fresh sign-in of the grant's own person.
        const script = scriptOf(body)

        if (typeof script === 'string') {
          json(res, 400, { detail: script })

          return
        }

        passkey.signInScript = script

        json(res, 200, { script: scriptView(script) })

        return
      }

      if (action === 'expire') {
        // Time passing. With no flag: every open `confirm` times out now (`request.cancel timeout`);
        // `request_id` names one. `pending` ends the open registrations and step-ups, `codes` the
        // enrolment codes, `grants` the re-authentication grants, `window` the no-downgrade window and the
        // per-conversation limits.
        const flags = {
          pending: body.pending === true,
          codes: body.codes === true,
          grants: body.grants === true,
          window: body.window === true
        }
        const any = flags.pending || flags.codes || flags.grants || flags.window
        const answer: Record<string, number | boolean> = {}

        if (typeof body.request_id === 'string' || !any) {
          answer.requests = confirmGate.expire(typeof body.request_id === 'string' ? body.request_id : undefined)
        }

        if (flags.pending) {
          answer.pending = passkey.store.expirePending()
        }

        if (flags.codes) {
          answer.codes = passkey.store.expireCodes()
        }

        if (flags.grants) {
          answer.grants = passkey.store.expireGrants()
        }

        if (flags.window) {
          confirmGate.resetWindows()
          passkey.resetLimits()
          answer.window = true
        }

        json(res, 200, answer)

        return
      }

      if (action === 'changed') {
        // A `passkey.changed` to a user's live connections without a change behind it.
        const user = 'user' in body ? resolveUser(body.user) : undefined
        const target = typeof user === 'string' ? user : accounts[0] ? userKey(identityOfAccount(accounts[0])) : ''
        const credential = (body.credential ?? {}) as Record<string, unknown>
        const delivered = passkey.announceRaw(target, {
          change: body.change === 'revoked' ? 'revoked' : 'added',
          credential: {
            id: typeof credential.id === 'string' ? credential.id : b64u(Buffer.from('fake-credential')),
            name: typeof credential.name === 'string' ? credential.name : 'Fake passkey',
            rp_id: typeof credential.rp_id === 'string' ? credential.rp_id : 'confirm.hermie.dev'
          },
          at: passkey.store.now()
        })

        json(res, 200, { delivered, user_id: target })

        return
      }

      json(res, 404, { detail: `Unknown passkey control action: ${action}` })

      return
    }

    if (path === '/__fake/request' && method === 'POST') {
      /*
        The same control surface for a server→client REQUEST, and it exists for
        one reason: `clarify` had no way in from outside the process.

        A prompt keyword raises an approval and a fan-out, so both could be
        driven from a browser by typing a sentence — a clarify could only be
        raised by a test holding the gateway object, which left the clarify
        sheet the one question card nobody had ever opened by hand. Every web QA
        pass so far has listed it as not covered for exactly that reason.

        It does NOT await the answer: a control call that parked until a human
        clicked a button would hold its HTTP response open for as long as the
        sheet stayed up, and the caller wants the request raised, not answered.
      */
      const body = await readBody(req)
      const profile = String(body.profile ?? 'researcher')
      const session = [...state.sessions.values()].find(entry => entry.profile === profile)

      if (!session) {
        json(res, 404, { detail: `No session for profile ${profile}` })

        return
      }

      const requestMethod = String(body.method ?? 'clarify')
      const params = (body.params ?? {}) as Record<string, unknown>

      /*
        An interactive request (`input.form`, `input.file`, `review.draft`, `review.diff`, `input.signature`,
        `device.location`, `device.contact`, `device.calendar`, `device.scan`): the params are the contract's
        example for the method with whatever the caller gives laid over them, the frame goes only to the
        connections that advertised the method (409 `no_capable_client` when there are none), and the answer is
        the request's id. What became of it is `GET /__fake/request/<id>`.

        The gateway's own refusals are 409 too, with nothing sent: `already_pending` (one request is open per
        conversation, whichever method), `rate_limited` (twelve per ten minutes, `device.*` six) and, with
        `"user": null` (the turn acts for nobody in a shared conversation), `no_acting_user` for `review.*`,
        `input.signature` and `device.*`. `POST /__fake/request-limits` turns the limits off or resets them.

        A `device.calendar` raised with `params.item` has the item built by the gateway's builder: its text is
        cleaned, anything over a bound or inconsistent is a 400 `item_refused` with the sentence the agent
        would get, nothing sent. Every other param is NOT validated: a frame the gateway would never send (the
        `invalid_frames`) can be raised on purpose.

        A `review.diff` may carry `params.diff` (and `params.path`, when the diff has no `---`/`+++` lines)
        instead of hunks: the gateway's parser reads it, so `kind`, `path`, `old_path`, the numbered `hunks`
        and each `anchor` are the gateway's, and a diff it refuses is a 400 `diff_refused` with the sentence
        the agent would get, nothing sent.
      */
      if (isInteractiveMethod(requestMethod)) {
        const raised = raiseInteractive({
          profile,
          method: requestMethod,
          params: typeof body.params === 'object' && body.params !== null ? params : {},
          ...('user' in body ? { user: resolveUser(body.user) ?? null } : {})
        })

        // Params the gateway would refuse to build (a diff, a calendar item): nothing is sent.
        if (raised.kind === 'refused') {
          json(res, 400, { error: raised.error, detail: raised.detail })

          return
        }

        if (raised.kind === 'unavailable') {
          json(res, 409, {
            error: raised.reason,
            detail: {
              no_capable_client: `No connected client advertised "${requestMethod}" in client.capabilities; nothing was sent`,
              no_acting_user: `The turn acts for nobody in a shared conversation, so "${requestMethod}" is put to no one; nothing was sent`,
              already_pending: 'An interactive request is already open in this conversation; nothing was sent',
              rate_limited: `Too many ${requestMethod.startsWith('device.') ? 'device ' : ''}requests in the last ten minutes; nothing was sent`
            }[raised.reason],
            outcome: 'unavailable'
          })

          return
        }

        // `no_session` was ruled out above: the profile has one.
        if (raised.kind === 'raised') {
          json(res, 200, {
            id: raised.id,
            raised: requestMethod,
            session_id: session.id,
            expires_at: raised.expiresAt
          })
        }

        return
      }

      /*
        On a gateway that knows the level `passkey` a `confirm` takes the real gateway's gated path, and
        the control call can say who the turn acts for. `user` (top level of the body) is
        `<provider>:<id>`, an account's user id or username; absent it is the gateway's default account,
        and `null` is a turn nobody signed in submitted. `timeout_seconds` shortens the 120 s, and
        `turn_isolation: true` stages the agent running where it cannot see who advertised what.

        It still does NOT await the answer: the outcome is in `GET /__fake/state` under
        `passkey.outcomes`, and nothing sent is a 409 that says why.
      */
      if (requestMethod === 'confirm' && confirmGate) {
        let text

        try {
          text = buildText(confirmTextInput(session.storedId, params))
        } catch (error) {
          if (error instanceof ConfirmParamsError) {
            json(res, 400, { detail: error.message })

            return
          }

          throw error
        }

        const raised = confirmGate.raise({
          sessionId: session.id,
          conversation: session.storedId,
          text,
          ...('user' in body ? { user: resolveUser(body.user) ?? null } : {}),
          ...(body.turn_isolation === true ? { turnIsolation: true } : {}),
          ...(typeof body.timeout_seconds === 'number' ? { timeoutSeconds: body.timeout_seconds } : {})
        })

        if (raised.kind === 'unavailable') {
          json(res, 409, {
            detail:
              raised.reason === 'no_capable_client'
                ? text.fields?.length
                  ? `No connected client can show the fields of a "${text.level}" confirm (confirm_fields${text.level === 'passkey' ? ' and confirm_passkey v 2' : ''} in client.capabilities); nothing was sent`
                  : `No connected client offered the "${text.level}" confirm level in client.capabilities; nothing was sent`
                : `The confirm is unavailable (${raised.reason}); nothing was sent`,
            outcome: 'unavailable',
            reason: raised.reason
          })

          return
        }

        json(res, 200, { raised: 'confirm', session_id: session.id, request_id: raised.id, level: text.level })

        return
      }

      /*
        A `confirm` is gated on the level, as on the real gateway: it goes only to
        a connection that offered it in `client.capabilities`. Raising one nobody
        offered would leave a question open that no client was ever sent, so the
        control call says so instead — with nothing raised.
      */
      if (requestMethod === 'confirm') {
        let built

        try {
          built = permissiveConfirmExtras(session.storedId, params)
        } catch (error) {
          if (error instanceof ConfirmParamsError) {
            json(res, 400, { detail: error.message })

            return
          }

          throw error
        }

        // A request with fields goes only to connections that show them: nobody is asked to confirm less than
        // the agent asked.
        if (socketsOfferingConfirm(confirmLevelOf(params), built.fields !== undefined).length === 0) {
          json(
            res,
            409,
            built.fields === undefined
              ? {
                  detail: `No connected client offered the "${confirmLevelOf(params)}" confirm level in client.capabilities; nothing was sent`
                }
              : {
                  detail: `No connected client can show the fields of a "${confirmLevelOf(params)}" confirm (confirm_fields in client.capabilities); nothing was sent`,
                  outcome: 'unavailable',
                  reason: 'no_capable_client'
                }
          )

          return
        }

        // What goes out is the cleaned text with the fields and the draft's detail, as the gate builds it.
        Object.assign(params, built.params)
      }

      // An approval with a queue id is a queue entry, as the real gateway's
      // always is: `approval.pending` lists it until it is answered or withdrawn,
      // so a client that re-validates before answering finds it there.
      const queueId = requestMethod === 'approval' && typeof params.request_id === 'string' ? params.request_id : ''

      if (queueId) {
        state.pendingApprovals.set(queueId, { session_id: session.storedId, payload: params })
      }

      void requestServerSide(requestMethod, { session_id: session.id, ...params })
        .catch(() => {
          // The client refusing or the socket closing is the caller's business,
          // not this endpoint's: it has already answered.
        })
        .finally(() => {
          if (queueId) {
            state.pendingApprovals.delete(queueId)
          }
        })

      json(res, 200, { raised: requestMethod, session_id: session.id })

      return
    }

    if (path === '/__fake/request-limits' && method === 'POST') {
      // The gateway's own limits on interactive requests: `{enabled?: boolean, reset?: boolean}`.
      const body = await readBody(req)

      json(
        res,
        200,
        interactiveLimits({
          ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
          ...(body.reset === true ? { reset: true } : {})
        })
      )

      return
    }

    const interactiveRoute = /^\/__fake\/request\/([^/]+)(\/expire)?$/.exec(path)

    if (interactiveRoute) {
      /*
        What became of an interactive request: `{id, method, open, answer?, refusals}` (and the outcome,
        the client's error or the reason, once it ended). `POST .../expire` is the gateway stopping to
        wait right now (`request.cancel timeout`) rather than at `expires_at`.
      */
      const id = decodeURIComponent(interactiveRoute[1] as string)
      const view = interactive.view(id)

      if (!view) {
        json(res, 404, { error: 'unknown_request', detail: `No interactive request ${id}` })

        return
      }

      if (interactiveRoute[2] && method === 'POST') {
        interactive.expire(id)
        json(res, 200, interactive.view(id))

        return
      }

      if (!interactiveRoute[2] && method === 'GET') {
        json(res, 200, view)

        return
      }

      json(res, 405, { detail: `Method ${method} not allowed on ${path}` })

      return
    }

    if (path === '/__fake/files' && method === 'GET') {
      // What the upload route received, in the order it arrived: where it landed, how big, and its SHA-256,
      // which is what an `input.file` answer has to quote.
      json(res, 200, {
        files: [...state.uploadedFiles.values()].map(file => ({
          path: file.path,
          name: file.filename,
          mime: file.contentType,
          bytes: file.bytes,
          sha256: file.sha256
        }))
      })

      return
    }

    if (path === '/__fake/files/content' && method === 'GET') {
      // The bytes the upload route received at `?path=`, raw; 404 when nothing was uploaded there.
      const file = state.uploadedFiles.get(url.searchParams.get('path') ?? '')

      if (!file) {
        json(res, 404, { detail: 'No uploaded file at that path' })

        return
      }

      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': file.content.length })
      res.end(file.content)

      return
    }

    /*
      The dashboard's static route for a plugin. On a gated gateway it sits behind
      the same gate as everything that is not public (the next block); on a
      gateway with a session token, or none, the files are public — the same
      exposure as the dashboard's own bundle, with every `/api/*` call still
      needing the token.
    */
    if (path.startsWith('/dashboard-plugins/') && (!gated() || httpAuthorized(req))) {
      servePluginAsset(req, res, path)

      return
    }

    /*
      `GET /` on a gateway with a session token: the dashboard's own `index.html`,
      which is where the token is handed to a page the gateway serves. It is not
      served on a gated gateway (there the page itself is behind the gate) and a
      gateway with no auth has no token to hand out.
    */
    if (state.auth === 'token' && path === '/' && method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': PLUGIN_ASSET_CACHE_CONTROL
      })
      res.end(tokenIndexHtml(state.token))

      return
    }

    if (!httpAuthorized(req)) {
      if (state.auth === 'cookie') {
        rejectUnauthenticated(req, res, url)

        return
      }

      json(res, 401, { detail: 'Unauthorized' })

      return
    }

    if (passkey && (path === PASSKEY_PREFIX || path.startsWith(`${PASSKEY_PREFIX}/`))) {
      // Behind the gate, as every route here is: the answer names the caller's own passkeys only.
      const handled = await handlePasskeyRoute(passkey, req, res, {
        identity: identityOfRequest(req),
        auth: bearerOf(req) ? 'bearer' : 'cookie',
        ip: req.socket.remoteAddress ?? ''
      })

      if (handled) {
        return
      }
    }

    if (mcp && (path === MCP_PREFIX || path.startsWith(`${MCP_PREFIX}/`))) {
      // Behind the gate, as every route here is: the answer names the caller's own grants only.
      const handled = await handleMcpRoute(mcp, req, res, {
        identity: identityOfRequest(req),
        auth: bearerOf(req) ? 'bearer' : 'cookie',
        ip: req.socket.remoteAddress ?? ''
      })

      if (handled) {
        return
      }
    }

    if (path === '/api/auth/me') {
      /*
        The CALLER's identity, not a fixed one.

        `dashboard_auth/routes.py` answers whoever the request's own credential
        belongs to, which is the only way two people on one gateway can be told
        apart. Cookie mode reads the cookie; a bearer reads the account the
        token was issued to; a token or ungated gateway has no accounts at all
        and answers with the single tester, which is what every test that
        predates this option already expects.
      */
      const signedIn = state.auth === 'cookie' ? sessionCookies.get(cookieOf(req, SESSION_COOKIE)) : undefined
      const who = signedIn ?? accounts[0]!

      json(res, 200, {
        user_id: who.userId,
        email: who.email,
        display_name: who.displayName,
        org_id: '',
        provider: gated() ? 'self-hosted' : 'none',
        // Absent on most deployments; the fake sends it only when a test asked
        // for one, so nothing reads a `[]` as "this gateway has roles".
        ...(who.roles.length ? { roles: who.roles } : {}),
        // Only when the gateway holds a copy, as the fork sends it.
        ...(gated() && pictures.has(`self-hosted:${who.userId}`)
          ? { picture_url: `/api/auth/picture?id=${encodeURIComponent(`self-hosted:${who.userId}`)}` }
          : {}),
        expires_at: nowSeconds() + 3600
      })

      return
    }

    if (path === '/api/auth/picture' && method === 'GET') {
      /*
        Behind the gate like the rest of `/api/auth`, so it is only reached signed in. The bytes are
        the gateway's own copy of what the identity provider sent, found by the id a message row's
        `author.id` carries; an id it holds none for is a 404 (the client then draws the initial).
      */
      const id = url.searchParams.get('id') ?? ''
      const bytes = pictures.get(id)

      state.pictureRequests.push(id)

      if (!bytes) {
        json(res, 404, { detail: 'No picture' })

        return
      }

      res.writeHead(200, {
        'content-type': pictureContentType(bytes),
        'content-length': bytes.length,
        'cache-control': 'private, max-age=0'
      })
      res.end(bytes)

      return
    }

    if (path === '/api/auth/ws-ticket' && method === 'POST') {
      if (state.failNextTicketMints > 0) {
        state.failNextTicketMints -= 1
        state.ticketMintsFailed += 1
        json(res, 503, { detail: 'ticket store unavailable' })

        return
      }

      const ticket = `tk-${randomUUID()}`
      const ticketIdentity = identityOfRequest(req)

      tickets.set(ticket, {
        expiresAt: Date.now() + TICKET_TTL_SECONDS * 1000,
        userId: 'tester@example.invalid',
        provider: gated() ? 'self-hosted' : 'none',
        ...(ticketIdentity ? { identity: ticketIdentity } : {})
      })
      state.ticketsMinted += 1
      json(res, 200, { ticket, ttl_seconds: TICKET_TTL_SECONDS })

      return
    }

    if (path === '/api/profiles') {
      json(res, 200, { profiles: state.profiles })

      return
    }

    const profileMatch = /^\/api\/profiles\/([^/]+)$/.exec(path)

    if (profileMatch && method === 'PATCH') {
      await handleProfileRename(req, res, decodeURIComponent(profileMatch[1] as string))

      return
    }

    if (path === '/api/files/upload-stream' && method === 'POST') {
      await handleFileUpload(req, res)

      return
    }

    if (path.startsWith('/api/files/images/')) {
      serveAttachedImage(req, res, url)

      return
    }

    if (path.startsWith('/api/files/outbox/')) {
      serveOutbox(req, res, url)

      return
    }

    if (path === '/api/cron/delivery-targets') {
      // `local` is implicit on every gateway; the second one is a configured
      // bot chat, which is what a delivery target looks like once the messaging
      // gateway is set up.
      json(res, 200, {
        targets: [
          { id: 'local', name: 'Local (save only)', home_target_set: true, home_env_var: null },
          { id: 'bot-chat:researcher', name: 'Bot Chat (researcher)', home_target_set: true, home_env_var: null }
        ]
      })

      return
    }

    const displayNameMatch = /^\/api\/plugins\/hermie\/profiles\/([^/]+)$/.exec(path)

    if (displayNameMatch && method === 'PATCH') {
      await handleProfileDisplayName(req, res, decodeURIComponent(displayNameMatch[1] as string))

      return
    }

    if (path === '/api/plugins/hermie/context/turn' && method === 'POST') {
      await handleTurnClaim(req, res)

      return
    }

    if (path.startsWith('/api/plugins/')) {
      await handleMemory(req, res, path, method, url.searchParams)

      return
    }

    if (path.startsWith('/api/cron/jobs')) {
      await handleCron(req, res, path, method, url.searchParams)

      return
    }

    if (path.startsWith('/api/audio/') && (await handleAudio(req, res, path, method, url.searchParams))) {
      return
    }

    /*
     * `GET /api/sessions/search` — `sessions.py::search_sessions`.
     *
     * Declared before the templated `/api/sessions/{id}/messages` for the same
     * reason upstream mounts `search_router` before `manage_router`: an
     * unconstrained `{session_id}` would otherwise swallow the literal path.
     *
     * Three behaviours are reproduced because the app depends on each of them,
     * and one is deliberately NOT: there is no compression lineage in this
     * fake, so a session is its own root and the dedup below is by session id.
     *
     *  - A blank or whitespace `q` answers `{"results": []}` without reading
     *    anything, so a debounce that fires on an empty field is free.
     *  - `limit` is clamped to 1…100.
     *  - The search is PER PROFILE. Upstream opens that profile's own
     *    `state.db`; an unknown profile is a 404 from `_cron_profile_home`, not
     *    an empty result, and the app's fan-out has to survive one.
     *  - Hits collapse to one per session, id matches first, and the snippet
     *    wraps the matched run in `>>>`/`<<<` the way
     *    `snippet(messages_fts, -1, '>>>', '<<<', '...', 40)` does.
     */
    if (path === '/api/sessions/search') {
      const rawQuery = url.searchParams.get('q') ?? ''
      const profile = url.searchParams.get('profile')

      if (!rawQuery.trim()) {
        json(res, 200, { results: [] })

        return
      }

      if (profile && !state.profiles.some(entry => entry.name === profile)) {
        json(res, 404, { detail: `Profile '${profile}' does not exist.` })

        return
      }

      const limit = Math.max(1, Math.min(Number.parseInt(url.searchParams.get('limit') ?? '20', 10) || 20, 100))
      const sessions = [...state.sessions.values()].filter(session => !profile || session.profile === profile)

      json(res, 200, { results: searchFakeSessions(sessions, rawQuery, limit) })

      return
    }

    /*
     * `GET /api/analytics/usage` — `analytics.py::get_usage_analytics`: one profile's days (see `usage.ts`).
     * `days` outside 1…365 is a 422 (FastAPI's `Query(ge=1, le=365)`), an unknown profile a 404 as for the
     * search, and a gateway that was staged without the route (`POST /__fake/usage`) a plain 404.
     */
    if (path === '/api/analytics/usage' && method === 'GET') {
      if (state.usage.unsupported) {
        json(res, 404, { detail: 'Not Found' })

        return
      }

      const profile = url.searchParams.get('profile')
      const refusal = daysRefusal(url.searchParams.get('days'))

      if (refusal) {
        json(res, 422, refusal)

        return
      }

      if (profile && !state.profiles.some(entry => entry.name === profile)) {
        json(res, 404, { detail: `Profile '${profile}' does not exist.` })

        return
      }

      const days = Number.parseInt(url.searchParams.get('days') ?? '30', 10)
      const owner = profile ?? state.profiles.find(entry => entry.is_default)?.name ?? LAUNCH_PROFILE

      json(res, 200, usageAnalytics(usageDaysOf(state.usage, owner, days, nowSeconds()), days))

      return
    }

    const messagesMatch = /^\/api\/sessions\/([^/]+)\/messages$/.exec(path)

    if (messagesMatch) {
      const session = resolveSession(decodeURIComponent(messagesMatch[1] as string))

      if (!session) {
        json(res, 404, { detail: 'Unknown session' })

        return
      }

      const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10)
      const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') ?? '0', 10) || 0)
      // `order` defaults to `oldest` upstream, not `latest`. The fake said
      // `latest`, which nothing noticed because every caller sends the parameter.
      const order = url.searchParams.get('order') ?? 'oldest'
      /*
        `offset` used to be parsed, echoed in `pagination` and then ignored —
        a fake advertising paging it did not do, which is the one kind of
        infidelity that cannot be caught by a test written against the fake.

        It skips from the end `order` names: from the NEWEST row for `latest`,
        from the oldest otherwise. Either way the page comes back oldest first.
        Measured against a real gateway on 2026-09-21: on a six-row session,
        `?limit=2&order=latest&offset=2` answers the third and fourth rows, in
        that order, and an offset past the end answers an empty list rather than
        an error.
      */
      const rows =
        order === 'latest'
          ? session.messages.slice(
              Math.max(0, session.messages.length - offset - limit),
              Math.max(0, session.messages.length - offset)
            )
          : session.messages.slice(offset, offset + limit)
      // `sessions.py::_get_session_messages` — the envelope names the session it
      // read and pages with `pagination`. It has no `count`, which is what the
      // fake used to send and what nothing on either side ever read.
      json(res, 200, {
        session_id: session.storedId,
        profile: session.profile,
        messages: rows.map(restMessageRow),
        pagination: { limit, offset, order, returned: rows.length }
      })

      return
    }

    json(res, 404, { detail: `No route for ${method} ${path}` })
  }

  /**
   * The staged identity provider and the gateway callback in front of it (see
   * `FakeGatewayOptions.idp`). Cookies carry the whole round trip, as they do
   * between a real gateway and a real provider: nothing here trusts a query
   * parameter that a cookie should have carried.
   */
  async function handleStagedIdp(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    path: string,
    method: string
  ): Promise<void> {
    const redirect = (location: string, cookies: string[] = [], status = 303) => {
      res.writeHead(status, { location, ...(cookies.length > 0 ? { 'set-cookie': cookies } : {}) })
      res.end()
    }
    const session = cookieOf(req, 'idp_session')
    const signedIn = session !== '' && idpSessions.has(session)

    // A fresh connection for every hop. A person takes longer over a form than Node keeps an idle
    // connection, and a browser that posts the form on the connection Node just closed reports a
    // lost connection (a POST is not retried) instead of the next page.
    res.setHeader('connection', 'close')

    if (path === '/__idp/authorize' && method === 'GET') {
      const request = randomUUID()

      idpRequests.set(request, {
        state: url.searchParams.get('state') ?? '',
        redirectUri: url.searchParams.get('redirect_uri') ?? ''
      })

      const consent = `/__idp/consent?request=${request}`

      // Where to go once signed in: a cookie, not a query parameter.
      redirect(signedIn ? consent : '/__idp/login', [stagedCookie('idp_next', consent, { path: '/', maxAge: 600 })])

      return
    }

    if (path === '/__idp/login' && method === 'GET') {
      html(res, 200, stagedPage('Sign in', stagedLoginForm('')))

      return
    }

    if (path === '/__idp/login' && method === 'POST') {
      const form = await readForm(req)

      if (form.get('username') !== passwordAccount.username || form.get('password') !== passwordAccount.password) {
        html(res, 200, stagedPage('Sign in', stagedLoginForm('Wrong username or password.')))

        return
      }

      const challenge = randomUUID()

      idpChallenges.add(challenge)
      redirect('/__idp/verify', [stagedCookie('idp_pending', challenge, { path: '/__idp', maxAge: 300 })])

      return
    }

    if (path === '/__idp/verify' && method === 'GET') {
      if (!idpChallenges.has(cookieOf(req, 'idp_pending'))) {
        redirect('/__idp/login')

        return
      }

      html(res, 200, stagedPage('Verify', stagedVerifyForm('')))

      return
    }

    if (path === '/__idp/verify' && method === 'POST') {
      const form = await readForm(req)
      const pending = cookieOf(req, 'idp_pending')
      // Burned on the first try, right or wrong, like the real provider's challenge.
      const live = pending !== '' && idpChallenges.delete(pending)
      const cleared = stagedCookie('idp_pending', '', { path: '/__idp', maxAge: 0 })

      if (!live) {
        res.setHeader('set-cookie', cleared)
        html(res, 200, stagedPage('Verify', stagedVerifyForm('This sign-in expired. Sign in again.')))

        return
      }

      if (form.get('code') !== stagedTotpCode) {
        res.setHeader('set-cookie', cleared)
        html(res, 200, stagedPage('Verify', stagedVerifyForm('That code is not right.')))

        return
      }

      const created = randomUUID()
      const next = cookieOf(req, 'idp_next')

      idpSessions.add(created)
      redirect(next.startsWith('/__idp/') ? next : '/__idp/home', [
        cleared,
        stagedCookie('idp_session', created, { path: '/', maxAge: 14 * 24 * 3600 }),
        stagedCookie('idp_next', '', { path: '/', maxAge: 0 })
      ])

      return
    }

    if (path === '/__idp/consent' && method === 'GET') {
      if (!signedIn) {
        redirect('/__idp/login')

        return
      }

      const id = url.searchParams.get('request') ?? ''
      const request = idpRequests.get(id)

      if (!request) {
        html(res, 200, stagedPage('Expired', '<p>This sign-in expired. Start again in the app.</p>'))

        return
      }

      idpRequests.delete(id)

      const code = `idp-${randomUUID()}`
      const target = new URL(request.redirectUri, 'http://placeholder')

      idpCodes.set(code, request.state)
      target.searchParams.set('code', code)
      target.searchParams.set('state', request.state)
      redirect(`${target.pathname}${target.search}`)

      return
    }

    if (path === '/__idp/home' && method === 'GET') {
      html(res, 200, stagedPage('Signed in', '<p>Signed in at the provider.</p>'))

      return
    }

    if (path === '/auth/callback' && method === 'GET') {
      // `routes.py::auth_callback`, in its order.
      const [broker = '', idpState = ''] = cookieOf(req, 'hermes_session_pkce').split('.')
      const pending = brokers.get(broker)

      if (!pending) {
        json(res, 400, { detail: 'Missing PKCE state cookie' })

        return
      }

      const state = url.searchParams.get('state') ?? ''

      if (!state || state !== idpState || pending.idpState !== idpState) {
        json(res, 400, { detail: 'OAuth state mismatch (CSRF check failed)' })

        return
      }

      const code = url.searchParams.get('code') ?? ''

      if (idpCodes.get(code) !== state) {
        json(res, 400, { detail: 'Invalid code: unknown or used' })

        return
      }

      idpCodes.delete(code)
      brokers.delete(broker)

      const gatewayCode = `code-${randomUUID()}`
      const target = new URL(pending.redirectUri)

      codes.set(gatewayCode, {
        challenge: pending.challenge,
        provider: pending.provider,
        ...(pending.reauth ? { reauth: pending.reauth } : {})
      })
      target.searchParams.set('code', gatewayCode)
      target.searchParams.set('state', pending.clientState)
      redirect(target.toString(), [stagedCookie('hermes_session_pkce', '', { path: '/', maxAge: 0 })], 302)

      return
    }

    json(res, 404, { detail: `No route for ${method} ${path}` })
  }

  /** A person-facing refusal of a sign-in that carries a `reauth` the gateway will not start: a page, never a redirect. */
  function reauthPage(res: ServerResponse, status: number, text: string, retryAfter = 0): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      ...(retryAfter ? { 'retry-after': String(retryAfter) } : {})
    })
    res.end(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Passkey set-up</title></head><body><main><p>${escapeHtml(text)}</p></main></body></html>`
    )
  }

  /**
   * `GET /auth/login?provider=…&reauth=<grant>&next=…` from the web client: the check runs before anything is
   * redirected or set (the grant must be open, unexpired, for this provider and bound to this browser's
   * `__Host-hermes_reauth` cookie), then the provider's re-authentication is *simulated*: the sign-in comes
   * straight back as the person the script says (the grant's own person unless it says otherwise), the grant is
   * completed with it, the browser is signed in as that person (a failed grant never undoes a sign-in) and sent
   * to `next`. The binding cookie is left alone: it is the grant's use binding until `register/finish`.
   */
  function handleWebReauthLogin(req: IncomingMessage, res: ServerResponse, url: URL, grantId: string): void {
    const provider = url.searchParams.get('provider') ?? ''
    const ip = req.socket.remoteAddress ?? ''

    if (provider !== REAUTH_PROVIDER) {
      json(res, 404, { detail: `Unknown provider: '${provider}'` })

      return
    }

    if (!passkey) {
      reauthPage(res, 400, REAUTH_EXPIRED_TEXT)

      return
    }

    // Reserved before anything is read; a check that finds the grant gives its slots back.
    const attempt = reauthBeginAttempt(passkey, ip, grantId)

    if (!attempt.allowed) {
      reauthPage(res, 429, 'Too many attempts. Try again shortly.', attempt.retryAfter)

      return
    }

    const secret = cookieValue(req.headers, REAUTH_COOKIE) || null
    const grant = reauthGrantForLogin(passkey, { grantId, provider, client: 'web', secret })

    if (!grant) {
      reauthPage(res, 400, REAUTH_EXPIRED_TEXT)

      return
    }

    attempt.succeeded()

    const outcome = completeReauth(passkey, grantId, { client: 'web', secret })
    // Whom the browser is signed in as: the person the sign-in reported, when the gateway knows them, else the
    // grant's own person.
    const account =
      accounts.find(row => `${REAUTH_PROVIDER}:${row.userId}` === outcome.facts?.user) ??
      accounts.find(row => `${REAUTH_PROVIDER}:${row.userId}` === grant.userId)

    const next = url.searchParams.get('next') ?? '/'
    const headers: Record<string, string> = { location: next.startsWith('/') && !next.startsWith('//') ? next : '/' }

    if (account) {
      const value = `sess-${randomUUID()}`

      sessionCookies.set(value, account)
      headers['set-cookie'] = `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/`
    }

    res.writeHead(302, headers)
    res.end()
  }

  function handleAuthorize(req: IncomingMessage, url: URL, res: ServerResponse): void {
    const challenge = url.searchParams.get('code_challenge') ?? ''
    const method = url.searchParams.get('code_challenge_method') ?? ''
    const redirectUri = url.searchParams.get('redirect_uri') ?? ''
    const clientState = url.searchParams.get('state') ?? ''
    const provider = url.searchParams.get('provider') || 'self-hosted'
    const reauthId = url.searchParams.get('reauth') ?? ''

    if (method.toUpperCase() !== 'S256' || !challenge) {
      json(res, 400, { detail: 'code_challenge_method must be S256' })

      return
    }

    if (!/^http:\/\/(127\.0\.0\.1|\[::1\])(:\d+)?\//.test(redirectUri)) {
      json(res, 400, { detail: 'native redirect_uri host must be a loopback IP literal (127.0.0.1 / ::1)' })

      return
    }

    if (reauthId) {
      // A sign-in made again to add a passkey: the grant is checked before any pending authorization or redirect.
      const ip = req.socket.remoteAddress ?? ''
      const named = url.searchParams.get('provider') ?? ''

      if (named && named !== REAUTH_PROVIDER) {
        json(res, 404, { detail: `Unknown provider: '${named}'` })

        return
      }

      if (!passkey) {
        reauthPage(res, 400, REAUTH_EXPIRED_TEXT)

        return
      }

      const attempt = reauthBeginAttempt(passkey, ip, reauthId)

      if (!attempt.allowed) {
        reauthPage(res, 429, 'Too many attempts. Try again shortly.', attempt.retryAfter)

        return
      }

      const grant = named
        ? reauthGrantForLogin(passkey, { grantId: reauthId, provider: named, client: 'native', secret: null })
        : reauthNativeGrantForLogin(passkey, reauthId)

      if (!grant) {
        reauthPage(res, 400, REAUTH_EXPIRED_TEXT)

        return
      }

      attempt.succeeded()
    }

    const redirect = () => {
      const code = `code-${randomUUID()}`
      // The fake gateway is its own identity provider: it stores the challenge
      // and checks the verifier against it at the token endpoint, like the real
      // one does.
      codes.set(code, { challenge, provider, ...(reauthId ? { reauth: reauthId } : {}) })
      const target = new URL(redirectUri)
      target.searchParams.set('code', code)
      target.searchParams.set('state', clientState)
      res.writeHead(302, { location: target.toString() })
      res.end()
    }

    if (stagedIdp) {
      // `routes.py::auth_native_authorize`: the client's challenge and state stay
      // here; only an opaque broker id rides in the gateway's own cookie.
      const broker = randomUUID()
      const idpState = randomUUID()

      brokers.set(broker, {
        challenge,
        provider,
        redirectUri,
        clientState,
        idpState,
        ...(reauthId ? { reauth: reauthId } : {})
      })

      const target = new URL('/__idp/authorize', 'http://placeholder')
      target.searchParams.set('state', idpState)
      target.searchParams.set('redirect_uri', '/auth/callback')
      res.writeHead(302, {
        location: `${target.pathname}${target.search}`,
        'set-cookie': stagedCookie('hermes_session_pkce', `${broker}.${idpState}`, { path: '/', maxAge: 600 })
      })
      res.end()

      return
    }

    if (url.searchParams.get('auto') === '1') {
      redirect()

      return
    }

    const formAction = new URL(url.toString())
    formAction.searchParams.set('auto', '1')

    html(
      res,
      200,
      `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Fake Hermes sign-in</title></head>
  <body style="font-family: system-ui; margin: 3rem auto; max-width: 30rem">
    <h1>Fake Hermes gateway</h1>
    <p>No real identity provider is involved. Approving issues a loopback code for
      <code>${escapeHtml(redirectUri)}</code>.</p>
    <form method="get" action="${escapeHtml(formAction.pathname)}">
      ${[...formAction.searchParams.entries()]
        .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
        .join('\n      ')}
      <button type="submit">Approve as tester</button>
    </form>
  </body>
</html>`
    )
  }

  /**
   * The REST cron surface, in `hermes_cli/web_routers/cron.py`'s shapes:
   * the list is a bare array, the detail routes answer the stored job itself
   * (no `{job: …}` wrapper), `/runs` answers `{runs, limit}` of session rows,
   * and `DELETE` answers `{ok: true}`.
   */
  /**
   * The Kanban plugin's routes, as `plugins/kanban/dashboard/plugin_api.py`
   * answers them.
   *
   * Four behaviours here are the ones a client gets wrong, and each exists so a
   * test can hold the app to them:
   *
   *  - a card's column IS its `status`, and the columns are a fixed list;
   *  - `POST /tasks` has NO `status` field — the server derives `triage` or
   *    `ready` — so landing anywhere else takes a second call;
   *  - `running` is refused outright with a 400, and a `ready` whose parents
   *    are not done is a 409 whose `detail` NAMES them;
   *  - archiving is `status: 'archived'`, which is recoverable, while
   *    `DELETE /tasks/{id}` is not.
   */
  async function handleKanban(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams
  ): Promise<void> {
    const boards = state.kanbanBoards ?? []
    const slug = (query.get('board') ?? '').trim() || boards[0]?.slug || 'default'
    const board = boards.find(entry => entry.slug === slug)

    if (path === '/boards' && method === 'GET') {
      json(res, 200, {
        boards: boards.map(entry => ({
          slug: entry.slug,
          name: entry.name,
          description: entry.description,
          is_current: entry.slug === boards[0]?.slug,
          // `list_boards` counts everything that is not archived.
          total: entry.tasks.filter(task => task.status !== 'archived').length
        })),
        current: boards[0]?.slug ?? ''
      })

      return
    }

    if (!board) {
      json(res, 404, { detail: `Unknown board: ${slug}` })

      return
    }

    if (path === '/board' && method === 'GET') {
      const withArchived = query.get('include_archived') === 'true'
      const columns = withArchived ? [...KANBAN_COLUMNS, 'archived'] : KANBAN_COLUMNS

      json(res, 200, {
        columns: columns.map(name => ({
          name,
          // `ORDER BY priority DESC, created_at ASC` — the only order there is.
          tasks: board.tasks
            .filter(task => task.status === name)
            .sort((a, b) => b.priority - a.priority || a.created_at - b.created_at)
            .map(kanbanTaskView)
        })),
        tenants: [],
        assignees: [...new Set(board.tasks.map(task => task.assignee).filter(Boolean))],
        latest_event_id: 0,
        now: Math.floor(Date.now() / 1000)
      })

      return
    }

    if (path === '/dispatch' && method === 'POST') {
      state.kanbanDispatches += 1
      json(res, 200, { spawned: [] })

      return
    }

    if (path === '/tasks' && method === 'POST') {
      const body = await readBody(req)
      const title = typeof body.title === 'string' ? body.title.trim() : ''

      if (!title) {
        json(res, 422, { detail: 'title is required' })

        return
      }

      const made: FakeKanbanTask = {
        id: `t_${(board.tasks.length + 1).toString(16).padStart(8, '0')}`,
        title,
        body: typeof body.body === 'string' ? body.body : null,
        // The whole of create's say over the landing column. There is no
        // `status` on `CreateTaskBody`, so anything else is a second call.
        status: body.triage === true ? 'triage' : 'ready',
        assignee: typeof body.assignee === 'string' ? body.assignee : null,
        priority: typeof body.priority === 'number' ? body.priority : 0,
        created_at: Math.floor(Date.now() / 1000),
        parents: [],
        comments: []
      }

      board.tasks.push(made)
      json(res, 200, { task: kanbanTaskView(made) })

      return
    }

    const taskMatch = /^\/tasks\/([^/]+)(\/[a-z]+)?$/u.exec(path)

    if (!taskMatch) {
      json(res, 404, { detail: 'Not Found' })

      return
    }

    const task = board.tasks.find(entry => entry.id === decodeURIComponent(taskMatch[1] as string))

    if (!task) {
      // A 404 WITH a detail: the router answering about one card, which is not
      // the same as the plugin being absent.
      json(res, 404, { detail: 'task not found' })

      return
    }

    if (taskMatch[2] === '/comments' && method === 'POST') {
      const body = await readBody(req)
      const text = typeof body.body === 'string' ? body.body.trim() : ''

      if (!text) {
        json(res, 400, { detail: 'comment body is required' })

        return
      }

      task.comments.push({
        id: task.comments.length + 1,
        // Defaulted server-side, which is why a client that cares sends its own.
        author: typeof body.author === 'string' && body.author ? body.author : 'dashboard',
        body: text,
        created_at: Math.floor(Date.now() / 1000)
      })

      // The comment it made is NOT returned; a caller has to re-read the task.
      json(res, 200, { ok: true })

      return
    }

    if (taskMatch[2] === undefined && method === 'GET') {
      json(res, 200, {
        task: kanbanTaskView(task),
        comments: task.comments,
        events: [],
        links: { parents: task.parents, children: [] },
        runs: []
      })

      return
    }

    if (taskMatch[2] === undefined && method === 'PATCH') {
      const body = await readBody(req)
      const status = typeof body.status === 'string' ? body.status : null

      if (status === 'running') {
        json(res, 400, { detail: KANBAN_RUNNING_REFUSAL })

        return
      }

      if (status && status !== 'archived' && !KANBAN_COLUMNS.includes(status)) {
        json(res, 400, { detail: `unknown status: ${status}` })

        return
      }

      if (status === 'ready') {
        const blocking = task.parents
          .map(id => board.tasks.find(entry => entry.id === id))
          .filter(parent => parent && parent.status !== 'done' && parent.status !== 'archived')

        if (blocking.length) {
          const named = blocking
            .map(parent => `'${parent?.title}' (${parent?.id}, status=${parent?.status})`)
            .join(', ')

          // The sentence the app shows verbatim: nothing on the client side can
          // work out which parent is in the way.
          json(res, 409, { detail: `Cannot move to 'ready': blocked by parent(s) not done — ${named}` })

          return
        }
      }

      if (status) {
        task.status = status
      }

      if (typeof body.title === 'string') {
        task.title = body.title
      }

      if (body.body === null || typeof body.body === 'string') {
        task.body = body.body as string | null
      }

      if (typeof body.assignee === 'string') {
        task.assignee = body.assignee
      }

      if (typeof body.priority === 'number') {
        task.priority = body.priority
      }

      json(res, 200, { task: kanbanTaskView(task) })

      return
    }

    json(res, 404, { detail: 'Not Found' })
  }

  /** One card on the wire, with the three keys the board route derives. */
  function kanbanTaskView(task: FakeKanbanTask): Record<string, unknown> {
    return {
      id: task.id,
      title: task.title,
      body: task.body,
      status: task.status,
      assignee: task.assignee,
      priority: task.priority,
      created_at: task.created_at,
      latest_summary: null,
      comment_count: task.comments.length,
      link_counts: { parents: task.parents.length, children: 0 }
    }
  }

  async function handleCron(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams
  ): Promise<void> {
    const profile = (query.get('profile') ?? '').trim()

    if (path === '/api/cron/jobs') {
      if (method === 'GET') {
        // `_list_cron_jobs_sync` defaults to "all" and walks every profile's
        // store; anything else is one profile. Either way each row comes back
        // annotated with the profile it was read out of.
        const wanted = profile || 'all'
        const rows =
          wanted.toLowerCase() === 'all' ? state.cronJobs : state.cronJobs.filter(entry => entry.profile === wanted)

        json(res, 200, rows.map(annotateCronJob))

        return
      }

      if (method === 'POST') {
        const body = await readBody(req)
        const refused = typeof body.schedule === 'string' ? scheduleRefusal(body.schedule) : null

        if (refused) {
          json(res, 400, { detail: refused })

          return
        }

        const job = addCronJob({ ...body, profile: profile || state.cronLaunchProfile })
        json(res, 200, annotateCronJob(job))

        return
      }
    }

    const match = /^\/api\/cron\/jobs\/([^/]+)(\/(pause|resume|trigger|runs))?$/.exec(path)

    if (!match) {
      json(res, 404, { detail: `No cron route for ${method} ${path}` })

      return
    }

    const wanted = decodeURIComponent(match[1] as string)
    // `_job_profile`: the given profile, else the first store that has a job by
    // that id or name. The walk is why these routes work without the parameter
    // and why two profiles with the same job name make it a coin toss.
    const candidates = profile ? state.cronJobs.filter(entry => entry.profile === profile) : state.cronJobs
    const action = match[3]
    // …but WHICH job, once the store is chosen, is `get_job`, and that matches
    // on the id alone. Only `/trigger` goes through `resolve_job_ref`, which is
    // the one place a name is allowed to stand in for an id. Accepting names
    // everywhere made `GET /api/cron/jobs/VM heartbeat` work here and 404 on a
    // real gateway.
    const byName = action === 'trigger'
    const job = candidates.find(entry => entry.id === wanted || (byName && entry.name === wanted))

    if (!job) {
      json(res, 404, { detail: 'Unknown job' })

      return
    }

    if (action === 'runs') {
      // Newest first, the way the id-range scan returns them. The echoed limit
      // is the REQUESTED one clamped to 1..100, not how many came back.
      const asked = Number.parseInt(query.get('limit') ?? '20', 10)
      const limit = Number.isFinite(asked) ? Math.min(100, Math.max(1, asked)) : 20
      const runs = [...job.runs].sort((a, b) => b.started_at - a.started_at).slice(0, limit)
      json(res, 200, { runs, limit })

      return
    }

    if (action === 'pause' || action === 'resume') {
      setCronPaused(job, action === 'pause')
      publish('cron.changed', undefined, {})
      json(res, 200, annotateCronJob(job))

      return
    }

    if (action === 'trigger') {
      json(res, 200, annotateCronJob(triggerCronJob(job)))

      return
    }

    if (method === 'GET') {
      json(res, 200, annotateCronJob(job))

      return
    }

    if (method === 'PUT') {
      const body = await readBody(req)
      // `CronJobUpdate` is `{updates: {...}}` and the route MERGES it; a client
      // that sends only a schedule must not lose the prompt.
      const updates = (isRecord(body.updates) ? body.updates : body) as Record<string, unknown>
      const refused = typeof updates.schedule === 'string' ? scheduleRefusal(updates.schedule) : null

      if (refused) {
        json(res, 400, { detail: refused })

        return
      }

      Object.assign(job, updates)

      if (typeof updates.schedule === 'string') {
        job.next_run_at = nextRunFor(updates.schedule)
      }

      publish('cron.changed', undefined, {})
      json(res, 200, annotateCronJob(job))

      return
    }

    if (method === 'DELETE') {
      state.cronJobs = state.cronJobs.filter(entry => entry.id !== job.id)
      publish('cron.changed', undefined, {})
      json(res, 200, { ok: true })

      return
    }

    json(res, 405, { detail: `Method ${method} not allowed on ${path}` })
  }

  /**
   * `POST /api/files/upload-stream`, in `hermes_cli/web_routers/files.py`'s shape.
   *
   * The interesting parts are the ones a client can get wrong, so all three are
   * reproduced: `path` is resolved through the managed-files policy (which has
   * NO locked root here, so it must be absolute — the real 400 a relative path
   * earns), the 100 MB cap answers 413 as the stream crosses it rather than
   * afterwards, and the result carries `path` as the RESOLVED path plus the
   * policy metadata the dashboard reads.
   */
  /**
   * `PATCH /api/profiles/{name}` — `profiles.py::_rename_profile`, Hermes 0.21.3.
   *
   * The one route that does two different things depending on which profile it
   * is aimed at, and the app depends on telling them apart from the ANSWER
   * rather than from its own idea of which profile is default:
   *
   *  - `default` cannot be renamed, because its home IS the installation root.
   *    Hermes turns the call into a presentation-only display name, keeps the
   *    canonical id and answers WITH `display_name`.
   *  - Any other profile is really renamed — directory, wrapper script, service
   *    and active-profile pointer — and answers WITHOUT `display_name`.
   *
   * What the setter validates is only `.strip()` and 64 characters
   * (`profiles.py::set_profile_display_name`): no character set and no
   * uniqueness. `rename_profile` refuses an empty new name for `default` before
   * the setter sees it, which is the 400 below.
   */
  /**
   * `/api/plugins/hermie/memory/…` — the plugin's `dashboard/plugin_api.py`.
   *
   * Four routes, and the shapes come from the plugin's own `memory/browse.py`
   * rather than from a reading of what an app would like. Three properties of
   * that file are load-bearing here and each has a test in the plugin repo:
   *
   *  - **An id is POSITIONAL.** A memory file is `"\n§\n"`-joined text with no
   *    ids, so `memory:3` means "the fourth entry as it reads right now" and
   *    goes stale the moment one above it is removed. Every write therefore
   *    matches on the entry's TEXT, which is what the store itself matches on.
   *  - **`profile` is required on every route.** A plugin handler is handed
   *    none and would otherwise act on whichever home the dashboard process
   *    started with — somebody else's memory, on a multiplexed gateway. A name
   *    carrying a separator, a parent reference or surrounding space is
   *    REJECTED rather than sanitised.
   *  - **An external provider is listed and never enumerated.** `MemoryProvider`
   *    has `prefetch(query)` and no call that returns entries, so every
   *    non-builtin row carries `enumerable: false`.
   *
   * Auth is the one the dashboard already applied: this block sits below the
   * `httpAuthorized` gate, exactly as the real router sits below Hermes'
   * process-wide middleware and adds no check of its own.
   */
  async function handleMemory(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams
  ): Promise<void> {
    const advert = advertOf(options)
    const capabilities = Array.isArray(advert?.capabilities) ? (advert.capabilities as string[]) : []

    // No plugin means no router mounted, which is a 404 and not a 403: core
    // never learned about the prefix at all.
    if (!advert || !path.startsWith('/api/plugins/hermie/memory/')) {
      json(res, 404, { detail: `No route for ${method} ${path}` })

      return
    }

    if (!capabilities.includes('memory.browse')) {
      json(res, 403, {
        detail:
          'Memory browsing is switched off for this profile. Set ' +
          'plugins.entries.hermie.settings.memory.browse to true in that ' +
          "profile's config.yaml and restart the gateway."
      })

      return
    }

    const route = path.slice('/api/plugins/hermie/memory/'.length)
    const body = method === 'POST' ? await readBody(req) : {}
    const wanted = route === 'edit' ? String(body.profile ?? '') : (query.get('profile') ?? '')

    /*
      `memory/__init__.py::_clean_profile`, then the membership check. Rejected,
      not cleaned: a profile is an identifier the gateway already knows rather
      than a path to be tidied up, and the refusal does not say whether the name
      merely does not exist.
    */
    if (
      !wanted ||
      wanted !== wanted.trim() ||
      wanted.length > PROFILE_NAME_LIMIT ||
      ['/', '\\', '..', '\0', ':'].some(bad => wanted.includes(bad)) ||
      wanted === '.' ||
      wanted === '~'
    ) {
      json(res, 400, { detail: 'a profile name is required' })

      return
    }

    if (!state.profiles.some(row => row.name === wanted)) {
      json(res, 400, { detail: `no profile named '${wanted}' on this gateway` })

      return
    }

    const files = state.memory.get(wanted) ?? { memory: [], user: [] }

    state.memory.set(wanted, files)

    if (route === 'list' && method === 'GET') {
      json(res, 200, {
        targets: MEMORY_TARGETS.map(target => {
          const chars = files[target].join(ENTRY_DELIMITER).length
          const limit = MEMORY_LIMITS[target]

          return {
            target,
            entries: memoryRows(files[target], target),
            chars,
            limit,
            percent: limit ? Math.round((100 * chars) / limit) : 0
          }
        }),
        profile: wanted,
        providers: [
          { name: 'builtin', description: 'MEMORY.md and USER.md', available: true, enumerable: true },
          // See the docstring. Not "not implemented" — not offered.
          { name: 'mem0', description: 'mem0 (cloud)', available: true, enumerable: false }
        ]
      })

      return
    }

    if (route === 'search' && method === 'GET') {
      const q = query.get('q') ?? ''

      if (!q.trim()) {
        json(res, 400, { detail: 'q is required' })

        return
      }

      const results = MEMORY_TARGETS.flatMap(target =>
        memoryRows(files[target], target).filter(row => memoryMatches(row.text, q))
      )

      json(res, 200, { query: q, count: results.length, results, profile: wanted })

      return
    }

    if (route === 'graph' && method === 'GET') {
      json(res, 200, memoryGraph(files, wanted, Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 0)))

      return
    }

    /*
      `raw` is the one route here that the plugin does NOT have at the pin this
      repository was built against, and it is served so the app's Raw tab has a
      contract to be built and tested against rather than a guess. The four the
      plugin has — list, search, graph, edit — all answer a PARSED memory, and
      none of them says what an external provider is holding.

      Two of its answers matter more than the happy one:

        - `builtin` hands back each file as the store writes it, entries joined
          by the delimiter. That is deliberately NOT the entry list rejoined by
          the client: the point of the tab is to show what the parse hides.
        - `mem0` is available with no documents and a `note`. It is configured
          and it cannot enumerate, which is a different answer from a backend
          the gateway does not have — `MemoryProvider` offers `prefetch(query)`
          and nothing that lists, so there is nothing for it to send.

      `--plugin` false takes the whole prefix away above, which is how a gateway
      whose plugin predates the route is simulated: 404, and the tab says the
      plugin is older rather than painting an error.
    */
    if (route === 'raw' && method === 'GET') {
      const only = query.get('backend')

      if (only && only !== 'builtin' && only !== 'mem0') {
        json(res, 400, { detail: `no memory backend named '${only}' on this gateway` })

        return
      }

      const backends = [
        {
          name: 'builtin',
          label: 'MEMORY.md and USER.md',
          available: true,
          editable: capabilities.includes('memory.edit'),
          note: null,
          documents: MEMORY_TARGETS.map(target => {
            const content = files[target].join(ENTRY_DELIMITER)

            return {
              id: target,
              label: target === 'memory' ? 'MEMORY.md' : 'USER.md',
              content,
              chars: content.length,
              truncated: false
            }
          })
        },
        {
          name: 'mem0',
          label: 'mem0 (cloud)',
          available: true,
          editable: false,
          documents: [],
          note: 'mem0 answers a query and offers no call that lists what it holds.'
        }
      ].filter(backend => !only || backend.name === only)

      json(res, 200, { profile: wanted, backends })

      return
    }

    if (route === 'edit' && method === 'POST') {
      handleMemoryEdit(res, files, body, capabilities)

      return
    }

    json(res, 404, { detail: `No route for ${method} ${path}` })
  }

  /**
   * `POST …/memory/edit`, whose answer is the STORE's own result dict.
   *
   * The plugin deliberately does not translate it — `{"success": …}` with
   * whatever the store put beside it — so a failure the store reports reaches
   * the app in the store's own words. The two shapes that matter to a client
   * are `{success: false, error, current_entries}` for a stale index and a bare
   * `{success: true}` for a write that landed.
   */
  function handleMemoryEdit(
    res: ServerResponse,
    files: Record<MemoryTarget, string[]>,
    body: Record<string, unknown>,
    capabilities: string[]
  ): void {
    const target = String(body.target ?? '')
    const op = String(body.op ?? '')

    if (!(MEMORY_TARGETS as readonly string[]).includes(target)) {
      json(res, 400, { detail: `target must be one of ${MEMORY_TARGETS.join(', ')}` })

      return
    }

    if (!['add', 'replace', 'remove'].includes(op)) {
      json(res, 400, { detail: 'op must be add, replace or remove' })

      return
    }

    if (!capabilities.includes('memory.edit')) {
      json(res, 403, {
        detail:
          'Memory editing is switched off for this profile. Set ' +
          'plugins.entries.hermie.settings.memory.edit to true in that ' +
          "profile's config.yaml and restart the gateway."
      })

      return
    }

    const entries = files[target as MemoryTarget]
    const content = String(body.content ?? '')

    if (op === 'add') {
      if (!content.trim()) {
        json(res, 200, { success: false, error: 'content is required to add an entry' })

        return
      }

      const spent = entries.concat(content).join(ENTRY_DELIMITER).length

      if (spent > MEMORY_LIMITS[target as MemoryTarget]) {
        json(res, 200, { success: false, error: 'that would exceed the character limit for this file' })

        return
      }

      entries.push(content)
      json(res, 200, { success: true, target })

      return
    }

    /*
      `memory/browse.py::find_text`: the TEXT is preferred and is what goes to
      the store; an index is only a way of naming one, and naming one that has
      moved is an error rather than a guess at its neighbour.
    */
    const index = typeof body.index === 'number' ? body.index : null
    const named = String(body.old_text ?? '')
    const oldText = named || (index !== null && index >= 0 && index < entries.length ? (entries[index] as string) : '')
    const at = oldText ? entries.indexOf(oldText) : -1

    if (!oldText || at === -1) {
      json(res, 200, {
        success: false,
        error: 'no such entry; list the target again and retry',
        current_entries: [...entries]
      })

      return
    }

    if (op === 'remove') {
      entries.splice(at, 1)
      json(res, 200, { success: true })

      return
    }

    if (!content.trim()) {
      json(res, 200, { success: false, error: 'content is required to replace an entry' })

      return
    }

    entries[at] = content
    json(res, 200, { success: true, replaced_entry: oldText })
  }

  async function handleProfileRename(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const body = await readBody(req)
    const profile = state.profiles.find(entry => entry.name === name)

    if (!profile) {
      json(res, 404, { detail: `Profile '${name}' does not exist.` })

      return
    }

    const wanted = String(body.new_name ?? '').trim()

    if (wanted.length > PROFILE_NAME_LIMIT) {
      json(res, 400, { detail: 'A profile name may be at most 64 characters.' })

      return
    }

    if (profile.name === LAUNCH_PROFILE || profile.is_default === true) {
      if (!wanted) {
        json(res, 400, { detail: 'The default profile needs a name.' })

        return
      }

      profile.display_name = wanted
      json(res, 200, { ok: true, name: profile.name, display_name: wanted, path: profile.path })

      return
    }

    if (!wanted) {
      json(res, 400, { detail: 'A profile name is required.' })

      return
    }

    if (state.profiles.some(entry => entry.name === wanted)) {
      json(res, 400, { detail: `Profile '${wanted}' already exists.` })

      return
    }

    /*
      A real rename moves the profile's own identity, so everything the fake
      keys on the old name moves with it — otherwise the app's rekeying would be
      asserted against a gateway that had not actually renamed anything.
    */
    const previous = profile.name

    profile.name = wanted
    profile.path = `/root/.hermes/profiles/${wanted}`
    profile.display_name = wanted[0]?.toUpperCase() + wanted.slice(1)

    for (const session of state.sessions.values()) {
      if (session.profile === previous) {
        session.profile = wanted
      }
    }

    json(res, 200, { ok: true, name: wanted, path: profile.path })
  }

  /**
   * `PATCH /api/plugins/hermie/profiles/{name}` — a display name a client can write.
   *
   * The route core does not have. Core's `PATCH /api/profiles/{name}` renames
   * the profile on every profile but `default` — directory, wrapper script,
   * service, active-profile pointer — so an app that wanted to change what a
   * bot is CALLED had nowhere to send it and kept the name to itself, where no
   * other client on the gateway could see it. The plugin writes `display_name`
   * into the profile's own file, which is where `profiles.list` reads it from,
   * and answers the pair it wrote.
   *
   * Four answers, and which one this gateway gives is `profileDisplayName`:
   *
   *  - **200** `{"name": …, "display_name": …}` — written. Not core's shape:
   *    there is no `ok` and no `path`, because this route neither renames
   *    anything nor moves a directory to report the new location of.
   *  - **400** on an empty name or one over 60 characters. Shorter than core's
   *    64 on purpose — the plugin's own limit, and the app has to respect the
   *    route's rather than assume the two agree.
   *  - **403** when the signed-in gateway user may read profiles and not write
   *    them.
   *  - **404** when the plugin is absent or predates the route, which is the
   *    same 404 core answers for a prefix it never mounted.
   */
  async function handleProfileDisplayName(req: IncomingMessage, res: ServerResponse, name: string): Promise<void> {
    const advert = advertOf(options)
    const mode = options.profileDisplayName ?? 'on'

    // No plugin, or a plugin without the route: core never mounted the prefix.
    if (!advert || mode === 'absent') {
      json(res, 404, { detail: `No route for PATCH /api/plugins/hermie/profiles/${name}` })

      return
    }

    if (mode === 'forbidden') {
      json(res, 403, { detail: 'This account may not edit profiles on this gateway.' })

      return
    }

    const body = await readBody(req)
    const profile = state.profiles.find(entry => entry.name === name)

    if (!profile) {
      json(res, 404, { detail: `Profile '${name}' does not exist.` })

      return
    }

    const wanted = String(body.display_name ?? '').trim()

    if (!wanted) {
      json(res, 400, { detail: 'display_name is required.' })

      return
    }

    if (wanted.length > DISPLAY_NAME_LIMIT) {
      json(res, 400, { detail: `A display name may be at most ${DISPLAY_NAME_LIMIT} characters.` })

      return
    }

    // eslint-disable-next-line no-control-regex -- the range IS the point: C0 controls plus DEL.
    if (/[ -]/.test(wanted)) {
      json(res, 400, { detail: 'A display name may not contain control characters.' })

      return
    }

    /*
      `default` is written like any other profile. Core refuses to RENAME it
      because its home is the installation root, which is a fact about the
      directory and not about the label — and a display name that could be set
      on every bot except the one most gateways only have would be a worse
      answer than the one this round replaced.
    */
    profile.display_name = wanted
    json(res, 200, { name: profile.name, display_name: wanted })
  }

  /**
   * `POST /api/plugins/hermie/context/turn` — which bot is about to speak.
   *
   * `context.turn_claim`'s whole job: the app calls this right before
   * `prompt.submit` starts a turn, naming the RUNTIME session id that call is
   * about to carry, so a plugin watching a shared gateway from the outside can
   * tag whatever comes next with the sender it was told rather than guessing.
   * A slash command and a steer never reach this — see `chat-controller.ts`'s
   * `send` — so this route has no opinion about either.
   *
   * Three answers:
   *
   *  - **204** — claimed. No body: there is nothing to report back.
   *  - **404** — the plugin predates the route (`turnClaim: false`), or
   *    `session_id` does not name a live runtime session. The same status for
   *    both, deliberately: a client that gets this is meant to submit anyway
   *    rather than treat a claim as a precondition of the turn it names.
   *  - **415** — the body was not sent as JSON.
   */
  async function handleTurnClaim(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const advert = advertOf(options)

    if (!advert || options.turnClaim === false) {
      json(res, 404, { detail: 'No route for POST /api/plugins/hermie/context/turn' })

      return
    }

    const contentType = String(req.headers['content-type'] ?? '').toLowerCase()

    if (!contentType.includes('application/json')) {
      json(res, 415, { detail: 'Content-Type must be application/json.' })

      return
    }

    const body = await readBody(req)
    const sessionId = String(body.session_id ?? '').trim()
    const session = sessionId ? findByRuntimeId(sessionId) : undefined

    if (!session) {
      json(res, 404, { detail: `No live session '${sessionId}'.` })

      return
    }

    res.writeHead(204)
    res.end()
  }

  async function handleFileUpload(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let form: MultipartForm

    try {
      form = await readMultipart(req)
    } catch (error) {
      json(res, 400, { detail: error instanceof Error ? error.message : 'Malformed multipart body' })

      return
    }

    const requested = (form.fields.path ?? '').trim()

    if (!requested) {
      json(res, 422, { detail: 'path is required' })

      return
    }

    if (!requested.startsWith('/')) {
      // `_resolve_managed_path`: with no locked managed-files root, a relative
      // path is refused outright. Clients that assume otherwise fail here.
      json(res, 400, { detail: 'Path must be absolute' })

      return
    }

    if (requested.split('/').includes('..')) {
      json(res, 400, { detail: "Path cannot contain '..'" })

      return
    }

    if (!form.file) {
      json(res, 422, { detail: 'file is required' })

      return
    }

    if (form.file.bytes > MANAGED_FILE_MAX_BYTES) {
      json(res, 413, { detail: 'File is too large' })

      return
    }

    if (state.uploadedFiles.has(requested) && (form.fields.overwrite ?? 'true') === 'false') {
      json(res, 409, { detail: 'File already exists' })

      return
    }

    const entry = {
      path: requested,
      filename: form.file.filename,
      bytes: form.file.bytes,
      contentType: form.file.contentType,
      sha256: form.file.sha256,
      content: form.file.content
    }

    if (options.uploadDelayMs) {
      await new Promise(resolve => setTimeout(resolve, options.uploadDelayMs))
    }

    // A browser that cancelled while the answer was held has gone: the real
    // gateway removes its temporary file when the stream ends early, and keeps nothing.
    if (req.socket.destroyed || res.destroyed || res.writableEnded) {
      res.destroy()

      return
    }

    state.uploadedFiles.set(requested, entry)

    json(res, 200, {
      ok: true,
      path: requested,
      entry: {
        name: form.file.filename,
        path: requested,
        is_directory: false,
        size: form.file.bytes,
        mtime: Date.now() / 1000,
        mime_type: form.file.contentType
      },
      // `_managed_response_meta` for the unlocked policy: no root, and the
      // browser may point itself anywhere the user can read.
      root: null,
      locked_root: null,
      can_change_path: true
    })
  }

  function addCronJob(body: Record<string, unknown>): CronJob {
    const schedule = typeof body.schedule === 'string' && body.schedule ? body.schedule : 'every 1h'
    const job: CronJob = {
      id: `job-${randomUUID().slice(0, 8)}`,
      // Which store it lands in is decided by the caller's scope, never by a
      // field in the payload — there is no owner field on a stored job.
      profile: typeof body.profile === 'string' && body.profile ? body.profile : state.cronLaunchProfile,
      name: typeof body.name === 'string' && body.name ? body.name : 'New job',
      schedule,
      prompt: typeof body.prompt === 'string' ? body.prompt : '',
      deliver: typeof body.deliver === 'string' && body.deliver ? body.deliver : 'local',
      enabled: true,
      state: 'scheduled',
      next_run_at: nextRunFor(schedule),
      last_run_at: null,
      last_status: null,
      last_error: null,
      paused_at: null,
      paused_reason: null,
      repeat: typeof body.repeat === 'number' ? body.repeat : null,
      skills: Array.isArray(body.skills)
        ? body.skills.filter((skill): skill is string => typeof skill === 'string')
        : [],
      model: typeof body.model === 'string' ? body.model : null,
      runs: []
    }

    state.cronJobs.push(job)
    publish('cron.changed', undefined, {})

    return job
  }

  function setCronPaused(job: CronJob, paused: boolean): void {
    job.enabled = !paused
    job.state = paused ? 'paused' : 'scheduled'
    job.paused_at = paused ? new Date().toISOString() : null
    job.paused_reason = paused ? 'Paused from Hermie' : null
    job.next_run_at = paused ? null : nextRunFor(job.schedule)
  }

  /** Fire now: record a run, register its transcript, and answer the refreshed job. */
  function triggerCronJob(job: CronJob): CronJob {
    const startedAt = nowSeconds()
    const run = cronRunRow({
      id: `cron_${job.id}_${startedAt}`,
      title: job.name,
      profile: job.profile,
      started_at: startedAt,
      ended_at: startedAt + 9,
      preview: 'Done — nothing needs your attention.'
    })

    job.runs.push(run)
    job.last_run_at = new Date(startedAt * 1000).toISOString()
    job.last_status = 'ok'
    job.last_error = null

    const session = makeCronRunSession(
      job.id,
      startedAt,
      job.prompt,
      'Done — nothing needs your attention.',
      job.profile
    )
    state.sessions.set(run.id, session)

    publish('cron.changed', undefined, {})

    return job
  }

  /**
   * A plausible `next_run_at`.
   *
   * The real scheduler parses the schedule in the gateway's timezone; this only
   * has to move when the schedule does, so that a client showing the server's
   * answer can be told apart from one that kept its own guess.
   */
  function nextRunFor(schedule: string): string {
    const interval = /^every\s+(\d+)\s*(m|h|d)/i.exec(schedule.trim())

    if (interval) {
      const unit = interval[2]!.toLowerCase()
      const minutes = Number(interval[1]) * (unit === 'h' ? 60 : unit === 'd' ? 1440 : 1)

      return new Date(Date.now() + minutes * 60_000).toISOString()
    }

    const once = /^in\s+(\d+)\s*(m|h|d)/i.exec(schedule.trim())

    if (once) {
      const unit = once[2]!.toLowerCase()
      const minutes = Number(once[1]) * (unit === 'h' ? 60 : unit === 'd' ? 1440 : 1)

      return new Date(Date.now() + minutes * 60_000).toISOString()
    }

    return new Date(Date.now() + 86_400_000).toISOString()
  }

  // ------------------------------------------------------------ WebSocket ---

  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: protocols => (protocols.has(GATEWAY_WS_PROTOCOL) ? GATEWAY_WS_PROTOCOL : false)
  })
  const audioWss = new WebSocketServer({ noServer: true })
  const audioOptions: FakeAudioOptions | null = options.audio === false ? null : (options.audio ?? {})
  /** How many `voice-config` answers said `voices_error: "loading"`. */
  let loadingAnswers = 0

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)

    if (url.pathname === '/api/audio/speak-stream' && audioOptions) {
      const audioRejection = hostOriginRejection(req)

      if (audioRejection !== null) {
        state.rejectedUpgrades += 1
        socket.end(`HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n${audioRejection}`)

        return
      }

      audioWss.handleUpgrade(req, socket, head, ws => {
        audioWss.emit('connection', ws, req)
      })

      return
    }

    if (url.pathname !== WS_PATH) {
      socket.destroy()

      return
    }

    // HTTP middleware does not run for a WebSocket route upstream either, so the
    // guard is repeated here rather than assumed.
    const upgradeRejection = hostOriginRejection(req)

    if (upgradeRejection !== null) {
      state.rejectedUpgrades += 1
      socket.end(`HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n${upgradeRejection}`)

      return
    }

    wss.handleUpgrade(req, socket, head, ws => {
      wss.emit('connection', ws, req)
    })
  })

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const rejection = authorizeUpgrade(url, req)

    if (rejection !== null) {
      state.rejectedUpgrades += 1
      socket.close(rejection, 'unauthorized')

      return
    }

    state.connections += 1
    sockets.add(socket)

    const identity = upgradeIdentities.get(req)

    if (identity) {
      socketIdentities.set(socket, identity)
    }

    socket.on('close', () => {
      sockets.delete(socket)
      confirmLevels.delete(socket)
      confirmFields.delete(socket)
      socketIdentities.delete(socket)
      confirmGate?.forgetPeer(socket)
    })
    socket.on('message', data => {
      for (const line of String(data).split('\n')) {
        if (line.trim()) {
          void handleFrame(socket, line)
        }
      }
    })

    send(socket, {
      jsonrpc: '2.0',
      method: 'event',
      params: {
        type: 'gateway.ready',
        payload: { skin: {}, change_events: true, replay_epoch: state.replayEpoch, heartbeat: true }
      }
    })
  })

  /**
   * The audio socket's credential: `?token=` on an ungated gateway, and on a gated one a single-use
   * ticket, which `speak-stream` takes on the query (`?ticket=`) as well as in the subprotocol: the
   * route answers the upgrade without selecting one, so a client that puts it on the query is the one
   * that works against every server.
   */
  function authorizeAudioUpgrade(url: URL): number | null {
    if (state.auth === 'none') {
      return null
    }

    if (state.auth === 'token') {
      return url.searchParams.get('token') === state.token ? null : state.closeCode
    }

    const ticket = url.searchParams.get('ticket') ?? ''
    const issued = tickets.get(ticket)

    // Single use, 30 s: consume on sight whether or not it was still valid.
    tickets.delete(ticket)

    if (!issued || issued.expiresAt < Date.now()) {
      return state.closeCode
    }

    state.ticketsConsumed += 1

    return null
  }

  audioWss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const rejection = authorizeAudioUpgrade(url)

    if (rejection !== null) {
      state.rejectedUpgrades += 1
      socket.close(rejection, 'unauthorized')

      return
    }

    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    serveAudioStream(socket, url.searchParams.get('profile'))
  })

  /** One speech session: text in, PCM out as it is "made", then `end`. */
  function serveAudioStream(socket: WebSocket, profile: string | null): void {
    const audio = audioOptions ?? {}

    if (audio.stream === false) {
      socket.send(JSON.stringify({ type: 'fallback' }))
      socket.close()

      return
    }

    let text = ''
    let voice: string | null = null
    let started = false
    let finished = false
    let open = true

    socket.on('close', () => {
      open = false

      if (started && !finished) {
        state.audioStreamsCancelled += 1
      }
    })

    const speak = async (): Promise<void> => {
      started = true

      if (!text.trim()) {
        socket.send(JSON.stringify({ type: 'end' }))
        finished = true
        socket.close()

        return
      }

      state.audioRequests.push({ kind: 'stream', text, voice, profile })

      if (audio.streamError && (!audio.streamError.voice || audio.streamError.voice === voice)) {
        finished = true
        socket.send(
          JSON.stringify({
            type: 'error',
            code: audio.streamError.code,
            message: audio.streamError.message ?? 'The voice was refused'
          })
        )
        socket.close()

        return
      }

      if (audio.delayMs) {
        await new Promise(resolve => setTimeout(resolve, audio.delayMs))
      }

      for (let chunk = 0; chunk < STREAM_CHUNKS; chunk += 1) {
        if (!open) {
          return
        }

        if (chunk === 0) {
          socket.send(JSON.stringify({ type: 'start', sample_rate: STREAM_SAMPLE_RATE, channels: 1 }))
        }

        socket.send(pcmClip(STREAM_CHUNK_FRAMES, STREAM_SAMPLE_RATE), { binary: true })
        await new Promise(resolve => setTimeout(resolve, audio.chunkDelayMs ?? 5))
      }

      if (open) {
        finished = true
        socket.send(JSON.stringify({ type: 'end' }))
        socket.close()
      }
    }

    socket.on('message', data => {
      let frame: { text?: unknown; voice?: unknown; done?: unknown; stop?: unknown }

      try {
        frame = JSON.parse(String(data))
      } catch {
        // An unparseable frame is barge-in, upstream.
        socket.close()

        return
      }

      if (typeof frame.text === 'string') {
        text += frame.text
      }

      // The gateway as shipped takes no voice: the frame's field is ignored, as an unknown field is.
      if (typeof frame.voice === 'string' && frame.voice && audioOptions?.voiceSelection === true) {
        voice = frame.voice
      }

      if (frame.stop === true) {
        socket.close()

        return
      }

      if (frame.done === true && !started) {
        void speak()
      }
    })
  }

  /** The audio routes. True when the path was one of them. */
  async function handleAudio(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
    method: string,
    query: URLSearchParams
  ): Promise<boolean> {
    if (!audioOptions) {
      return false
    }

    if (path === '/api/audio/voice-config' && method === 'GET') {
      // A cold cache: `loading` for the first answers, then the list the background fetch brought.
      const coldFor = audioOptions.voicesLoadingAnswers ?? Number.POSITIVE_INFINITY
      const loading = audioOptions.voicesError === 'loading' && loadingAnswers < coldFor

      if (loading) {
        loadingAnswers += 1
      }

      json(res, 200, voiceConfigBody(audioOptions, audioOptions.voicesError === 'loading' && !loading))

      return true
    }

    const previewVoice = previewVoiceId(path)

    if (previewVoice !== null && method === 'GET') {
      const voice = (audioOptions.voices ?? DEFAULT_ELEVENLABS_VOICES).find(entry => entry.voice_id === previewVoice)

      if (audioOptions.elevenLabsKey === false || !voice || voice.preview === false) {
        json(res, 404, { detail: 'No sample for this voice' })

        return true
      }

      state.audioRequests.push({ kind: 'preview', text: '', voice: previewVoice, profile: query.get('profile') })
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': MP3_SAMPLE.length })
      res.end(MP3_SAMPLE)

      return true
    }

    if (path === '/api/audio/elevenlabs/voices' && method === 'GET') {
      json(res, 200, elevenLabsVoicesBody(audioOptions))

      return true
    }

    if (path === '/api/audio/speak' && method === 'POST') {
      const body = await readBody(req)
      const text = typeof body.text === 'string' ? body.text.trim() : ''

      if (!text) {
        json(res, 400, { detail: 'Text is required' })

        return true
      }

      const voice =
        audioOptions.voiceSelection === true && typeof body.voice === 'string' && body.voice ? body.voice : null

      state.audioRequests.push({ kind: 'speak', text, voice, profile: query.get('profile') })

      if (audioOptions.delayMs) {
        await new Promise(resolve => setTimeout(resolve, audioOptions.delayMs))
      }

      if (audioOptions.speakStatus) {
        json(res, audioOptions.speakStatus, { detail: 'Speech synthesis failed' })

        return true
      }

      if (audioOptions.speakError && (!audioOptions.speakError.voice || audioOptions.speakError.voice === voice)) {
        json(res, 400, {
          detail: {
            code: audioOptions.speakError.code,
            message: audioOptions.speakError.message ?? 'The voice was refused'
          }
        })

        return true
      }

      json(res, 200, speakBody(audioOptions))

      return true
    }

    return false
  }

  function authorizeUpgrade(url: URL, req: IncomingMessage): number | null {
    if (state.rejectNextUpgrades > 0) {
      state.rejectNextUpgrades -= 1

      return state.closeCode
    }

    if (state.auth === 'none') {
      return null
    }

    if (state.auth === 'token') {
      return url.searchParams.get('token') === state.token ? null : state.closeCode
    }

    // Cookie and native both dial with a ticket: a browser cannot put a
    // credential anywhere else on an upgrade, which is why the ticket exists.
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map(value => value.trim())
      .filter(Boolean)
    const ticketProtocols = offered.filter(value => value.startsWith(TICKET_PROTOCOL_PREFIX))

    if (ticketProtocols.length !== 1 || !offered.includes(GATEWAY_WS_PROTOCOL)) {
      return state.closeCode
    }

    const ticket = (ticketProtocols[0] as string).slice(TICKET_PROTOCOL_PREFIX.length)
    const issued = tickets.get(ticket)
    // Single use, 30 s: consume on sight whether or not it was still valid.
    tickets.delete(ticket)

    if (!issued || issued.expiresAt < Date.now()) {
      return state.closeCode
    }

    state.ticketsConsumed += 1

    if (issued.identity) {
      upgradeIdentities.set(req, issued.identity)
    }

    return null
  }

  function send(socket: WebSocket, frame: unknown): void {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(`${JSON.stringify(frame)}\n`)
    }
  }

  async function handleFrame(socket: WebSocket, text: string): Promise<void> {
    let frame: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: unknown }

    try {
      frame = JSON.parse(text)
    } catch {
      return
    }

    if (typeof frame.method !== 'string') {
      // A response to one of our server→client requests.
      if (confirmGate?.respond(socket, frame) || interactive.respond(socket, frame)) {
        return
      }

      const id = typeof frame.id === 'string' ? frame.id : ''
      const pending = pendingServerRequests.get(id)

      if (pending) {
        pendingServerRequests.delete(id)
        state.serverRequestAnswers.push({
          id,
          method: state.openServerRequests.get(id)?.method ?? '',
          ...(frame.error ? { error: frame.error } : { result: frame.result })
        })

        if (frame.error) {
          pending.reject(new Error(JSON.stringify(frame.error)))
        } else {
          pending.resolve(frame.result)
        }
      }

      return
    }

    const method = frame.method
    const params = (frame.params ?? {}) as Record<string, unknown>
    state.methodLog.push(method)

    if (method === 'client.capabilities') {
      recordClientCapabilities(socket, params)
    }

    try {
      const result = await dispatch(method, params, socket)

      if (frame.id !== undefined && frame.id !== null) {
        send(socket, { jsonrpc: '2.0', id: frame.id, result })
      }
    } catch (error) {
      if (frame.id !== undefined && frame.id !== null) {
        send(socket, {
          jsonrpc: '2.0',
          id: frame.id,
          // A handler that named a code keeps it: a client telling 4018 ("wrong
          // method for this command") from 5030 ("the worker died") cannot be
          // tested against a server that flattens both to -32603.
          error: {
            code: error instanceof RpcFault ? error.code : -32603,
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof RpcFault && error.data !== undefined ? { data: error.data } : {})
          }
        })
      }
    }
  }

  async function dispatch(method: string, params: Record<string, unknown>, caller?: WebSocket): Promise<unknown> {
    if (state.hangMethods.has(method)) {
      // Never resolves: the caller's own timeout is what should fire.
      return new Promise<never>(() => undefined)
    }

    const denied = state.deniedMethods.get(method)

    if (denied) {
      throw new RpcFault(denied.code, denied.message)
    }

    switch (method) {
      case 'client.capabilities': {
        /*
          A gateway that knows the level `passkey` answers as the real one does:
          `confirm` is always among the request kinds, `confirm` lists the levels
          it accepted from THIS connection (`passkey` only from a signed-in one
          with an RP it accepts), and `confirm_passkey` says how the level looks
          from here. Nothing else changes.
        */
        // `requests` echoes what the gateway accepted, `[]` when none, and only when the call carried the key.
        const requestsEcho = Array.isArray(params.requests)
          ? { requests: caller ? interactive.advertise(caller, params) : [] }
          : {}

        if (passkey && confirmGate && caller) {
          const accepted = confirmGate.advertise(caller, params)

          if (accepted.length) {
            confirmLevels.set(caller, accepted)
          } else {
            confirmLevels.delete(caller)
          }

          return {
            server_requests: [
              'approval',
              'clarify',
              'secret',
              'sudo',
              'vault.code',
              'vault.save_login',
              'vault.unlock_prompt',
              ...INTERACTIVE_METHODS,
              'confirm'
            ],
            confirm: accepted,
            confirm_passkey: passkey.capability(socketIdentities.has(caller)),
            // Always present once the gateway knows structured fields: true only once it accepted this connection's.
            confirm_fields: confirmGate.showsFields(caller),
            ...requestsEcho
          }
        }

        /*
          Every kind of request this gateway can raise, plus `confirm` once a
          client has offered a level for it. A client that sent no `confirm` gets
          the answer it always got, with the three vault requests the contract
          has since added, and no `confirm` member in the result.
        */
        const offered = Array.isArray(params.confirm)
        const levels = offered ? confirmLevelsOf(params) : []

        return {
          server_requests: [
            'approval',
            'clarify',
            'secret',
            'sudo',
            'vault.code',
            'vault.save_login',
            'vault.unlock_prompt',
            ...INTERACTIVE_METHODS,
            ...(levels.length ? ['confirm'] : [])
          ],
          ...(offered ? { confirm: levels } : {}),
          confirm_fields: caller ? confirmFields.has(caller) : false,
          ...requestsEcho
        }
      }

      case 'gateway.capabilities':
        return {
          per_session_exclusive_submit: true,
          ...(rowIdentity ? { transcript_row_identity: true } : {}),
          ...(options.perMessageAuthor ? { per_message_author: true } : {}),
          ...((options.perMessageAuthorVia ?? mcp?.settings.enabled === true) ? { per_message_author_via: true } : {})
        }

      case 'gateway.ping':
        return { ok: true }

      case 'profiles.list':
        return { profiles: profilesWithCanonical(), bot_mode_protocol: true }

      /**
       * `ui_meta` and `description`, which are the two sections a bot editor
       * writes: the bag nothing else owns, and the one line of prose the roster
       * shows under a bot's name.
       *
       * Upstream's docstring is the specification and the generated contract
       * carries it verbatim: "Sections are independent; `ui_meta_expected_revisions`
       * is a per-key compare-and-swap." So the unit is the TOP-LEVEL KEY:
       *
       *  - a key the request does not name is left exactly as it was, which is
       *    what keeps a client from wiping the `hermes-bots` marker another tool
       *    put there by writing only its own key;
       *  - a key the request does name REPLACES that key's value whole, and its
       *    revision goes up by one;
       *  - a key whose `ui_meta_expected_revisions` entry disagrees with the
       *    stored revision writes nothing and comes back in `ui_meta_conflicts`
       *    as `{ expected, actual }` — and the other keys in the same request
       *    still apply, because the sections are independent.
       *
       * The revision of a key that has never been written is 0, so a client
       * claiming a key for the first time sends `0` and finds out whether
       * somebody beat it to it.
       *
       * **A key written as `null` is REMOVED.** That is not a guess: the
       * 2026-09-21 probe against `hermes serve` 0.21.3 wrote `{"hermie": null}`
       * to a profile and read the bag back holding only `hermes-bots` — the key
       * was gone, not stored as a null. The fake kept the null until that probe,
       * which made it the more forgiving of the two: a client that removes a
       * section by writing null passed here and would have left a dead key on a
       * real profile. The revision still goes up, because a removal is a write.
       *
       * `description` is NOT a `ui_meta` key. It is a column of its own on the
       * profile row — the one `profiles.list` answers as `description` — so it
       * carries no revision, takes part in no compare-and-swap, and is reported
       * on its own in `applied`. Writing it into the bag instead would put a
       * second, divergent copy of the bot's subtitle somewhere the roster never
       * reads.
       *
       * Only the sections the request CARRIED come back in `applied`, which is
       * what the generated contract says ("only the sections the request
       * carried are present"), so a request that names neither still answers an
       * empty `applied` rather than a pile of falses.
       *
       * Everything else `profiles.configure` can set (soul, model, skills) is
       * deliberately absent: the fake answers what it can honestly reproduce,
       * and a section it pretended to write would be a green test about nothing.
       */
      case 'profiles.configure': {
        const name = typeof params.name === 'string' && params.name ? params.name : String(params.profile ?? '')
        const profile = state.profiles.find(entry => entry.name === name)

        if (!profile) {
          throw new Error(`Unknown profile: ${name}`)
        }

        const applied: Record<string, unknown> = {}

        if (typeof params.description === 'string') {
          profile.description = params.description
          applied.description = true
        }

        /*
          The soul is the profile's `SOUL.md`, written as given. The model is pinned only when BOTH
          halves arrive (`_configure_model` writes nothing for one alone), and a guarded model is
          the one `config.set` guards too: without `confirm_expensive_model` it writes NOTHING and
          answers `confirm_required` with the gateway's own words, next to whatever else the
          request carried and did apply.
        */
        if (typeof params.soul === 'string') {
          state.profileSouls.set(name, params.soul)
          applied.soul = true
        }

        let confirm: { confirm_required: true; confirm_message: string } | undefined
        const modelId = typeof params.model === 'string' ? params.model.trim() : ''
        const providerId = typeof params.provider === 'string' ? params.provider.trim() : ''

        if (modelId && providerId) {
          const confirmed =
            params.confirm_expensive_model === true ||
            boolWord(typeof params.confirm_expensive_model === 'string' ? params.confirm_expensive_model : undefined)

          if (modelId.includes('expensive') && !confirmed) {
            confirm = { confirm_required: true, confirm_message: `${modelId} is an expensive model. Continue?` }
          } else {
            // Stored as it arrived. `normalize_model_for_provider` keeps a `provider/` prefix for
            // openrouter, nous, ollama, lmstudio and user providers, so a client that adds one
            // changes the model's name; stripping it here hid exactly that.
            profile.provider = providerId
            profile.model = modelId
            applied.model = true
          }
        }

        /*
          The three capability sections, each stored the way upstream stores it
          rather than the way the switch rows read it. `_configure_cfg_sections`
          is the handler; the three savers beside it are the reason none of
          these is a plain enabled-set:

           - `save_disabled_skills` writes the complement, so what arrives as
             `disabled_skills` replaces that set whole and every skill not named
             is on;
           - `_save_toolset_pin` writes `tools.enabled_toolsets` when the list
             has anything in it and REMOVES the key when it is empty, so an
             empty list is "unpin", not "nothing enabled";
           - `_save_mcp_toggles` pops `disabled` off every server named and sets
             it on every other server in the config, which is why the state kept
             here is the disabled set and not the enabled one.

          All three are replace semantics, and each is reported in `applied`
          under the name upstream uses — `skills`, `toolsets`, `mcp_servers` —
          which is not the name the parameter came in under.
        */
        const capabilities = profileCapabilities(name)

        if (Array.isArray(params.disabled_skills)) {
          capabilities.disabledSkills = new Set(
            params.disabled_skills.map(entry => String(entry).trim().toLowerCase()).filter(Boolean)
          )
          applied.skills = true
        }

        if (Array.isArray(params.enabled_toolsets)) {
          const wanted = params.enabled_toolsets.map(entry => String(entry).trim()).filter(Boolean)

          capabilities.pinnedToolsets = wanted.length ? new Set(wanted) : null
          applied.toolsets = true
        }

        if (Array.isArray(params.enabled_mcp_servers)) {
          const wanted = new Set(params.enabled_mcp_servers.map(entry => String(entry).trim()).filter(Boolean))

          capabilities.disabledMcpServers = new Set(
            state.mcpServers.map(server => server.name).filter(server => !wanted.has(server))
          )
          applied.mcp_servers = true
        }

        const patch = params.ui_meta

        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
          return { ok: true, applied, ...confirm }
        }

        const expected = (
          params.ui_meta_expected_revisions && typeof params.ui_meta_expected_revisions === 'object'
            ? params.ui_meta_expected_revisions
            : {}
        ) as Record<string, unknown>
        const stored = { ...(profile.ui_meta ?? {}) }
        const revisions = { ...profile.ui_meta_revisions }
        const conflicts: Record<string, { expected: unknown; actual: number }> = {}
        let wrote = false

        for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
          const actual = revisions[key] ?? 0

          if (key in expected && expected[key] !== actual) {
            conflicts[key] = { expected: expected[key], actual }

            continue
          }

          if (value === null) {
            delete stored[key]
          } else {
            stored[key] = value
          }

          revisions[key] = actual + 1
          wrote = true
        }

        profile.ui_meta = stored
        profile.ui_meta_revisions = revisions
        applied.ui_meta = wrote
        applied.ui_meta_revisions = revisions

        if (Object.keys(conflicts).length) {
          applied.ui_meta_conflicts = conflicts
        }

        return { ok: true, applied, ...confirm }
      }

      /**
       * The editor snapshot: soul, model pin, skills, toolsets, MCP servers.
       *
       * `methods_profiles.py::profiles.describe`. Two shapes here are easy to
       * get backwards and both are asserted in `upstream-shapes.test.ts`:
       * `skills` reports `enabled`, derived from the stored DISABLED set, and
       * `toolsets_pinned` is whether a pin EXISTS rather than whether anything
       * is on. A profile with no pin still reports enabled toolsets — the
       * platform defaults — and writing an empty `enabled_toolsets` puts it
       * back into that state rather than switching everything off.
       */
      case 'profiles.describe': {
        const name = typeof params.name === 'string' && params.name ? params.name : String(params.profile ?? '')
        const profile = state.profiles.find(entry => entry.name === name)

        if (!profile) {
          throw new RpcFault(5063, `Unknown profile: ${name}`)
        }

        const capabilities = profileCapabilities(name)

        return {
          name,
          description: profile.description ?? '',
          soul: state.profileSouls.get(name) ?? '',
          model: { provider: profile.provider ?? '', default: profile.model ?? '' },
          skills: (state.profileSkills.get(name) ?? []).map(skill => ({
            name: skill,
            enabled: !capabilities.disabledSkills.has(skill.toLowerCase())
          })),
          toolsets: describeToolsets(capabilities),
          toolsets_pinned: capabilities.pinnedToolsets !== null,
          mcp_servers: state.mcpServers.map(server => ({
            name: server.name,
            enabled: !capabilities.disabledMcpServers.has(server.name),
            transport: server.transport
          }))
        }
      }

      /**
       * `profiles.create` — the ws twin of `POST /api/profiles`.
       *
       * The refusals are the reason this is modelled at all. Upstream validates
       * with `hermes_cli/profiles.py::_canon_valid` and then refuses `default`
       * separately, so three different bad names produce three different errors
       * and a client that only handles "already exists" will show the wrong one
       * twice. `4062` is the code the handler maps `ValueError` and
       * `FileExistsError` onto; `4061` is the empty name.
       *
       * What it does NOT do is mint a canonical chat. `create_profile` writes a
       * directory and nothing else, so the new row comes back with no
       * `canonical_session` and the client has to resolve one the ordinary way
       * — which is ADR-0007's flow and the only reason a new bot's chat is not
       * a second, forked conversation.
       */
      case 'profiles.create': {
        const raw = String(params.name ?? '').trim()

        if (!raw) {
          throw new RpcFault(4061, 'name required')
        }

        const name = raw.toLowerCase() === 'default' ? 'default' : raw.toLowerCase()

        if (name === 'default') {
          throw new RpcFault(4062, "Cannot create a profile named 'default' — it is the built-in profile (~/.hermes).")
        }

        if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
          throw new RpcFault(
            4062,
            `'${name}' is not a valid profile name. Use lowercase letters, numbers, '-' or '_', ` +
              'starting with a letter or number, up to 64 characters'
          )
        }

        if (['hermes', 'test', 'tmp', 'root', 'sudo'].includes(name)) {
          throw new RpcFault(
            4062,
            `Profile name '${name}' is reserved — it collides with either the Hermes installation itself or a common system binary.`
          )
        }

        if (state.profiles.some(entry => entry.name === name)) {
          throw new RpcFault(4062, `Profile '${name}' already exists`)
        }

        const cloneFrom = typeof params.clone_from === 'string' && params.clone_from ? params.clone_from : null

        if (cloneFrom && !state.profiles.some(entry => entry.name === cloneFrom)) {
          throw new RpcFault(4062, `Profile '${cloneFrom}' not found`)
        }

        const model = typeof params.model === 'string' ? params.model : null
        const provider = typeof params.provider === 'string' ? params.provider : null
        const soul = typeof params.soul === 'string' ? params.soul.trim() : ''
        // `mirror_credentials` defaults to TRUE: a bare create seeds a
        // comment-only .env and no auth.json, which is a bot with no provider.
        const mirror = params.mirror_credentials === undefined || isTruthy(params.mirror_credentials)

        state.profiles.push({
          name,
          path: `/root/.hermes/profiles/${name}`,
          is_default: false,
          description: typeof params.description === 'string' ? params.description : '',
          display_name: name[0]?.toUpperCase() + name.slice(1),
          // Empty rather than null for an unpinned model, which is what
          // `profiles.describe` writes (`str(model_cfg.get("default") or "")`)
          // and what the roster shows for a bot that inherited nothing.
          model: model ?? (mirror ? 'example-provider/example-model' : ''),
          provider: provider ?? (mirror ? 'example-provider' : ''),
          has_avatar: false,
          ui_meta_revisions: {},
          ui_meta: {}
        })

        /*
          A clone copies the source's capability state. `create_profile`
          (`clone_config`) copies config.yaml, which is where all three sections
          live, so "clone settings from <bot>" means exactly this and not a
          fresh profile with a different name.
        */
        const source = cloneFrom ? profileCapabilities(cloneFrom) : null

        state.profileCapabilities.set(name, {
          disabledSkills: new Set(source?.disabledSkills ?? []),
          pinnedToolsets: source?.pinnedToolsets ? new Set(source.pinnedToolsets) : null,
          disabledMcpServers: new Set(source?.disabledMcpServers ?? [])
        })
        state.profileSkills.set(
          name,
          cloneFrom
            ? [...(state.profileSkills.get(cloneFrom) ?? [])]
            : // A fresh profile is seeded with the bundled skills
              // (`seed_profile_skills`); a `no_skills` create is not.
              isTruthy(params.no_skills)
              ? []
              : ['pdf', 'docx', 'web-search']
        )

        return {
          ok: true,
          name,
          path: `/root/.hermes/profiles/${name}`,
          soul_written: Boolean(soul),
          model_set: Boolean(model && provider),
          mirrored: {
            env: mirror,
            auth: isTruthy(params.share_auth) ? 'shared' : mirror,
            model_inherited: mirror && !(model && provider),
            voice: mirror
          }
        }
      }

      /**
       * `tools.configure` — the SESSION-scoped toolset switch.
       *
       * This is not the per-bot path and the difference matters: the handler
       * reads `session_id`, takes the live session's profile home as
       * authoritative, and says so in a comment ("The client sends session_id,
       * not profile"). Editing a bot that has no live session goes through
       * `profiles.configure` instead.
       *
       * A name containing `:` is an MCP target rather than a toolset, which is
       * how `server:tool` reaches the same call. Unknown toolsets come back in
       * `unknown` and MCP targets whose server is not configured come back in
       * `missing_servers` — neither is an error, and both are dropped from
       * `changed`, so a client that assumes success from the absence of an
       * error reports a switch as flipped when it was not.
       */
      case 'tools.configure': {
        const action = String(params.action ?? '')
          .trim()
          .toLowerCase()

        if (action !== 'enable' && action !== 'disable') {
          throw new RpcFault(4017, `unknown tools action: ${action}`)
        }

        const targets = (Array.isArray(params.names) ? params.names : [])
          .map(entry => String(entry).trim())
          .filter(Boolean)

        if (!targets.length) {
          throw new RpcFault(4018, 'names required')
        }

        const sessionId = String(params.session_id ?? '')
        const session = sessionId ? resolveSession(sessionId) : undefined
        const capabilities = profileCapabilities(session?.profile ?? state.cronLaunchProfile)
        const known = new Set(FAKE_TOOLSETS.map(toolset => toolset.name))
        const unknown = targets.filter(name => !name.includes(':') && !known.has(name))
        const mcpTargets = targets.filter(name => name.includes(':'))
        const missingServers = [
          ...new Set(
            mcpTargets
              .map(name => name.split(':', 1)[0] ?? '')
              .filter(server => !state.mcpServers.some(entry => entry.name === server))
          )
        ].sort()

        // The pin is what this writes, so a session whose profile had none
        // acquires one — starting from the platform defaults, because that is
        // the set `_apply_toolset_change` mutates.
        const pinned =
          capabilities.pinnedToolsets ??
          new Set(FAKE_TOOLSETS.filter(toolset => toolset.platformDefault).map(toolset => toolset.name))

        for (const name of targets.filter(entry => !entry.includes(':') && known.has(entry))) {
          if (action === 'enable') {
            pinned.add(name)
          } else {
            pinned.delete(name)
          }
        }

        capabilities.pinnedToolsets = pinned

        return {
          changed: targets.filter(
            name =>
              !unknown.includes(name) && (!name.includes(':') || !missingServers.includes(name.split(':', 1)[0] ?? ''))
          ),
          enabled_toolsets: [...pinned].sort(),
          info: null,
          missing_servers: missingServers,
          reset: Boolean(session),
          unknown
        }
      }

      /**
       * `skills.manage` — five actions behind one method, each answering a
       * DIFFERENT key, which is the shape `_run_action` produces and the one
       * thing a client must not assume away.
       *
       * `list` answers `skills` as category → names (not a flat list, and with
       * no enabled flag on it: enabled state is per profile and lives in
       * `profiles.describe`). `search` answers `results`, `browse` answers
       * `items` with paging, `inspect` answers `info`, and `install` answers
       * `installed` + `name`.
       *
       * Install really is available over the socket — `_skills_install` calls
       * `do_install(skip_confirm=True)` — so a client that assumes it is CLI
       * only would hide a button that works.
       */
      case 'skills.manage': {
        const action = String(params.action ?? 'list')
        const query = String(params.query ?? '')
        const profileName = typeof params.profile === 'string' && params.profile ? params.profile : null

        if (action === 'list') {
          const installed = profileName
            ? (state.profileSkills.get(profileName) ?? [])
            : [...new Set([...(state.profileSkills.get(state.cronLaunchProfile) ?? []), ...state.skillsInstalled])]
          const bundled = installed.filter(name => FAKE_SKILL_HUB.find(hit => hit.name === name)?.source === 'bundled')

          return {
            skills: {
              bundled,
              installed: installed.filter(name => !bundled.includes(name))
            }
          }
        }

        if (action === 'search') {
          const needle = query.trim().toLowerCase()

          return {
            results: FAKE_SKILL_HUB.filter(
              hit => !needle || hit.name.includes(needle) || hit.description.toLowerCase().includes(needle)
            ).map(hit => ({ name: hit.name, description: hit.description }))
          }
        }

        if (action === 'browse') {
          const pageSize = Number(params.page_size ?? 20) || 20
          const page = Number(params.page ?? 0) || (/^\d+$/.test(query) ? Number(query) : 1)
          const start = (page - 1) * pageSize

          return {
            items: FAKE_SKILL_HUB.slice(start, start + pageSize).map(hit => ({
              name: hit.name,
              description: hit.description,
              source: hit.source,
              trust: hit.trust,
              identifier: hit.name
            })),
            page,
            total_pages: Math.max(1, Math.ceil(FAKE_SKILL_HUB.length / pageSize)),
            total: FAKE_SKILL_HUB.length
          }
        }

        if (action === 'inspect') {
          const hit = FAKE_SKILL_HUB.find(entry => entry.name === query)

          // `inspect_skill(query) or {}` — a miss is an empty object, not an error.
          return {
            info: hit
              ? {
                  name: hit.name,
                  description: hit.description,
                  source: hit.source,
                  identifier: hit.name,
                  tags: [hit.trust],
                  skill_md_preview: `# ${hit.name}\n\n${hit.description}\n`
                }
              : {}
          }
        }

        if (action === 'install') {
          const hit = FAKE_SKILL_HUB.find(entry => entry.name === query)

          if (!hit) {
            throw new RpcFault(5024, `skill '${query}' not found in the hub`)
          }

          const target = profileName ?? state.cronLaunchProfile
          const installed = state.profileSkills.get(target) ?? []

          if (!installed.includes(hit.name)) {
            state.profileSkills.set(target, [...installed, hit.name])
          }

          state.skillsInstalled.push(hit.name)

          return { installed: true, name: hit.name }
        }

        throw new RpcFault(4017, `unknown skills action: ${action}`)
      }

      /**
       * `reload.mcp` — the one call in this family that can refuse by answering
       * successfully.
       *
       * Without `confirm`, and while the approval is still set, it answers
       * `{status: 'confirm_required', message}` with a 200. There is no error
       * frame, so a client that only inspects `error` will believe it reloaded.
       * `always` proceeds AND clears the approval for good, which is what
       * `/reload-mcp always` does, and is why the second plain call after one
       * goes straight through.
       */
      case 'reload.mcp': {
        const confirm = params.confirm === true
        const always = params.always === true

        if (!confirm && !always && state.mcpReloadConfirm) {
          return {
            status: 'confirm_required',
            message:
              '⚠️  /reload-mcp invalidates the prompt cache (next message re-sends full input tokens). ' +
              'Reply `/reload-mcp now` to proceed, or `/reload-mcp always` to proceed and silence this prompt permanently.'
          }
        }

        if (always) {
          state.mcpReloadConfirm = false
        }

        state.mcpReloads += 1

        return { status: 'reloaded', loaded_rev: `rev-${state.mcpReloads}`, coalesced: false }
      }

      /**
       * `connectors.list` — `methods_connectors.py::connectors.list`,
       * `ConnectorsListParams`: exactly `{profile?, owner}`.
       *
       * Two things a client gets wrong here. It names whose connectors it means
       * with `owner` — a chat's runtime session, or the account — and NOT a
       * top-level `session_id`, which the contract refuses (`4000`). And when the
       * session's `manage_connections` toolset is off it answers
       * `{available: false, connectors: []}` as a SUCCESS — a client reading
       * only the array reports an empty account for a switch that is off.
       */
      case 'connectors.list': {
        checkConnectorParams(params, [])

        if (state.connectorsUnavailable) {
          return { available: false, connectors: [] }
        }

        return {
          available: true,
          connectors: state.connectors.map(entry => ({
            connector: entry.connector,
            connected: entry.connected,
            enabled: entry.enabled,
            connectionStatus: entry.connectionStatus,
            statusReason: entry.statusReason,
            ...(entry.name === undefined ? {} : { name: entry.name }),
            ...(entry.description === undefined ? {} : { description: entry.description })
          }))
        }
      }

      /**
       * `connectors.connect` — `ConnectorsConnectParams`: exactly
       * `{profile?, owner, connectors, reconnect?}`, `connectors` a non-empty
       * list of slugs, `reconnect` a boolean.
       *
       * The authorisation link rides at `targets[].connect_url` and NOWHERE
       * else. `connector_ui_payload` redacts the whole payload but exempts that
       * one key by name, which is the only reason it survives the trip.
       *
       * Simplified: this fake opens an operation for either owner. Upstream
       * opens one only for the account; for a session it re-mints on the
       * operation the agent already holds open, and answers
       * `4004 UNKNOWN_OPERATION` when there is none.
       */
      case 'connectors.connect': {
        const owner = checkConnectorParams(params, ['connectors', 'reconnect'])
        const slugs = params.connectors

        if (
          !Array.isArray(slugs) ||
          !slugs.length ||
          slugs.some(slug => typeof slug !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/u.test(slug)) ||
          (params.reconnect !== undefined && typeof params.reconnect !== 'boolean')
        ) {
          throw new RpcFault(4000, 'connectors must be nonempty slugs; reconnect must be boolean', {
            reason: 'INVALID_PARAMS'
          })
        }

        if (state.connectorsUnavailable) {
          throw new RpcFault(4031, 'Connectors are not available in this session.', {
            reason: 'CONNECTORS_UNAVAILABLE'
          })
        }

        const unknown = (slugs as string[]).find(slug => !state.connectors.some(entry => entry.connector === slug))

        if (unknown) {
          throw new RpcFault(4004, `no such connector: ${unknown}`, { reason: 'UNKNOWN_TARGET' })
        }

        state.connectorSeq += 1

        const op: FakeConnectorOp = {
          opId: `op-${state.connectorOps.size + 1}`,
          sessionId: owner.type === 'session' ? owner.session_id : '',
          ...(owner.type === 'account' ? { account: true } : {}),
          seq: state.connectorSeq,
          deadlineAt: Math.floor(Date.now() / 1000) + 300,
          settled: false,
          settledBy: null,
          reads: 0,
          woken: false,
          targets: (slugs as string[]).map(slug => ({
            name: slug,
            kind: 'connector' as const,
            action: params.reconnect === true ? 'reconnect' : 'connect',
            state: 'initiated',
            connectUrl: `https://vendor.test/authorize/${slug}?op=${state.connectorOps.size + 1}`,
            detail: null,
            // `slack` is the fixture that fails, so a client has a failure to
            // draw without reaching in and mutating the catalogue first.
            resolvesTo: slug === 'slack' ? 'failed' : 'connected'
          }))
        }

        state.connectorOps.set(op.opId, op)

        return { ...connectorOpView(op), status: 'initiated', note: 'Show each connect_url to the user.' }
      }

      /**
       * `connectors.operation.status` — `ConnectionOperationParams`: exactly
       * `{profile?, owner, op_id}`. The snapshot, one `seq` newer each read.
       */
      case 'connectors.operation.status': {
        const { owner, opId } = checkConnectorOpParams(params)
        const op = ownedConnectorOp(owner, opId)

        op.reads += 1

        // The gateway's own watcher reads the vendor account on a tick; two
        // reads, or one `wake`, is this fake's stand-in for that latency.
        if (op.woken || op.reads >= 2) {
          for (const target of op.targets) {
            if (target.state === 'initiated') {
              target.state = target.resolvesTo
              target.detail = target.resolvesTo === 'failed' ? 'the workspace refused the grant' : null

              // The account watcher is what moves the vendor's row: a list read after this says so too.
              const row = state.connectors.find(entry => entry.connector === target.name)

              if (row && target.state === 'connected') {
                row.connected = true
                row.connectionStatus = 'active'
                row.statusReason = null
              }
            }
          }

          if (op.targets.every(target => target.state !== 'initiated' && target.state !== 'pending')) {
            op.settled = true
            op.settledBy = 'all_resolved'
          }
        }

        state.connectorSeq += 1
        op.seq = state.connectorSeq

        return connectorOpView(op)
      }

      /**
       * `connectors.operation.wake` — the browser leg came back. The same
       * `ConnectionOperationParams` as `status`.
       *
       * A LATENCY shortcut and nothing else; upstream's docstring says the link
       * "is not trusted for anything else".
       */
      case 'connectors.operation.wake': {
        const { owner, opId } = checkConnectorOpParams(params)
        const op = ownedConnectorOp(owner, opId)

        op.woken = true

        return { status: 'ok' }
      }

      /**
       * `connection.respond` — the card's answer. Checked as strictly as the gateway's contract
       * (`checkConnectionRespond`), recorded, and applied to the open operation it names: a skipped
       * row moves to `skipped`, `settled_by: continue` (or every row resolved) settles it, and the
       * change goes out as `connection.update`, as the gateway announces it — to the session for a
       * chat's operation, to every socket (without links) for the account's.
       */
      case 'connection.respond': {
        const answer = checkConnectionRespond(params)
        const op = ownedConnectorOp(answer.owner, answer.opId)

        if (op.settled) {
          throw new RpcFault(4004, 'No open operation with that op_id.', { reason: 'UNKNOWN_OPERATION' })
        }

        state.connectionResponses.push(structuredClone(params))

        for (const row of answer.targets) {
          const target = op.targets.find(entry => entry.name === row.name)

          if (target && row.status === 'skipped') {
            target.state = 'skipped'
          }
        }

        if (
          answer.settledBy === 'continue' ||
          op.targets.every(target => target.state !== 'initiated' && target.state !== 'pending')
        ) {
          op.settled = true
          op.settledBy = answer.settledBy ?? 'all_resolved'
        }

        state.connectorSeq += 1
        op.seq = state.connectorSeq

        if (answer.owner.type === 'account') {
          const view = connectorOpView(op)

          publish('connection.update', undefined, {
            ...view,
            targets: (view.targets as Record<string, unknown>[]).map(({ connect_url: _link, ...target }) => target),
            owner: { type: 'account' }
          })
        } else {
          publish('connection.update', op.sessionId, {
            ...connectorOpView(op),
            owner: { type: 'session', session_id: answer.owner.session_id }
          })
        }

        return { status: 'ok', settled: op.settled }
      }

      case 'mcp.servers.list':
        return { servers: state.mcpServers.map(summariseMcpServer) }

      /**
       * `mcp.servers.status` — CACHED runtime state. It never connects, probes
       * or starts auth, so a server that needs OAuth looks exactly like one
       * that is fine here; `test` is the only call that can tell them apart.
       */
      case 'mcp.servers.status':
        return {
          servers: state.mcpServers.map(server => ({
            name: server.name,
            transport: server.transport,
            tools: server.tools?.length ?? 0,
            connected: server.enabled && server.tools !== null,
            disabled: !server.enabled,
            status: !server.enabled ? 'disabled' : server.tools === null ? 'failed' : 'connected'
          })),
          checked_at: Date.now()
        }

      /**
       * `mcp.servers.test` — connect, list tools, disconnect.
       *
       * A failure is `{ok: false, error, tools: []}` at the RPC level, not an
       * error frame. The OAuth case is the subtle one and upstream comments on
       * it: a server declaring `auth: oauth` that would serve `tools/list`
       * anonymously is still reported `ok: false` when no token is on disk,
       * because a green probe with no token is a false green.
       */
      case 'mcp.servers.test': {
        const name = String(params.name ?? '')
        const server = state.mcpServers.find(entry => entry.name === name)

        if (!server) {
          throw new RpcFault(4064, `server '${name}' not found`)
        }

        const needsOauth = server.auth === 'oauth'

        if (server.tools === null) {
          return {
            ok: false,
            error: server.probeError ?? 'connection failed',
            tools: [],
            oauth_needed: needsOauth,
            oauth_tokens_present: needsOauth ? server.oauthTokensPresent : null
          }
        }

        if (needsOauth && !server.oauthTokensPresent) {
          return {
            ok: false,
            error: 'OAuth authentication required — no token found.',
            tools: [],
            oauth_needed: true,
            oauth_tokens_present: false
          }
        }

        return {
          ok: true,
          tools: server.tools,
          prompts: 0,
          resources: 0,
          oauth_needed: needsOauth,
          oauth_tokens_present: needsOauth ? true : null
        }
      }

      /**
       * `mcp.servers.oauth.start` — PKCE, with the two refusals upstream raises
       * before any flow exists: stdio servers authenticate with env keys, and a
       * server already carrying headers uses API-key auth. Both are `4001`.
       */
      case 'mcp.servers.oauth.start': {
        const name = String(params.name ?? '')
        const server = state.mcpServers.find(entry => entry.name === name)

        if (!server) {
          throw new RpcFault(4064, `server '${name}' not found`)
        }

        if (!server.url) {
          throw new RpcFault(4001, 'stdio servers authenticate via env keys, not OAuth')
        }

        if (server.auth === 'bearer') {
          throw new RpcFault(4001, 'this server uses header/API-key auth, not OAuth')
        }

        const flowId = randomUUID()

        state.mcpOauthFlows.set(flowId, { name, pendingPolls: 1, status: 'pending' })

        return {
          ok: true,
          session_id: flowId,
          auth_url: `https://calendar.example.test/authorize?client_id=hermes&state=${flowId}`,
          flow: 'pkce'
        }
      }

      /** `mcp.servers.oauth.poll` — `pending` until it is `approved`, which persists the token. */
      case 'mcp.servers.oauth.poll': {
        const flowId = String(params.session_id ?? '')
        const flow = state.mcpOauthFlows.get(flowId)

        if (!flow) {
          throw new RpcFault(4064, `no OAuth flow '${flowId}'`)
        }

        if (flow.status === 'pending' && flow.pendingPolls > 0) {
          flow.pendingPolls -= 1

          return { ok: true, status: 'pending', session_id: flowId }
        }

        if (flow.status === 'error') {
          return { ok: true, status: 'error', session_id: flowId, error_message: flow.errorMessage ?? 'denied' }
        }

        flow.status = 'approved'

        const server = state.mcpServers.find(entry => entry.name === flow.name)

        if (server) {
          server.oauthTokensPresent = true
        }

        return { ok: true, status: 'approved', session_id: flowId, tools: server?.tools ?? [] }
      }

      /** `mcp.servers.oauth.cancel` — drops the flow; the token state is untouched. */
      case 'mcp.servers.oauth.cancel': {
        const flowId = String(params.session_id ?? '')

        state.mcpOauthFlows.delete(flowId)

        return { ok: true, status: 'cancelled' }
      }

      /**
       * `mcp.catalog` — curated presets with this profile's installed / enabled state and the env
       * keys each needs (`methods_tools.py`).
       */
      case 'mcp.catalog':
        return {
          servers: FAKE_MCP_CATALOG.map(entry => {
            const configured = state.mcpServers.find(server => server.name === entry.name)

            return {
              name: entry.name,
              description: entry.description,
              connector_slug: null,
              installed: configured !== undefined,
              enabled: configured?.enabled ?? false,
              requires: entry.requires,
              transport: entry.transport
            }
          })
        }

      /**
       * `mcp.servers.add` — a server from a catalogue `preset` and/or an explicit `config`
       * (`url` or `command`, `args`, `env`, `headers`, `auth`). A name already configured is 4090;
       * a config with neither `url` nor `command` (and no preset to fill them) is 4063; a
       * `bearer_token` goes to the profile's `.env` and only a header template persists, so no
       * answer ever carries it.
       */
      case 'mcp.servers.add': {
        const name = String(params.name ?? '').trim()
        const preset = typeof params.preset === 'string' && params.preset ? params.preset : null
        const given =
          params.config && typeof params.config === 'object' ? (params.config as Record<string, unknown>) : {}
        const config: Record<string, unknown> = { ...given }

        if (!name) {
          throw new RpcFault(4063, 'name is required')
        }

        if (state.mcpServers.some(server => server.name === name)) {
          throw new RpcFault(4090, `server '${name}' already exists`)
        }

        if (preset && !config.url && !config.command) {
          const entry = FAKE_MCP_CATALOG.find(candidate => candidate.name === preset)

          if (!entry) {
            throw new RpcFault(4063, `Unknown MCP catalog entry or preset: ${preset}`)
          }

          if (entry.url) {
            config.url = entry.url
          }

          if (entry.command) {
            config.command = entry.command
            config.args = entry.args ?? []
          }

          config.env = Object.fromEntries(entry.requires.map(key => [key, `\${${key}}`]))
        }

        if (!config.url && !config.command) {
          throw new RpcFault(4063, "config must specify a 'url' (http) or 'command' (stdio), or a valid 'preset'")
        }

        const spelled = `${String(config.command ?? '')} ${Array.isArray(config.args) ? config.args.join(' ') : ''}`

        // The gateway's own screen for a command that is plainly not a server: a shell pipeline.
        if (/[;&|`]/u.test(spelled)) {
          throw new RpcFault(4001, `server '${name}' rejected: suspicious command/args configuration`)
        }

        const bearer = typeof params.bearer_token === 'string' && params.bearer_token ? params.bearer_token : null
        const missing = typeof config.command === 'string' && config.command.startsWith('missing-')
        const server: FakeMcpServer = {
          name,
          transport: config.url ? 'http' : 'stdio',
          ...(typeof config.url === 'string' ? { url: config.url } : {}),
          ...(typeof config.command === 'string' ? { command: config.command } : {}),
          args: Array.isArray(config.args) ? config.args.map(String) : [],
          env: config.env && typeof config.env === 'object' ? Object.keys(config.env as Record<string, unknown>) : [],
          auth: bearer ? 'bearer' : config.auth === 'oauth' ? 'oauth' : null,
          oauthTokensPresent: false,
          enabled: true,
          tools: missing ? null : [{ name: 'echo', description: 'Echo the input back.' }],
          ...(missing ? { probeError: `spawn ${String(config.command)} ENOENT` } : {})
        }

        if (bearer) {
          state.mcpSecrets.set(name, { envVar: mcpKeyName(name), value: bearer })
        }

        state.mcpServers.push(server)

        return { ok: true, name, server: summariseMcpServer(server) }
      }

      /**
       * `mcp.servers.set_api_key` — the secret goes to the profile's `.env` under `env_var`
       * (default `MCP_<NAME>_API_KEY`); the server keeps only a `${ENV}` reference, an http one as
       * its Bearer header, a stdio one as an `env` entry. A blank value (or a bare `Bearer`) is 4063.
       */
      case 'mcp.servers.set_api_key': {
        const name = String(params.name ?? '')
        const server = state.mcpServers.find(entry => entry.name === name)

        if (!server) {
          throw new RpcFault(4064, `server '${name}' not found`)
        }

        const value = String(params.value ?? '')
          .replace(/^bearer\s+/iu, '')
          .trim()

        if (!value || value.toLowerCase() === 'bearer') {
          throw new RpcFault(4063, 'value is not a valid credential')
        }

        const envVar = typeof params.env_var === 'string' && params.env_var ? params.env_var : mcpKeyName(name)

        state.mcpSecrets.set(name, { envVar, value })

        if (server.url) {
          server.auth = 'bearer'
        } else if (!server.env.includes(envVar)) {
          server.env.push(envVar)
        }

        return { ok: true, name, env_var: envVar, server: summariseMcpServer(server) }
      }

      /** `mcp.servers.remove` — out of the profile's config; an unknown name is 4064. */
      case 'mcp.servers.remove': {
        const name = String(params.name ?? '')
        const at = state.mcpServers.findIndex(entry => entry.name === name)

        if (at === -1) {
          throw new RpcFault(4064, `server '${name}' not found`)
        }

        state.mcpServers.splice(at, 1)
        state.mcpSecrets.delete(name)

        return { ok: true, removed: true }
      }

      case 'session.list': {
        const title = typeof params.title === 'string' ? params.title : null
        const profile = typeof params.profile === 'string' ? params.profile : null
        // A hidden session leaves the default listing and comes back only when
        // it is asked for. Canonical chats are hidden, which is why every
        // caller that wants one sends `include_hidden: true`.
        const includeHidden = params.include_hidden === true
        const rows = [...state.sessions.values()]
          .filter(session => (profile ? session.profile === profile : true))
          .filter(session => (title ? session.title === title : true))
          .filter(session => includeHidden || !session.hidden)
          .map(session => ({
            id: session.storedId,
            resolved_id: session.storedId,
            title: session.title,
            preview: session.messages[session.messages.length - 1]?.text ?? '',
            message_count: session.messages.length,
            /*
              `_session_row_summary` reports one, and until a caller needed to
              SORT by it the fake got away with leaving it out. Derived from the
              transcript rather than stored, so it is the same number for the
              same session on every run and a test can assert on it; a session
              nothing has been said in has no timestamp to report, which is the
              `undefined` the contract already allows for.
            */
            ...(typeof session.messages[0]?.timestamp === 'number'
              ? { started_at: session.messages[0]?.timestamp }
              : {})
          }))

        return { sessions: rows }
      }

      case 'session.create': {
        const profile = typeof params.profile === 'string' ? params.profile : 'default'
        const wanted = typeof params.title === 'string' ? params.title : CANONICAL_CHAT_TITLE
        /*
          A title already held does NOT land, and the create still succeeds.

          Upstream persists no row for an empty draft at all — the title rides as
          `pending_title` until the first prompt, and the write it eventually
          attempts goes through `_set_session_title`, which raises "Title 'Bot
          Chat' is already in use by session …" when another row holds it. Either
          way the new session does not get the name, so a client that creates
          before it retires the old chat ends up with an untitled session the
          canonical lookup cannot find — which is the failure this models.
        */
        const session = makeSession(profile, titleHolder(wanted, profile) ? '' : wanted)
        session.messages = []
        session.hidden = params.hidden === true

        if (typeof params.parent_session_id === 'string' && params.parent_session_id) {
          session.parentSessionId = params.parent_session_id
        }

        state.sessions.set(session.storedId, session)

        return {
          session_id: session.id,
          stored_session_id: session.storedId,
          message_count: 0,
          messages: [],
          info: sessionInfo(session)
        }
      }

      /**
       * `methods_session.py::session.title` — session-scoped, so the RUNTIME id.
       *
       * Without a `title` it reads; with one it writes, through
       * `hermes_state_titles.py::_set_session_title`, whose two refusals are the
       * whole reason this method is modelled at all.
       */
      case 'session.title': {
        const session = requireLiveSession(String(params.session_id ?? ''))

        if (!('title' in params)) {
          return { title: session.title, session_key: session.storedId }
        }

        const title = String(params.title ?? '').trim()

        if (!title) {
          throw new RpcFault(4021, 'title required')
        }

        /*
          The canonical guard. A HIDDEN session called `Bot Chat` may not be
          renamed away from that title, because the title is how Bot Mode finds
          it again — upstream raises this sentence word for word. Hidden is the
          discriminator, and upstream says so beside the check: "a visible
          session merely named 'Bot Chat' stays renameable". So a client that
          wants to retire a canonical chat has to take it out of hiding first.
        */
        if (session.hidden && session.title === CANONICAL_CHAT_TITLE && title !== CANONICAL_CHAT_TITLE) {
          throw new RpcFault(
            4022,
            "This is the bot's canonical Bot Chat — its name is its identity, and renaming it would " +
              'orphan the conversation. To start fresh, create a new bot instead.'
          )
        }

        const holder = titleHolder(title, session.profile)

        if (holder && holder !== session) {
          throw new RpcFault(4022, `Title '${title}' is already in use by session ${holder.storedId}`)
        }

        session.title = title

        return { pending: false, title, session_key: session.storedId }
      }

      /** `methods_session.py::session.set_hidden` — live runtime id first, else a stored one. */
      case 'session.set_hidden': {
        const wanted = String(params.session_id ?? '')
        const session = findByRuntimeId(wanted) ?? state.sessions.get(wanted)

        if (!session) {
          throw new RpcFault(4001, 'session not found')
        }

        session.hidden = params.hidden === undefined ? true : params.hidden === true

        return { hidden: session.hidden, session_key: session.storedId }
      }

      /**
       * `methods_session.py::session.branch` — "Fork a live session into a new
       * stored child that shares the parent's history so far."
       *
       * That sentence is the contract's own one-line description of the method
       * and it is, together with the four parameter names, the WHOLE of what is
       * known here. It is worth being blunt about the gap, because a reader will
       * come to this handler looking for the answer:
       *
       *  - `SessionBranchParams` is `{session_id, profile?, name?, count?}`.
       *    There is **no row index and no row id**, so "branch from THIS
       *    message" is not a thing the method takes literally. `count` is the
       *    only lever that can mean a position at all, and the reading modelled
       *    here is the one the word and the result's `message_count` together
       *    support: **`count` is how many of the parent's messages the child
       *    starts with.** Branching from the row at index `i` therefore sends
       *    `i + 1`.
       *  - That reading has **not been checked against a running gateway** —
       *    there is none here — so it is written down in `docs/platform-notes.md`
       *    as an assumption rather than as a fact. If upstream turns out to mean
       *    "the last `count` messages", the app's arithmetic is the one line
       *    that changes (`ChatController.branchFrom`) and this handler is the
       *    other.
       *  - `session_id` is a LIVE runtime id: the description says "fork a live
       *    session", and every other session-scoped method upstream resolves
       *    through `_sess_nowait`. `requireLiveSession` is what holds a client
       *    to that, exactly as it does for `session.title`.
       *
       * The child is an ordinary VISIBLE session. Nothing in the parameters can
       * ask for a hidden one, and a branch that arrived hidden would be a
       * conversation the reader could not find — which is also why the app's
       * Branches group can list it without asking for `include_hidden`.
       */
      case 'session.branch': {
        const parent = requireLiveSession(String(params.session_id ?? ''))
        const asked = typeof params.name === 'string' ? params.name.trim() : ''
        /*
          A name already worn does not land, and the branch is still created.

          The same shape `session.create` models above, and for the same reason:
          `_set_session_title` refuses a duplicate, and a client that assumes
          otherwise would go looking for its branch under a name nothing holds.
        */
        const title = asked && !titleHolder(asked, parent.profile) ? asked : ''
        const child = makeSession(parent.profile, title)
        const count =
          typeof params.count === 'number' && Number.isFinite(params.count)
            ? Math.max(0, Math.min(Math.floor(params.count), parent.messages.length))
            : parent.messages.length

        // "Shares the parent's history so far": a COPY, not a reference. The two
        // conversations diverge from here, which is the whole point of a branch,
        // and a fake that aliased the array would show every later turn in both.
        child.messages = parent.messages.slice(0, count).map(row => ({ ...row }))
        child.hidden = false
        child.parentSessionId = parent.storedId

        state.sessions.set(child.storedId, child)

        return {
          session_id: child.id,
          stored_session_id: child.storedId,
          title: child.title,
          parent: parent.storedId,
          message_count: child.messages.length,
          messages: child.messages,
          info: sessionInfo(child)
        }
      }

      /**
       * `methods_session.py::session.delete` — the STORED id, says the contract.
       *
       * `SessionDeleteParams`'s own doc comment is the one-line "``session_id``
       * is the STORED id", which is the opposite of `session.title` next door,
       * so the fake accepts a stored id and nothing else. A client that reaches
       * for the runtime id it happens to be holding gets 4001 here rather than
       * finding out against somebody's real gateway.
       *
       * **No canonical guard is modelled, because upstream documents none.** It
       * would be easy to make this refuse a hidden `Bot Chat` and comforting to
       * have the fake catch the mistake — and it would be a fake that lies. The
       * rule that the canonical chat is never deleted is the APP's
       * (`conversationActions` in `features/sessions/session-model.ts` answers an
       * empty action list for it), and the test that it holds belongs there.
       */
      case 'session.delete': {
        const wanted = String(params.session_id ?? '')
        const session = state.sessions.get(wanted)

        if (!session) {
          throw new RpcFault(4001, 'session not found')
        }

        state.sessions.delete(wanted)

        return { deleted: session.storedId }
      }

      /**
       * `methods_session.py::session.close` — pop the RUNTIME session.
       *
       * The stored row and its transcript are untouched; what goes is the live
       * session and the id it was addressed by. A resume of the stored id builds
       * a new one, which is why the runtime id changes across a close.
       */
      case 'session.close': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          return { closed: false }
        }

        session.closed = true

        return { closed: true }
      }

      case 'session.resume': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        if (session.closed) {
          // Rebuilt, so a NEW runtime id — the gateway hands one out on every
          // rebuild and the old one never comes back.
          session.closed = false
          session.id = `sid-${randomUUID().slice(0, 8)}`
        }

        const omit = params.omit_messages === true

        // `pending_approval` is the QUEUE entry, not a live request: an approval
        // raised before this connection existed has no `open_requests` row to
        // carry it, and a client that never asked to receive server requests
        // has no other way to learn it is there.
        const pending = [...state.pendingApprovals.values()].find(entry => entry.session_id === session.storedId)
        // As the gateway answers (`tui_gateway/server.py`, `if value:`): the key
        // is left out when nothing is open. `session.events.since` always carries it.
        const open = openRequestsFor(session.id, caller)
        const inflight = inflightOf(session)

        return {
          session_id: session.id,
          stored_session_id: session.storedId,
          message_count: session.messages.length,
          messages: omit ? [] : session.messages,
          messages_omitted: omit,
          info: sessionInfo(session),
          ...(inflight ? { inflight } : {}),
          ...(open.length > 0 ? { open_requests: open } : {}),
          ...(pending ? { pending_approval: pending.payload } : {})
        }
      }

      case 'session.history': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        return { count: session.messages.length, messages: session.messages }
      }

      /*
        `tui_gateway/server.py::_get_usage` + `agent/context_breakdown.py`.

        Derived from the message count rather than stored, so it is the same
        answer for the same session on every run and a test can assert on it.
        The window is a round 200k, which is what makes the percentage the app
        draws readable at a glance rather than a number nobody can check.
      */
      case 'session.usage': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        return {
          ...sessionUsage(session),
          // The provider account's limits, as the text the gateway renders them as.
          ...(state.usage.accountLines.length ? { account_lines: state.usage.accountLines } : {}),
          ...(state.usage.creditsLines.length ? { credits_lines: state.usage.creditsLines } : {})
        }
      }

      /*
        `tui_gateway/methods_tools.py::insights.get`: how many sessions and messages one profile had over `days`,
        and nothing else (no tokens, no cost: those are the analytics route's).
      */
      case 'insights.get': {
        if (state.usage.unsupported) {
          throw new RpcFault(-32601, `unknown method: ${method}`)
        }

        const profile = typeof params.profile === 'string' ? params.profile : undefined
        const days = typeof params.days === 'number' ? params.days : 30
        const mine = [...state.sessions.values()].filter(session => !profile || session.profile === profile)

        return insightsAnswer(
          days,
          mine.length,
          mine.reduce((total, session) => total + session.messages.length, 0)
        )
      }

      /*
        `usage.bars`: the Nous balance. Any other account, and a logged-out one, answers
        `{ok: true, available: false}` rather than an error (`_billing_view` is fail-open).
      */
      case 'usage.bars': {
        if (state.usage.unsupported) {
          throw new RpcFault(-32601, `unknown method: ${method}`)
        }

        return state.usage.bars ?? { available: false, ok: true }
      }

      /*
        The fork's `account.usage {profile?, refresh?}` (`methods_account_usage.py`): per provider the profile's
        models run on, the plan, the quota windows, details and credits as fields, or why there is nothing. A
        profile the gateway does not serve is 4064. Every call is kept for a test (`GET /__fake/usage`): the
        real gateway serves a `refresh` inside 15 s from its cache, and what a client sent is what it can check.
      */
      case 'account.usage': {
        if (state.usage.unsupported || state.usage.accountUnsupported) {
          throw new RpcFault(-32601, `unknown method: ${method}`)
        }

        const named = typeof params.profile === 'string' ? params.profile.trim() : ''

        if (named && !state.profiles.some(entry => entry.name === named)) {
          throw new RpcFault(4064, `Profile '${named}' does not exist.`)
        }

        state.usage.accountCalls.push({ profile: named || null, refresh: params.refresh === true })

        return {
          ok: true,
          profile: named || (state.profiles.find(entry => entry.is_default)?.name ?? LAUNCH_PROFILE),
          providers: state.usage.account ?? defaultAccountProviders(nowSeconds())
        }
      }

      /*
        `tui_gateway/methods_vault.py`: one profile's credential vault (see `vault.ts`). `params.profile` picks
        the vault, as the real handlers bind that profile's home around their body; none is the launch
        profile's, and one the gateway does not serve is 4064 (`ProfileUnavailableError`), never the launch one.
      */
      case 'vault.list':
      case 'vault.sources':
      case 'vault.source.set':
      case 'vault.unlock':
      case 'vault.lock':
      case 'vault.add':
      case 'vault.remove': {
        const named = typeof params.profile === 'string' ? params.profile.trim() : ''

        if (named && !state.profiles.some(entry => entry.name === named)) {
          throw new RpcFault(4064, `Profile '${named}' does not exist.`)
        }

        const owner = named || (state.profiles.find(entry => entry.is_default)?.name ?? LAUNCH_PROFILE)

        try {
          return vaultCall(state.vault, method, params, owner)
        } catch (error) {
          if (error instanceof VaultError) {
            throw new RpcFault(error.code, error.message)
          }

          throw error
        }
      }

      /*
        `tui_gateway/methods_prompt.py`: the standing and session approvals a client lists and revokes (see
        `approval-grants.ts`). `params.profile` names the profile, one the gateway does not serve is 4064; a
        call without it reaches the named session's profile, else the launch profile.
      */
      case 'approval.grants':
      case 'approval.revoke': {
        const named = typeof params.profile === 'string' ? params.profile.trim() : ''

        if (named && !state.profiles.some(entry => entry.name === named)) {
          throw new RpcFault(4064, `Profile '${named}' does not exist.`)
        }

        const live = [...state.sessions.values()]
          .filter(entry => !entry.closed)
          .map(entry => ({
            id: entry.id,
            profile: entry.profile,
            storedId: entry.storedId,
            yolo: boolWord(state.sessionConfig.get(entry.storedId)?.yolo)
          }))

        try {
          return approvalCall(
            state.approvals,
            method,
            params,
            named || null,
            state.profiles.find(entry => entry.is_default)?.name ?? LAUNCH_PROFILE,
            live
          )
        } catch (error) {
          if (error instanceof ApprovalGrantsError) {
            throw new RpcFault(error.code, error.message)
          }

          throw error
        }
      }

      case 'session.events.since': {
        const sessionId = String(params.session_id ?? '')
        const lastSeen = typeof params.last_seen === 'number' ? params.last_seen : 0
        state.eventsSinceCalls.push({ session_id: sessionId, last_seen: lastSeen })
        const session = resolveSession(sessionId)
        const entries = (session?.ring ?? []).filter(entry => entry.seq > lastSeen)
        const truncated = state.truncateNextReplay
        state.truncateNextReplay = false

        return {
          events: entries.map(entry => ({
            type: entry.type,
            session_id: entry.session_id,
            seq: entry.seq,
            ...(entry.turn_id ? { turn_id: entry.turn_id } : {}),
            payload: entry.payload
          })),
          latest_seq: session?.seq ?? 0,
          truncated,
          count: entries.length,
          epoch: state.replayEpoch,
          open_requests: session ? openRequestsFor(session.id, caller) : []
        }
      }

      case 'prompt.submit': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        if (state.promptFailure !== null) {
          throw new RpcFault(5000, state.promptFailure)
        }

        const holder = state.ownedElsewhere.get(session.storedId)

        if (holder !== undefined) {
          // The fork's `session_already_owned_message`: the sentence for the reader, then the details.
          throw new RpcFault(
            4090,
            `This chat is open in another Hermes window/terminal. Use it there, or start a new chat here.\nDetails: ${holder}`,
            { reason: 'SESSION_NOT_OWNED' }
          )
        }

        streamReply(session, typeof params.text === 'string' ? params.text : '')

        return { status: 'streaming' }
      }

      /*
        A correction folded into the turn that is running.

        Upstream's contract is one sentence — "inject text into the next tool
        result without interrupting the turn" — and the whole of what a client
        has to handle is in the status it answers with. So both branches are
        reproduced rather than only the happy one: a session with no turn
        running has no next tool result to hand anything to, which is exactly
        the `rejected` a client must put back in its queue.

        It also writes the row, with the `display_kind: "steer"` the history
        projection defines for it. Whether a real gateway persists a steer is
        NOT established (see the note beside `steerQueued`), so this is the
        harder of the two cases for a client rather than a claim about
        upstream: a client that paints its own optimistic bubble AND gets a row
        back must pair the two, or the correction appears twice.
        `steerPersistsRow: false` stages the other case.
      */
      case 'session.redirect':
      case 'session.steer': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (!session) {
          throw new Error(`Unknown session: ${String(params.session_id)}`)
        }

        const text = typeof params.text === 'string' ? params.text : ''

        if (!state.runningSessions.has(session.storedId)) {
          return { status: 'rejected', text }
        }

        if (steerPersistsRow) {
          session.messages.push({
            role: 'user',
            text,
            row_id: session.messages.length + 1,
            timestamp: nowSeconds(),
            display_kind: 'steer'
          })
          publish('sessions.changed', undefined, {})
        }

        return { status: method === 'session.redirect' ? 'redirected' : 'queued', text }
      }

      case 'session.interrupt': {
        const session = resolveSession(String(params.session_id ?? ''))

        if (session) {
          interruptReply(session)
        }

        return { status: 'interrupted', interrupted: true }
      }

      /*
        The fork's `session.interrupt_all` (`methods_session.py`): every running turn the caller may stop, in
        one call, across profiles or just `profile`. A turn that ends before its stop is `already_idle`, as are
        the sessions with no turn; `not_allowed` and `failed` are what a test staged (`POST /__fake/stop-all`),
        since the fake has one caller and no shared chats. Cron runs are not here and are never stopped.
      */
      case 'session.interrupt_all': {
        if (state.stopAll.unsupported) {
          throw new RpcFault(-32601, `unknown method: ${method}`)
        }

        const profile = typeof params.profile === 'string' ? params.profile.trim() : ''

        if (profile && !state.profiles.some(entry => entry.name === profile)) {
          throw new RpcFault(4064, `Profile '${profile}' does not exist.`)
        }

        const stopped: Record<string, unknown>[] = []
        let idle = 0

        for (const session of [...state.sessions.values()]) {
          if (session.closed || (profile && session.profile !== profile)) {
            continue
          }

          if (!state.runningSessions.has(session.storedId)) {
            idle += 1
            continue
          }

          interruptReply(session)
          stopped.push({
            profile: session.profile,
            session_id: session.id,
            session_key: session.storedId,
            source: 'tui',
            title: session.title || null
          })
        }

        return {
          already_idle: idle,
          failed: state.stopAll.failed,
          not_allowed: state.stopAll.notAllowed,
          stopped
        }
      }

      case 'session.active_list': {
        // Deliberately IGNORES `profile`, because upstream does: the method is a
        // plain one over the process's live sessions and never reads the profile
        // it accepts (`tui_gateway/methods_session.py`). Honouring it here hid
        // the bug where one busy session marked every bot as working.
        //
        // A session parked on an open server request (an approval, a question, a form) is `waiting`:
        // `LiveSessionStatus` has the word, and a real gateway reports it while the turn waits for the
        // person. Such a session is listed even when no turn of the fake is running in it, because a
        // request staged through `POST /__fake/request` has no turn behind it and still has to read as a
        // bot waiting for somebody.
        const waiting = new Set([...state.openServerRequests.values()].map(request => request.session_id))
        const sessions = [...state.sessions.values()]
          .filter(session => state.runningSessions.has(session.storedId) || waiting.has(session.id))
          .map(session => ({
            current: false,
            id: session.id,
            last_active: nowSeconds(),
            message_count: session.messages.length,
            model: 'example-provider/example-model',
            preview: session.messages[session.messages.length - 1]?.text ?? '',
            session_key: session.storedId,
            started_at: nowSeconds() - 600,
            status: waiting.has(session.id) ? 'waiting' : 'working',
            title: session.title
          }))

        return { sessions }
      }

      case 'cron.manage':
        return cronManage(params)

      /**
       * The write half of the avatar pair, which the fake had no answer for at
       * all — so an editor that uploaded a picture got "unknown method" back and
       * no test could tell an upload that landed from one that never left the
       * client.
       *
       * Both halves move `ui_meta_revisions.avatar`, because that number is the
       * cache-buster a client keys its avatar fetches on: a picture replaced
       * under the same profile name is invisible to anybody who never sees the
       * revision change, and so is a picture removed.
       */
      case 'profiles.set_asset': {
        const name = typeof params.name === 'string' && params.name ? params.name : String(params.profile ?? '')
        const profile = state.profiles.find(entry => entry.name === name)

        if (!profile) {
          throw new Error(`Unknown profile: ${name}`)
        }

        const asset = typeof params.asset === 'string' && params.asset ? params.asset : 'avatar'
        const key = `${name}:${asset}`
        // `clear` is `boolean | string` in the contract, so it is read through
        // the same `_BOOL_WORDS` as every other switch rather than compared
        // against one spelling.
        const clear = params.clear === true || boolWord(typeof params.clear === 'string' ? params.clear : undefined)

        // Both halves move the revision, but only once the write has landed: a
        // refused call that had already bumped it would send every client off
        // to re-fetch a picture nothing changed.
        const bumpAssetRevision = (): void => {
          profile.ui_meta_revisions = {
            ...profile.ui_meta_revisions,
            [asset]: (profile.ui_meta_revisions[asset] ?? 0) + 1
          }
        }

        if (clear) {
          // `removed` counts what was actually there to delete, so a client can
          // tell "there is no picture now" from "there was no picture to begin
          // with". The staged fixture counts: a profile that answers
          // `has_avatar` has one, whether or not this server was the one that
          // wrote the bytes.
          const had = state.profileAssets.delete(key) || (asset === 'avatar' && profile.has_avatar)

          if (asset === 'avatar') {
            profile.has_avatar = false
          }

          bumpAssetRevision()

          return { ok: true, asset, removed: had ? 1 : 0 }
        }

        const bytes = decodeAssetData(typeof params.data === 'string' ? params.data : '')

        if (!bytes.length) {
          // A write with neither `data` nor `clear` is a client bug, and `ok`
          // would hide it behind a green round trip.
          throw new Error(`profiles.set_asset needs data or clear: ${asset}`)
        }

        state.profileAssets.set(key, { mime: sniffImageMime(bytes), bytes })

        if (asset === 'avatar') {
          profile.has_avatar = true
        }

        bumpAssetRevision()

        return { ok: true, asset, size: bytes.length }
      }

      case 'profiles.get_asset': {
        const name = String(params.name ?? '')
        const profile = state.profiles.find(entry => entry.name === name)
        const asset = typeof params.asset === 'string' && params.asset ? params.asset : 'avatar'
        const stored = state.profileAssets.get(`${name}:${asset}`)

        // What `set_asset` wrote wins over the staged fixture. Answering the
        // fixture after an upload would make a write that never landed look
        // exactly like one that did, which is the single thing an editor's test
        // needs to be able to tell apart.
        if (stored) {
          return {
            found: true,
            mime: stored.mime,
            size: stored.bytes.length,
            data: `data:${stored.mime};base64,${stored.bytes.toString('base64')}`
          }
        }

        if (!profile?.has_avatar) {
          return { found: false }
        }

        return {
          found: true,
          mime: 'image/png',
          size: 68,
          data: `data:image/png;base64,${AVATAR_PNG_BASE64}`
        }
      }

      /*
        `methods_tools.py::commands.catalog`.

        Every key is written WITH its slash, because that is what the real
        accumulator does (`cat.commands.update({f"/{key}": …})`), and `skills`
        maps a slashed key to `{usage, origin}` rather than to a description.
        `argument_mode` is the three-value enum upstream declares — `options`,
        `text`, `mixed`, or null — and never `required`/`none`, which this server
        invented and no client could ever have matched.

        Measured against `hermes serve` 0.21.3 on 2026-09-21.
      */
      case 'commands.catalog':
        return {
          pairs: [
            ['/model', 'Switch model (session-scoped; --global to persist) (usage: /model [model])'],
            ['/reasoning', 'Set the reasoning effort (usage: /reasoning [low|medium|high])'],
            ['/status', 'Show session, model, token, and context info'],
            ['/help', 'Show available commands (usage: /help [skills|<filter>])'],
            ['/yolo', 'Toggle YOLO mode (skip all dangerous command approvals)'],
            ['/queue', 'Queue a prompt for the next turn (usage: /queue [<prompt>|list])'],
            ['/release-notes', 'Draft release notes']
          ],
          sub: { '/queue': ['list', 'edit', 'rm', 'clear'] },
          canon: {
            '/model': '/model',
            '/reasoning': '/reasoning',
            '/status': '/status',
            '/help': '/help',
            '/yolo': '/yolo',
            '/queue': '/queue',
            '/q': '/queue'
          },
          commands: {
            '/model': { argument_mode: 'mixed', desktop: null },
            '/reasoning': { argument_mode: 'options', desktop: null },
            '/status': { argument_mode: null, desktop: null },
            '/help': { argument_mode: 'text', desktop: null },
            '/yolo': { argument_mode: null, desktop: null },
            '/queue': { argument_mode: 'text', desktop: null },
            '/q': { argument_mode: 'text', desktop: null }
          },
          categories: [
            {
              name: 'Session',
              pairs: [['/status', 'Show session, model, token, and context info']]
            },
            {
              name: 'Configuration',
              pairs: [
                ['/model', 'Switch model (session-scoped; --global to persist) (usage: /model [model])'],
                ['/reasoning', 'Set the reasoning effort (usage: /reasoning [low|medium|high])'],
                ['/yolo', 'Toggle YOLO mode (skip all dangerous command approvals)']
              ]
            }
          ],
          // Slashed keys, `{usage, origin}` values: `_catalog_skills`.
          skills: { '/release-notes': { usage: 0, origin: 'bundled' } },
          skill_count: 1,
          warning: ''
        }

      /*
        `methods_complete.py::complete.slash`.

        Three things this used to get wrong, each of which hid a client fault:
        an item's `text` carries NO slash (only `display` does), `replace_from`
        is 1 while a command token is under the cursor rather than 0, and it
        moves to `text.rfind(' ') + 1` as soon as there is an argument. A line
        that does not start with `/` answers an empty list with no
        `replace_from` at all.
      */
      case 'complete.slash': {
        const text = String(params.text ?? '')

        if (!text.startsWith('/')) {
          return { items: [] }
        }

        const all = [
          {
            text: 'model',
            display: '/model',
            meta: 'Switch model (session-scoped; --global to persist)',
            kind: 'command'
          },
          { text: 'reasoning', display: '/reasoning', meta: 'Set the reasoning effort', kind: 'command' },
          { text: 'status', display: '/status', meta: 'Show session, model, token, and context info', kind: 'command' },
          { text: 'help ', display: '/help', meta: 'Show available commands', kind: 'command' },
          { text: 'yolo', display: '/yolo', meta: 'Toggle YOLO mode', kind: 'command' },
          { text: 'queue', display: '/queue', meta: 'Queue a prompt for the next turn', kind: 'command' },
          { text: 'release-notes', display: '/release-notes', meta: 'Draft release notes', kind: 'skill' }
        ]
        const typed = text.slice(1).toLowerCase()
        const replaceFrom = text.includes(' ') ? text.lastIndexOf(' ') + 1 : 1

        return {
          items: text.includes(' ') ? [] : all.filter(item => item.text.trimEnd().startsWith(typed)),
          replace_from: replaceFrom
        }
      }

      /*
        `methods_tools.py::slash.exec`.

        It does NOT run everything the catalogue lists. A skill is refused with
        `4018 skill command: use command.dispatch for /<name>` — upstream's
        `_is_profile_skill_command` guard — and a pending-input built-in is
        rerouted by upstream into `command.dispatch`, so its answer comes back as
        a DIRECTIVE with a `type` and no `output` at all. Answering everything
        with one cheerful line, which is what this did, is why a client that
        could not run any of the fifty-three skills a real gateway lists had a
        green suite.
      */
      case 'slash.exec': {
        const command = String(params.command ?? '').trim()
        const [head = '', ...rest] = command.replace(/^\/+/u, '').split(/\s+/u)
        const name = head.toLowerCase()
        const arg = rest.join(' ')

        if (FAKE_SKILL_COMMANDS.has(name)) {
          throw new RpcFault(4018, `skill command: use command.dispatch for /${name}`)
        }

        if (FAKE_DISPATCH_COMMANDS.has(name)) {
          return dispatchCommand(name, arg)
        }

        return { output: slashOutput(name, arg) }
      }

      /*
        `methods_tools.py::command.dispatch` — the structured half. A skill
        answers `{type: 'skill', message, display, name}`, where `message` is the
        expanded skill body no surface may render and `display` is the line the
        reader sees.
      */
      case 'command.dispatch': {
        const name = String(params.name ?? '')
          .replace(/^\/+/u, '')
          .toLowerCase()

        return dispatchCommand(name, String(params.arg ?? ''))
      }

      case 'config.get': {
        const key = String(params.key ?? 'verbose')
        const sessionId = String(params.session_id ?? '')
        const stored = state.sessionConfig.get(resolveSession(sessionId)?.storedId ?? sessionId) ?? {}

        if (key === 'verbose') {
          return { value: 'verbose', tool_progress: 'verbose' }
        }

        // Fast mode is always ON or OFF upstream, never unset: `_set_fast`
        // stores a mode and the read answers whichever one is in force. A blank
        // here would leave a client that parses the word with nothing to parse.
        if (key === 'fast') {
          return { value: stored.fast ?? 'normal' }
        }

        return { value: stored[key] ?? '' }
      }

      case 'config.set': {
        const key = String(params.key ?? '')
        const raw = typeof params.value === 'string' ? params.value : String(params.value ?? '')
        const value = key === 'fast' ? fastMode(raw) : raw
        const session = resolveSession(String(params.session_id ?? ''))

        if (key === 'model' && value.includes('expensive') && params.confirm_expensive_model !== true) {
          return { key, value, confirm_required: true, confirm_message: `${value} is an expensive model. Continue?` }
        }

        if (session) {
          const config = { ...(state.sessionConfig.get(session.storedId) ?? {}), [key]: value }
          state.sessionConfig.set(session.storedId, config)
          publish('session.info', session.storedId, sessionInfo(session))

          return {
            key,
            value,
            scope: typeof params.scope === 'string' ? params.scope : 'session',
            info: sessionInfo(session)
          }
        }

        return { key, value }
      }

      case 'model.options':
        /*
          The inventory's own shape: a provider slug plus plain model ids, the
          way `hermes_cli/inventory.py::build_models_payload` writes them.

          THREE providers and eleven models, not one provider and two. The size
          is the fixture's whole point: a real gateway offers a list this long
          or longer, and a two-model inventory is what let a model PICKER built
          as a horizontal segmented strip look perfectly readable here while
          every label on the owner's gateway was cut to three characters. A
          fixture that cannot reproduce the failure is a fixture that certifies
          it.
        */
        return {
          providers: [
            {
              slug: 'example-provider',
              name: 'Example Provider',
              models: ['example-model', 'expensive-model', 'example-model-mini'],
              total_models: 3,
              is_current: true
            },
            {
              slug: 'second-provider',
              name: 'Second Provider',
              models: ['reasoner-2', 'reasoner-2-turbo', 'summariser-1', 'summariser-1-mini'],
              total_models: 4,
              is_current: false
            },
            {
              slug: 'local-runner',
              name: 'Local Runner',
              models: ['local-8b-instruct', 'local-70b-instruct', 'local-8b-instruct-quantised', 'local-embed-1'],
              total_models: 4,
              is_current: false
            }
          ],
          model: 'example-provider/example-model',
          provider: 'example-provider'
        }

      case 'image.attach_bytes': {
        /*
          `image.attach_bytes` in `tui_gateway/methods_prompt.py`, with its
          refusals: 4015 with no payload, 4017 for a payload that is not strict
          base64 (or is empty), 4018 over the 25 MiB cap, 4016 for an extension
          the gateway does not take as an image.
        */
        const raw = String(params.content_base64 ?? params.data ?? '').trim()

        if (!raw) {
          throw new RpcFault(4015, 'content_base64 required')
        }

        const payload = raw.replace(/^data:image\/[a-zA-Z0-9.+-]*;base64,/su, '').replace(/\s+/gu, '')

        if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(payload) || payload.length % 4 !== 0) {
          throw new RpcFault(4017, 'data is not valid base64')
        }

        const bytes = Buffer.from(payload, 'base64')

        if (bytes.length === 0) {
          throw new RpcFault(4017, 'image is empty')
        }

        if (bytes.length > ATTACH_BYTES_MAX_BYTES) {
          throw new RpcFault(4018, `image too large (${bytes.length} bytes; cap is 25 MB)`)
        }

        const extension = sniffImageExtension(bytes, String(params.filename ?? ''))

        if (!IMAGE_EXTENSIONS.has(extension)) {
          throw new RpcFault(4016, `unsupported image extension: ${extension}`)
        }

        state.attachedImages.push({
          session_id: String(params.session_id ?? ''),
          filename: String(params.filename ?? 'image.png'),
          bytes: bytes.length
        })

        return { attached: true, name: String(params.filename ?? 'image.png'), width: 1, height: 1, count: 1 }
      }

      case 'approval.received':
        return { acknowledged: true }

      case 'approval.pending': {
        const session = resolveSession(String(params.session_id ?? ''))
        const approvals = [...state.pendingApprovals.values()]
          .filter(entry => !session || entry.session_id === session.storedId)
          .map(entry => entry.payload)

        return { approvals }
      }

      case 'approval.respond': {
        const requestId = typeof params.request_id === 'string' ? params.request_id : ''

        if (params.all === true) {
          const resolved = state.pendingApprovals.size
          state.pendingApprovals.clear()

          return { resolved }
        }

        return { resolved: state.pendingApprovals.delete(requestId) ? 1 : 0 }
      }

      case 'clarify.lock': {
        const requestId = String(params.request_id ?? '')
        const open = state.openServerRequests.get(requestId)

        // `lock_answer` only knows batch clarify; a single question has no qid
        // set to lock against, so the real gateway reports it expired and the
        // agent keeps waiting. A client has to use `request.answer` for those.
        if (!open || open.method !== 'clarify' || !Array.isArray(open.params.questions)) {
          return { status: 'expired' }
        }

        return { status: 'ok', remaining: [] }
      }

      case 'request.answer': {
        // `methods_prompt.request.answer`: settle an open server→client request
        // for a client that cannot answer it on its own reply frame. It takes
        // the request's own id and the result that frame would have carried —
        // no session id anywhere.
        const requestId = String(params.id ?? '')
        const result = params.result

        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw new Error('id and an object result required')
        }

        // A gated `confirm` is answered under the real gateway's rules: 4033 when this
        // connection may not answer it, 4034 for an answer that is not valid.
        if (confirmGate && caller) {
          try {
            const settled = confirmGate.answer(caller, requestId, result)

            if (settled) {
              return settled
            }
          } catch (error) {
            if (error instanceof AnswerRefused) {
              throw new RpcFault(error.code, error.message, error.data)
            }

            throw error
          }
        }

        // An interactive request is answered under the contract's rules: 4034 with the reason, and open still.
        try {
          const settled = interactive.answer(requestId, result)

          if (settled) {
            return settled
          }
        } catch (error) {
          if (error instanceof AnswerRefused) {
            throw new RpcFault(error.code, error.message, error.data)
          }

          throw error
        }

        const pending = pendingServerRequests.get(requestId)

        if (!pending) {
          return { status: 'expired' }
        }

        pendingServerRequests.delete(requestId)
        pending.resolve(result)

        return { status: 'ok' }
      }

      case 'subagent.list': {
        const session = resolveSession(String(params.session_id ?? ''))
        const children = liveSubagentsFor(session?.storedId)

        return {
          subagents: children,
          delegations: [...new Set(children.map(child => child.delegation_id))].map(id => ({
            delegation_id: id,
            child_count: children.filter(child => child.delegation_id === id).length
          }))
        }
      }

      case 'delegation.status': {
        // Addressed at a PROFILE, not a session: it answers for the bot's whole
        // backend, which is what makes it the right source for a cross-bot
        // counter.
        const profile = typeof params.profile === 'string' ? params.profile : null
        const owned = [...state.liveSubagents.values()].filter(child => {
          const owner = state.sessions.get(child.owner_session_id)

          return !profile || owner?.profile === profile
        })

        return {
          active: owned.map(child => ({
            subagent_id: child.subagent_id,
            parent_id: child.parent_id,
            depth: child.depth,
            goal: child.goal,
            delegation_id: child.delegation_id,
            model: child.model,
            started_at: child.started_at,
            status: child.status,
            tool_count: child.tool_count,
            owner_agent_session_id: child.owner_session_id
          })),
          paused: false,
          max_spawn_depth: 3,
          max_concurrent_children: 4
        }
      }

      case 'agents.list': {
        const profile = typeof params.profile === 'string' ? params.profile : null
        const processes = [...state.agentProcesses.values()]
          .filter(entry => {
            const owner = state.sessions.get(entry.session_id)

            return !profile || owner?.profile === profile
          })
          .map(entry => ({
            session_id: entry.session_id,
            command: entry.command,
            status: entry.status,
            uptime: Math.max(0, nowSeconds() - entry.startedAt)
          }))

        return { processes }
      }

      case 'subagent.steer': {
        const id = String(params.subagent_id ?? '')
        const child = state.liveSubagents.get(id)

        if (child) {
          child.last_tool = 'steer'
        }

        return { status: child ? 'queued' : 'rejected', subagent_id: id, text: String(params.text ?? '') }
      }

      case 'subagent.interrupt': {
        const id = String(params.subagent_id ?? '')
        const child = state.liveSubagents.get(id)

        if (child) {
          state.liveSubagents.delete(id)
          publish('subagent.complete', child.owner_session_id, {
            subagent_id: id,
            delegation_id: child.delegation_id,
            parent_id: child.parent_id,
            goal: child.goal,
            depth: child.depth,
            status: 'interrupted',
            summary: 'Stopped by the user.'
          })
        }

        return { found: Boolean(child), subagent_id: id }
      }

      case 'subagent.tail': {
        const id = String(params.subagent_id ?? '')
        const child = state.liveSubagents.get(id)

        if (!child) {
          return { subagent_id: id, available: false, text: '', truncated: false }
        }

        return {
          subagent_id: id,
          available: true,
          text: [
            `> ${child.goal}`,
            `· ${child.last_tool ?? 'thinking'}`,
            `· ${child.tool_count} tool call${child.tool_count === 1 ? '' : 's'} so far`
          ].join('\n'),
          truncated: false
        }
      }

      default:
        throw new Error(`Unknown method: ${method}`)
    }
  }

  /**
   * The gateway's context-window accounting for one session.
   *
   * Upstream reports `context_used` / `context_max` beside the token counts, and
   * the app draws the ring from exactly those two — see `context-usage.ts`,
   * which refuses to draw anything without the second. So the fake has to carry
   * both, or every test of that surface would be a test of the empty case.
   */
  function sessionUsage(session: FakeSession): Record<string, unknown> {
    const config = state.sessionConfig.get(session.storedId) ?? {}
    const turns = session.messages.length
    // A prompt and its reply are a few hundred tokens and the system prompt is
    // a fixed cost, which is close enough to a real transcript's shape for the
    // ring to move the way a reader would expect as a conversation grows.
    const contextUsed = 1_800 + turns * 420

    return {
      model: config.model ?? 'example-provider/example-model',
      input: turns * 260,
      output: turns * 160,
      total: turns * 420,
      calls: turns,
      context_used: contextUsed,
      context_max: FAKE_CONTEXT_MAX,
      context_percent: Math.round((contextUsed / FAKE_CONTEXT_MAX) * 1000) / 10,
      context_source: 'model catalog',
      context_estimated: false
    }
  }

  /** Only the context-window fields of a usage record: how full the session's window is. */
  function contextFieldsOf(usage: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(usage).filter(([key]) => key.startsWith('context_')))
  }

  function sessionInfo(session: FakeSession): Record<string, unknown> {
    const config = state.sessionConfig.get(session.storedId) ?? {}

    return {
      model: config.model ?? 'example-provider/example-model',
      provider: 'example-provider',
      reasoning_effort: config.reasoning ?? 'medium',
      fast: config.fast === 'fast',
      yolo: boolWord(config.yolo),
      approval_mode: 'ask',
      title: session.title,
      profile_name: session.profile,
      stored_session_id: session.storedId,
      /*
       * The session's working directory, which a real gateway reports here and
       * this server did not report at all.
       *
       * It is what makes the upload route above reachable. A client cannot
       * invent this path — `@file:` is expanded with `allowed_root` set to the
       * session's own cwd, so a file has to be uploaded INTO it — and Hermie
       * refuses to upload rather than guess when the resume carries no `cwd`.
       * Omitting it therefore meant `POST /api/files/upload-stream`, the 100 MB
       * cap, the absolute-path rule and the "I received N bytes" reply below
       * were all written against a path no run could ever take: every attach
       * stopped at "No workspace to upload into" before a request was made.
       *
       * Absolute on purpose. With no locked managed-files root a relative path
       * earns a 400, and that is the rule the upload route reproduces.
       */
      cwd: `/root/projects/${session.profile}`,
      desktop_contract: 7,
      version,
      // A resume answers with the usage inside `info`, which is where the app
      // reads it from on a cold open — before any `session.usage` tick has been
      // published and before the reader has sent anything.
      usage: sessionUsage(session),
      running: state.runningSessions.has(session.storedId)
    }
  }

  /**
   * `cron.manage`, the WS half.
   *
   * Every answer carries `gateway_running`: it is the only place a client can
   * learn whether the scheduler process (`hermes gateway`, not `hermes serve`)
   * is up, and a list of healthy-looking jobs with it false is exactly the case
   * the Routines banner exists for. Rows are `_format_job` shaped, so they key
   * the job as `job_id` and carry a preview rather than the full prompt.
   */
  function cronManage(params: Record<string, unknown>): Record<string, unknown> {
    const action = typeof params.action === 'string' ? params.action : 'list'
    const name = typeof params.name === 'string' ? params.name : ''
    // The scope, exactly as `_profile_scoped_rpc` resolves it: the `profile`
    // param when there is one, the launch profile otherwise. Nothing outside it
    // exists for the rest of this call — not to list, not to find, not to touch.
    const requested = typeof params.profile === 'string' ? params.profile.trim() : ''
    const scope = requested || state.cronLaunchProfile
    const inScope = () => state.cronJobs.filter(entry => entry.profile === scope)
    const listed = () => inScope().map(formatCronJob)
    // `scoped` proves the profile was honoured; the real handler adds it only
    // when one was passed, and clients key an older-gateway fallback off that.
    const scopedEcho = requested ? { scoped: requested } : {}

    if (action === 'list') {
      return {
        success: true,
        jobs: listed(),
        count: inScope().length,
        ...scopedEcho,
        gateway_running: state.cronGatewayRunning
      }
    }

    if (action === 'add') {
      const refused = typeof params.schedule === 'string' ? scheduleRefusal(params.schedule) : null

      if (refused) {
        return { success: false, error: refused }
      }

      const job = addCronJob({
        name,
        schedule: params.schedule,
        prompt: params.prompt,
        deliver: params.deliver,
        repeat: params.repeat,
        profile: scope
      })

      return {
        success: true,
        job: formatCronJob(job),
        job_id: job.id,
        jobs: listed(),
        ...scopedEcho,
        next_run_at: job.next_run_at,
        gateway_running: state.cronGatewayRunning
      }
    }

    const job = inScope().find(entry => entry.name === name || entry.id === name)

    if (!job) {
      return { success: false, error: `No such job: ${name}` }
    }

    if (action === 'remove') {
      state.cronJobs = state.cronJobs.filter(entry => entry.id !== job.id)
      publish('cron.changed', undefined, {})

      return {
        success: true,
        removed_job: { id: job.id, name: job.name, schedule: job.schedule },
        jobs: listed(),
        ...scopedEcho,
        gateway_running: state.cronGatewayRunning
      }
    }

    setCronPaused(job, action === 'pause')
    publish('cron.changed', undefined, {})

    return {
      success: true,
      job: formatCronJob(job),
      jobs: listed(),
      ...scopedEcho,
      gateway_running: state.cronGatewayRunning
    }
  }

  /**
   * Every `@file:` reference in a prompt whose file was actually uploaded.
   *
   * The wrappers are the ones `agent/context_references.py` strips: backticks
   * around a path with a space in it. A reference to a path nothing uploaded is
   * ignored rather than answered for, which is what makes "the upload failed and
   * the prompt went anyway" visible as a reply that mentions nothing.
   */
  function referencedUploads(prompt: string): { path: string; filename: string; bytes: number }[] {
    const found: { path: string; filename: string; bytes: number }[] = []

    for (const match of prompt.matchAll(/@file:(?:`([^`]+)`|(\S+))/g)) {
      const entry = state.uploadedFiles.get(match[1] ?? match[2] ?? '')

      if (entry) {
        found.push({ path: entry.path, filename: entry.filename, bytes: entry.bytes })
      }
    }

    return found
  }

  /**
   * Answer one prompt.
   *
   * Three keywords steer it, because those are the three paths a client has to
   * be able to survive: a prompt containing "approve" raises a server→client
   * approval and parks the turn until it is answered, "delegate" fans out
   * subagent events, and anything else streams a reply with one tool call.
   *
   * A prompt that references an uploaded file gets that named back in the reply.
   * Not decoration: it is the only way an end-to-end test can tell a file that
   * reached the agent from one that was uploaded and then never mentioned,
   * which is the whole failure mode the reference text exists to prevent.
   */
  function streamReply(session: FakeSession, prompt: string): void {
    const reply =
      scenario.replies?.find(entry => !entry.match || prompt.includes(entry.match)) ??
      DEFAULT_SCENARIO.replies?.[0] ??
      {}
    const uploads = referencedUploads(prompt)
    const received = uploads.map(file => `I received ${file.filename} (${file.bytes} bytes) at ${file.path}.`)
    const deltas = [...received, ...(reply.deltas ?? ['Working on it.'])]
    const text = received.length ? deltas.join('') : (reply.text ?? deltas.join(''))
    const sid = session.storedId
    let at = streamDelayMs
    // Every frame of this reply is scheduled now; an interrupt moves the
    // session's epoch on, and what this turn has not sent yet is dropped, as a
    // real agent stops talking when it is interrupted.
    const epoch = streamEpochs.get(sid) ?? 0
    // What the reader has seen so far: an interrupt keeps it in the history.
    let spoken = ''
    interruptedReplies.set(sid, () => spoken)
    const later = (fn: () => void, ms: number) =>
      laterAll(() => {
        if ((streamEpochs.get(sid) ?? 0) === epoch) {
          fn()
        }
      }, ms)

    state.runningSessions.add(sid)

    // The gateway mints one id per turn and writes it on the user row, beside the
    // author; the envelope of every frame of the turn names it too.
    const turn = {
      id: randomUUID().replace(/-/g, ''),
      user: prompt.trim(),
      assistant: '',
      sealedLen: null as number | null,
      metadata: rowIdentity ? { turn_id: '' } : null
    }

    if (turn.metadata) {
      turn.metadata.turn_id = turn.id
    }

    turns.set(sid, turn)

    const userRowId = session.messages.length + 1

    session.messages.push({
      role: 'user',
      text: prompt,
      row_id: userRowId,
      timestamp: nowSeconds(),
      ...(turn.metadata ? { display_metadata: { ...turn.metadata } } : {})
    })

    later(() => publish('message.start', sid, {}), at)

    // Reasoning before words. The client's reducer creates its assistant item on the
    // first frame of EITHER kind, so this ordering is what decides whether the
    // transcript's typing bubble is replaced before or after any text exists.
    for (const chunk of reply.reasoning ?? []) {
      at += streamDelayMs
      later(() => publish('reasoning.delta', sid, { text: chunk }), at)
    }

    if (reply.reasoningAvailable) {
      at += streamDelayMs
      later(() => publish('reasoning.available', sid, { text: reply.reasoningAvailable }), at)
    }

    for (const note of reply.notes ?? []) {
      const tool = note.tool
      const toolId = tool.id ?? `tool-${randomUUID().slice(0, 8)}`
      let call: { call_row_id: number; call_index: number } | undefined

      at += streamDelayMs
      later(() => {
        spoken += note.text
        turn.assistant += note.text
        publish('message.delta', sid, { text: note.text })
      }, at)
      at += streamDelayMs
      later(() => {
        // Written before the frame that announces it, as the fork does.
        const rowId = session.messages.length + 1

        session.messages.push({ role: 'assistant', text: note.text, row_id: rowId, timestamp: nowSeconds() })
        // The note is history now: an interrupt keeps it as its own row.
        spoken = ''

        if (rowIdentity) {
          call = { call_row_id: rowId, call_index: 0 }
          turn.sealedLen = turn.assistant.length
          publish('message.interim', sid, { text: note.text, already_streamed: true, row_id: rowId })
        }
      }, at)
      at += streamDelayMs
      later(
        () =>
          publish('tool.start', sid, {
            tool_id: toolId,
            name: tool.name,
            context: tool.summary ?? '',
            args: tool.args ?? {},
            ...call
          }),
        at
      )
      at += streamDelayMs
      later(() => {
        // The tool row lands before the frame that announces the result.
        const rowId = session.messages.length + 1

        session.messages.push({
          role: 'tool',
          name: tool.name,
          context: tool.summary ?? '',
          tool_call_id: toolId,
          ...(tool.args ? { args: tool.args } : {}),
          ...(rowIdentity ? { row_id: rowId, ...call } : {}),
          timestamp: nowSeconds()
        })
        publish('tool.complete', sid, {
          tool_id: toolId,
          name: tool.name,
          args: tool.args ?? {},
          duration_s: 0.2,
          result: tool.result ?? null,
          summary: tool.summary ?? '',
          ...call,
          ...(rowIdentity ? { row_id: rowId } : {})
        })
      }, at)
    }

    // Where the tool call goes. Past the end means "after everything", which is
    // what a scenario without `toolAfterDeltas` asks for.
    const cut = reply.toolAfterDeltas ?? deltas.length

    const emitDeltas = (from: number, to: number) => {
      for (const delta of deltas.slice(from, to)) {
        at += streamDelayMs
        later(() => {
          spoken += delta
          turn.assistant += delta
          publish('message.delta', sid, { text: delta })
        }, at)
      }
    }

    emitDeltas(0, cut)

    // The call of the single `tool`, and what its assistant row holds: see `finish`.
    const toolCall: { row?: { id: number; text: string } } = {}

    if (reply.tool) {
      const toolId = reply.tool.id ?? `tool-${randomUUID().slice(0, 8)}`
      let call: { call_row_id: number; call_index: number } | undefined

      if (reply.toolGenerating) {
        at += streamDelayMs
        later(() => publish('tool.generating', sid, { name: reply.tool?.name }), at)
      }

      at += streamDelayMs
      later(() => {
        if (rowIdentity) {
          // The round's assistant row holds what was streamed so far (possibly
          // nothing) and the call, and is persisted before the call starts. No
          // `message.interim` names it: that is a gateway with interim notes off.
          const rowId = session.messages.length + 1

          session.messages.push({ role: 'assistant', text: spoken, row_id: rowId, timestamp: nowSeconds() })
          toolCall.row = { id: rowId, text: spoken }
          spoken = ''
          call = { call_row_id: rowId, call_index: 0 }
        }

        publish('tool.start', sid, {
          tool_id: toolId,
          name: reply.tool?.name,
          context: reply.tool?.summary ?? '',
          args: reply.tool?.args ?? {},
          ...call
        })
      }, at)
      at += streamDelayMs
      later(() => {
        let resultRowId: number | undefined

        if (rowIdentity) {
          resultRowId = session.messages.length + 1
          session.messages.push({
            role: 'tool',
            name: reply.tool?.name ?? null,
            context: reply.tool?.summary ?? '',
            tool_call_id: toolId,
            ...(reply.tool?.args ? { args: reply.tool.args } : {}),
            row_id: resultRowId,
            ...call,
            timestamp: nowSeconds()
          })
        }

        publish('tool.complete', sid, {
          tool_id: toolId,
          name: reply.tool?.name,
          args: reply.tool?.args ?? {},
          duration_s: 0.2,
          result: reply.tool?.result ?? null,
          summary: reply.tool?.summary ?? '',
          ...call,
          ...(resultRowId === undefined ? {} : { row_id: resultRowId })
        })
      }, at)
    }

    emitDeltas(cut, deltas.length)

    if (/delegate/i.test(prompt)) {
      at = streamSubagents(sid, at)
    }

    if (/\bdm\b/i.test(prompt)) {
      at = streamBotDm(session, prompt, at)
    }

    const finish = () => {
      state.runningSessions.delete(sid)

      // A reply whose words all came BEFORE its one tool call has no text left for a row of its own:
      // the row that holds the call is the row that holds the answer. The fork reports a final row
      // only when it is one WITHOUT `tool_calls` (`_persisted_turn_receipt`), so the completion of
      // such a turn names none: no `row_id`, no `final_assistant_row_id`. A client settles the
      // reply onto the note the call sealed, as it does for a gateway that sends no ids, and the
      // turn never persists the same words twice, as two bubbles.
      const endsOnCall = rowIdentity && toolCall.row?.text === text
      const finalRowId = endsOnCall ? undefined : session.messages.length + 1
      // The files this reply shares are copied at the end of the turn, and the final row carries them.
      const shared: WireAttachment[] = (reply.attachments ?? []).map(entry =>
        wireOf(storeFile(state.outboxFiles, session.profile, sampleOf(entry), nowSeconds()))
      )

      if (finalRowId !== undefined) {
        session.messages.push({
          role: 'assistant',
          text,
          row_id: finalRowId,
          timestamp: nowSeconds(),
          ...(reply.attachments ? { attachments: shared } : {})
        })
      }

      // The turn's rows, from its user row on, the way `_persisted_turn_receipt` reports them.
      const tail = session.messages.slice(userRowId - 1)
      const receipt = {
        row_ids: tail.map(row => row.row_id).filter((id): id is number => typeof id === 'number'),
        complete: tail.filter(row => row.role === 'user').length === 1,
        user_row_id: userRowId,
        ...(finalRowId === undefined ? {} : { final_assistant_row_id: finalRowId })
      }

      publish('message.complete', sid, {
        text,
        status: 'ok',
        ...(reply.attachments ? { attachments: shared } : {}),
        // The context fields too, as `_get_usage` writes them: a client that takes the finished turn's usage as the
        // session's reading would otherwise lose the window it was showing, and show a stale one until it asked again.
        usage: { input: 12, output: 34, total: 46, ...contextFieldsOf(sessionUsage(session)) },
        ...(rowIdentity ? { ...(finalRowId === undefined ? {} : { row_id: finalRowId }), persisted_turn: receipt } : {})
      })
      // Cleared after the frame that ends the turn, so that frame is stamped too.
      if (turns.get(sid) === turn) {
        turns.delete(sid)
      }

      publish('sessions.changed', undefined, {})
    }

    if (/approve/i.test(prompt)) {
      // The turn parks on the question, exactly as the real approval queue does:
      // nothing completes until a client answers.
      at += streamDelayMs
      later(() => void raiseApproval(session).then(finish), at)

      return
    }

    at += streamDelayMs
    later(finish, at)
  }

  /**
   * `session.resume`'s `inflight` (`session_auto_continue._inflight_snapshot`): the turn that is
   * running, for a client that reconnects in the middle of it. `null` when none is.
   *
   * `assistant` is every streamed word of the turn, notes already sealed and persisted included.
   * With the identity on, `assistant_unsealed` is what came after the last sealed note (the field
   * is left out while no note was sealed) and `display_metadata` carries the turn's id, which is
   * how a client holding the user row by id knows it already shows the prompt.
   */
  function inflightOf(session: FakeSession): Record<string, unknown> | null {
    const turn = turns.get(session.storedId)

    if (!turn || !state.runningSessions.has(session.storedId)) {
      return null
    }

    return {
      assistant: turn.assistant,
      streaming: true,
      user: turn.user,
      ...(rowIdentity && turn.sealedLen !== null
        ? { assistant_unsealed: turn.assistant.slice(turn.sealedLen).trimStart() }
        : {}),
      ...(rowIdentity && turn.metadata ? { display_metadata: { ...turn.metadata } } : {})
    }
  }

  /**
   * One `delegate_task` fan-out, start to finish.
   *
   * Three children rather than one, staggered over `subagentStepMs` per frame,
   * and the third one FAILS. All three properties are load-bearing for what a
   * client has to get right: a tree with siblings, a window in which the bar,
   * the sheet, Steer and Stop actually exist, and a failure that has to reach
   * the group card without taking the other two down with it.
   *
   * The fan-out is wrapped in a real `delegate_task` tool call, because that is
   * how the group card learns its goals before any child has reported and how
   * it gets a completion summary at the end.
   */
  function streamSubagents(sid: string, startAt: number): number {
    const delegationId = `del-${randomUUID().slice(0, 6)}`
    const toolId = `tool-${randomUUID().slice(0, 8)}`
    const children = [
      {
        goal: 'Audit the dependencies',
        thinking: 'Reading the lockfile.',
        tool: { tool_name: 'read_file', text: 'package-lock.json' },
        progress: 'Two packages behind.',
        status: 'completed',
        summary: 'Two packages behind; no advisories.'
      },
      {
        goal: 'Summarize the changelog',
        thinking: 'Skimming the last three releases.',
        tool: { tool_name: 'read_file', text: 'CHANGELOG.md' },
        progress: 'Nine entries since the last tag.',
        status: 'completed',
        summary: 'Nine entries since the last tag; two are breaking.'
      },
      {
        goal: 'Check the licence headers',
        thinking: 'Walking src/.',
        tool: { tool_name: 'run_command', text: 'rg -l "SPDX"' },
        progress: 'The scanner is not installed here.',
        status: 'failed',
        summary: 'Could not run the scanner: rg is not installed.'
      }
    ]

    const tasks = children.map(child => ({ goal: child.goal }))
    let at = startAt + subagentStepMs

    later(
      () =>
        publish('tool.start', sid, {
          tool_id: toolId,
          name: 'delegate_task',
          context: `delegate_task(${children.length} tasks)`,
          args: { tasks }
        }),
      at
    )

    children.forEach((child, index) => {
      const subagentId = `sub-${randomUUID().slice(0, 6)}`
      const common = {
        subagent_id: subagentId,
        delegation_id: delegationId,
        parent_id: null,
        goal: child.goal,
        task_index: index,
        task_count: children.length,
        depth: 1,
        model: 'example-provider/example-model',
        child_session_id: `child-${subagentId}`
      }

      const frames: [string, Record<string, unknown>][] = [
        ['subagent.spawn_requested', {}],
        ['subagent.start', { status: 'running' }],
        ['subagent.thinking', { text: child.thinking }],
        ['subagent.tool', { ...child.tool, status: 'running' }],
        ['subagent.progress', { text: child.progress }],
        [
          'subagent.complete',
          {
            status: child.status,
            summary: child.summary,
            duration_seconds: (FRAMES_PER_CHILD + index) * (subagentStepMs / 1000),
            ...(child.status === 'failed' ? { error: child.summary } : {})
          }
        ]
      ]

      // Children are staggered: the second starts a step after the first, so
      // the bar counts up rather than jumping from nothing to three.
      frames.forEach(([type, payload], frame) => {
        const when = at + (frame + 1 + index) * subagentStepMs

        later(() => {
          if (type === 'subagent.start' || type === 'subagent.spawn_requested') {
            state.liveSubagents.set(subagentId, {
              subagent_id: subagentId,
              parent_id: null,
              depth: 1,
              goal: child.goal,
              delegation_id: delegationId,
              model: 'example-provider/example-model',
              started_at: nowSeconds(),
              status: type === 'subagent.start' ? 'running' : 'queued',
              tool_count: 0,
              last_tool: null,
              accepting_steer: true,
              child_session_id: `child-${subagentId}`,
              owner_session_id: sid
            })
            ensureChildSession(`child-${subagentId}`, child.goal, child.summary)
          }

          const live = state.liveSubagents.get(subagentId)

          if (live && type === 'subagent.tool') {
            live.tool_count += 1
            live.last_tool = String(child.tool.tool_name)
          }

          if (type === 'subagent.complete') {
            // A real gateway drops a finished child from the live registry.
            state.liveSubagents.delete(subagentId)
          }

          publish(type, sid, { ...common, ...payload })
        }, when)
      })
    })

    // One step past the last child's completion, so the card's summary lands
    // after every row it summarizes.
    at += (FRAMES_PER_CHILD + children.length) * subagentStepMs

    later(
      () =>
        publish('tool.complete', sid, {
          tool_id: toolId,
          name: 'delegate_task',
          args: { tasks },
          duration_s: ((FRAMES_PER_CHILD + children.length) * subagentStepMs) / 1000,
          error: true,
          summary: `${children.length - 1} of ${children.length} finished; the licence check failed.`
        }),
      at
    )

    return at
  }

  /**
   * One live `message_agent` hand-off, end to end.
   *
   * Fire-and-forget on purpose, because that is what the real tool is: the call
   * answers `queued` with a `process_id` and the teammate's reply lands much
   * later as a `process_complete` ROW, joined back onto the dispatch by that id.
   * While the delivery is out, a `bot_mode_dm.py --run-delivery` process sits in
   * `agents.list` — which is the only place a client can count deliveries that
   * are in flight.
   *
   * The recipient's own chat gets the inbound row too, so both sides of the
   * conversation are real and the Activity timeline has something to dedupe.
   */
  function streamBotDm(session: FakeSession, prompt: string, startAt: number): number {
    const target = session.profile === 'writer' ? 'researcher' : 'writer'
    const recipient = [...state.sessions.values()].find(entry => entry.profile === target && entry.title === 'Bot Chat')
    const message = prompt.replace(/^.*?\bdm\b[:\s]*/iu, '').trim() || 'Can you take a look at this?'
    const toolId = `tool-${randomUUID().slice(0, 8)}`
    const processId = `proc-${randomUUID().slice(0, 6)}`
    const sid = session.storedId
    const senderName = session.profile[0]?.toUpperCase() + session.profile.slice(1)
    const command = DM_DELIVERY_COMMAND.replace('-p writer', `-p ${target}`)
    let at = startAt + streamDelayMs

    later(
      () =>
        publish('tool.start', sid, {
          tool_id: toolId,
          name: 'message_agent',
          context: `message_agent(${target})`,
          args: { target: `@${target}`, message }
        }),
      at
    )

    at += streamDelayMs
    later(() => {
      publish('tool.complete', sid, {
        tool_id: toolId,
        name: 'message_agent',
        args: { target: `@${target}`, message },
        duration_s: 0.1,
        result: { status: 'queued', delivery_id: `dlv-${processId}`, to: target, process_id: processId }
      })

      state.agentProcesses.set(processId, {
        session_id: sid,
        command,
        status: 'running',
        startedAt: nowSeconds()
      })
    }, at)

    // The recipient's side: an inbound row, and its reply.
    const reply = `Got it — ${message.slice(0, 48)}${message.length > 48 ? '…' : ''} is in hand.`

    at += subagentStepMs
    later(() => {
      if (recipient) {
        recipient.messages.push({
          role: 'user',
          text: `Message from 🤖 ${senderName} (@${session.profile}): ${message}`,
          row_id: recipient.messages.length + 1,
          timestamp: nowSeconds()
        })
        recipient.messages.push({
          role: 'assistant',
          text: reply,
          row_id: recipient.messages.length + 1,
          timestamp: nowSeconds()
        })
      }

      publish('sessions.changed', undefined, {})
    }, at)

    // …and the sender's side: the background process reporting back.
    at += subagentStepMs
    later(() => {
      state.agentProcesses.delete(processId)
      session.messages.push({
        role: 'user',
        text: [
          `[IMPORTANT: Background process ${processId} completed (exit code 0).`,
          `Command: ${command}`,
          'Output:',
          `Message from 🤖 ${target[0]?.toUpperCase()}${target.slice(1)} (@${target}): ${reply}]`
        ].join('\n'),
        row_id: session.messages.length + 1,
        timestamp: nowSeconds(),
        display_kind: 'process_complete',
        display_metadata: { display_text: 'Background Process Finished: bot_mode_dm.py' }
      })

      publish('sessions.changed', undefined, {})
    }, at)

    return at
  }

  /**
   * A stand-in transcript for a delegated child, so "Open transcript" has
   * something real to read through `session.history`.
   */
  function ensureChildSession(id: string, goal: string, summary: string): void {
    if (state.sessions.has(id)) {
      return
    }

    state.sessions.set(id, {
      id,
      storedId: id,
      profile: 'subagent',
      title: goal,
      hidden: false,
      seq: 0,
      ring: [],
      messages: [
        { role: 'user', text: goal, row_id: 1, timestamp: nowSeconds() },
        {
          role: 'tool',
          name: 'read_file',
          tool_id: `${id}-call-1`,
          context: 'read_file(package-lock.json)',
          args: { path: 'package-lock.json' }
        },
        { role: 'assistant', text: summary, row_id: 2, timestamp: nowSeconds() + 1 }
      ]
    })
  }

  /** Raise an approval and wait for the answer, the way the queue does. */
  async function raiseApproval(session: FakeSession): Promise<void> {
    const requestId = `appr-${randomUUID().slice(0, 8)}`
    const payload = {
      request_id: requestId,
      command: 'rm -rf ./build',
      description: 'Remove the build directory',
      tool_name: 'run_command',
      choices: ['once', 'session', 'always', 'deny'],
      allow_permanent: true,
      allow_session: true
    }

    state.pendingApprovals.set(requestId, { session_id: session.storedId, payload })

    try {
      await sendServerRequest('approval', session.id, payload)
    } catch {
      // A client that declines the request leaves the queue entry withdrawn.
    } finally {
      state.pendingApprovals.delete(requestId)
    }
  }

  /**
   * A turn this client never submitted: someone else prompted the same session.
   * The rows land in history and the socket sees the same event sequence a live
   * turn produces, so a foreign-turn placeholder has something to reconcile
   * against.
   */
  function injectForeignTurn(
    session: FakeSession,
    turn: {
      user: string
      assistant: string
      stream: boolean
      status?: string
      error?: string
      /**
       * HERM-83: stages what the gateway fork stamps on a submitted turn —
       * `display_metadata.author` — so a client can be checked against a row
       * attributed to somebody who is not the reader, without a second login.
       */
      author?: InjectedAuthor
      /** `display_metadata.replayed_by`: who pressed retry when it was not the author; `via` when an agent did. */
      replayedBy?: InjectedAuthor
    }
  ): void {
    const sid = session.storedId

    session.messages.push({
      role: 'user',
      text: turn.user,
      row_id: session.messages.length + 1,
      timestamp: nowSeconds(),
      ...(turn.author || turn.replayedBy
        ? {
            display_metadata: {
              ...(turn.author ? { author: turn.author } : {}),
              ...(turn.replayedBy ? { replayed_by: turn.replayedBy } : {})
            }
          }
        : {})
    })

    if (turn.stream) {
      publish('message.start', sid, {})
      publish('message.delta', sid, { text: turn.assistant })
    }

    session.messages.push({
      role: 'assistant',
      text: turn.assistant,
      row_id: session.messages.length + 1,
      timestamp: nowSeconds()
    })

    if (turn.stream) {
      publish('message.complete', sid, {
        text: turn.assistant,
        status: turn.status ?? 'ok',
        ...(turn.error ? { error: turn.error } : {})
      })
    }

    publish('sessions.changed', undefined, {})
  }

  /** The profile's canonical chat, which is what a Bot Chat means here. */
  function sessionForProfile(profile: string): FakeSession | undefined {
    return [...state.sessions.values()].find(entry => entry.profile === profile && entry.title === 'Bot Chat')
  }

  /**
   * Put one approval on the queue, and — unless `queueOnly` — send the
   * server→client request too.
   *
   * Both, because a real gateway does both: `tools/approval.py` enqueues the
   * entry that `approval.pending` and `session.resume`'s `pending_approval`
   * report, and the transport separately asks a client. A fake that only did
   * the second made the queue unreachable, and the queue is the only route a
   * client that has not asked for server requests has.
   */
  function queueApproval(session: FakeSession, command: string, queueOnly: boolean): Promise<unknown> {
    const requestId = `appr-${randomUUID().slice(0, 8)}`
    const payload = {
      request_id: requestId,
      command,
      description: 'Remove the build directory',
      tool_name: 'run_command',
      choices: ['once', 'session', 'always', 'deny'],
      allow_permanent: true,
      allow_session: true
    }

    state.pendingApprovals.set(requestId, { session_id: session.storedId, payload })

    if (queueOnly) {
      return Promise.resolve(undefined)
    }

    return requestServerSide('approval', { session_id: session.id, ...payload }).finally(() => {
      state.pendingApprovals.delete(requestId)
    })
  }

  function setPushSection(registrations: Record<string, unknown>, seen: Record<string, number>): void {
    const profile = state.profiles.find(row => row.is_default) ?? state.profiles[0]

    if (!profile) {
      return
    }

    const bag = { ...(profile.ui_meta ?? {}) }
    const app = (bag['hermie-app'] ?? { v: 1 }) as Record<string, unknown>
    bag['hermie-app'] = { ...app, v: 1, push: { ...((app.push ?? {}) as object), registrations, seen } }
    profile.ui_meta = bag
    profile.ui_meta_revisions = {
      ...profile.ui_meta_revisions,
      'hermie-app': (profile.ui_meta_revisions?.['hermie-app'] ?? 0) + 1
    }
    publish('sessions.changed', undefined, {})
  }

  /** Send one server→client request and resolve with the client's answer. */
  function sendServerRequest(method: string, sessionId: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === 'confirm' && confirmGate) {
      return confirmThroughGate(sessionId, params)
    }

    const id = `srq-${++serverRequestSequence}`
    const runtimeId = resolveRuntimeId(sessionId)

    const withFields = method === 'confirm' && Array.isArray(params.fields) && params.fields.length > 0

    state.openServerRequests.set(id, {
      session_id: runtimeId,
      method,
      params,
      // A request with fields is listed on resume only to a connection that shows them.
      ...(withFields ? { viewer: (peer: WebSocket) => confirmFields.has(peer) } : {})
    })

    return new Promise<unknown>((resolve, reject) => {
      // A gated request reaches only the connections that offered its level, and
      // a request nobody can answer is `unavailable` at once rather than open.
      const targets =
        method === 'confirm'
          ? socketsOfferingConfirm(confirmLevelOf(params), Array.isArray(params.fields) && params.fields.length > 0)
          : [...sockets]

      if (method === 'confirm' && targets.length === 0) {
        reject(new Error(`unavailable: no connected client offered the ${confirmLevelOf(params)} confirm level`))

        return
      }

      pendingServerRequests.set(id, { resolve, reject })

      for (const socket of targets) {
        send(socket, { jsonrpc: '2.0', id, method, params: { session_id: runtimeId, ...params } })
      }
    }).finally(() => {
      state.openServerRequests.delete(id)
    })
  }

  /** The `confirm` levels a `client.capabilities` call offered: the strings in its list, de-duplicated. */
  function confirmLevelsOf(params: Record<string, unknown>): string[] {
    const list = Array.isArray(params.confirm) ? params.confirm : []

    return [...new Set(list.filter((level): level is string => typeof level === 'string' && level.length > 0))]
  }

  /**
   * Remember what one connection says it handles.
   *
   * The levels belong to the socket, not to the gateway: a `confirm` is sent only
   * to the connections that offered its level, as `server_requests.send_gated`
   * does, so two clients on one gateway can differ.
   */
  function recordClientCapabilities(socket: WebSocket, params: Record<string, unknown>): void {
    const levels = params.server_requests === true ? confirmLevelsOf(params) : []

    // The methods this connection can show; what it said before is replaced, as for the confirm levels.
    const requests = interactive.advertise(socket, params)

    state.clientCapabilities.push({
      server_requests: params.server_requests === true,
      confirm: levels,
      ...(params.confirm_passkey === undefined ? {} : { confirm_passkey: params.confirm_passkey }),
      ...(params.confirm_fields === undefined ? {} : { confirm_fields: params.confirm_fields }),
      ...(Array.isArray(params.requests) ? { requests } : {})
    })

    if (levels.length) {
      confirmLevels.set(socket, levels)
    } else {
      confirmLevels.delete(socket)
    }

    // Exactly `true`, and only together with a level: any other value never fails the call and never counts.
    if (levels.length && params.confirm_fields === true) {
      confirmFields.add(socket)
    } else {
      confirmFields.delete(socket)
    }
  }

  /**
   * The live sockets that offered `level`: who a `confirm` of that level may reach. A request with structured
   * fields (`needsFields`) reaches only those that also advertised `confirm_fields: true`.
   */
  function socketsOfferingConfirm(level: string, needsFields = false): WebSocket[] {
    return [...sockets].filter(
      socket => confirmLevels.get(socket)?.includes(level) && (!needsFields || confirmFields.has(socket))
    )
  }

  /** The level a `confirm` request names; the contract's default is `plain`. */
  function confirmLevelOf(params: Record<string, unknown>): string {
    return typeof params.level === 'string' && params.level ? params.level : 'plain'
  }

  /** Push one server→client request and resolve with whatever the client answers. */
  function requestServerSide(method: string, params: Record<string, unknown>): Promise<unknown> {
    const sessionId = typeof params.session_id === 'string' ? params.session_id : ''
    const { session_id: _ignored, ...rest } = params

    return sendServerRequest(method, sessionId, rest)
  }

  // ---------------------------------------------------------- passkey level ---

  /**
   * The server a `confirm` gate lives in: its connections, who each is signed in as, how a frame is
   * written and a cancel published, and where an open request is listed for `session.resume`.
   */
  const confirmHost: ConfirmHost<WebSocket> = {
    peers: () => [...sockets],
    identityOf: socket => socketIdentities.get(socket) ?? null,
    // The account a request is for when the control call names none: a gateway with one account has one.
    defaultUser: () => (gated() && accounts[0] ? identityOfAccount(accounts[0]) : null),
    displayNameOf: user => accounts.find(account => userKey(identityOfAccount(account)) === user)?.displayName ?? user,
    send: (socket, frame) => send(socket, frame),
    publish: (type, sessionId, payload) => publish(type, sessionId, payload),
    later: (fn, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        fn()
      }, ms)

      timers.add(timer)
      timer.unref?.()

      return () => {
        clearTimeout(timer)
        timers.delete(timer)
      }
    },
    nextRequestId: () => `srq-${++serverRequestSequence}`,
    now: () => Date.now(),
    register: (id, entry) => {
      state.openServerRequests.set(id, {
        session_id: entry.sessionId,
        method: 'confirm',
        params: entry.params,
        viewer: entry.viewer
      })
    },
    forget: id => {
      state.openServerRequests.delete(id)
    },
    recordAnswer: ({ id, result, error }) => {
      state.serverRequestAnswers.push({ id, method: 'confirm', ...(error ? { error } : { result }) })
    }
  }

  /**
   * The interactive requests (`input.form`, `input.file`, `review.draft`): who they go to, how an answer
   * is checked, when they end. Every gateway has it: a client that never advertises them never sees one.
   */
  const reviewDrafts = new ReviewRegister()

  /**
   * The `buildText` input of a `confirm` raised by a control call: the text as given, the structured `fields`
   * (checked verbatim) and, with a `draft_id`, the detail the person approved in `review.draft` taken verbatim
   * from the review register (whatever detail the caller passed is ignored). Throws `ConfirmParamsError`.
   */
  function confirmTextInput(conversation: string, params: Record<string, unknown>): Parameters<typeof buildText>[0] {
    const drafted = params.draft_id !== undefined && params.draft_id !== null

    return {
      title: params.title,
      summary: params.summary ?? params.text,
      detail: drafted ? draftDetail(reviewDrafts, conversation, params.draft_id, Date.now()) : params.detail,
      level: params.level,
      fields: params.fields,
      verbatimDetail: drafted
    }
  }

  /**
   * What a `confirm` on a gateway without the passkey level adds when the caller names `fields` or a
   * `draft_id`: the fields built and checked as the gate builds them, and the draft's text as the detail.
   * Without either, nothing changes (that path forwards the params as given).
   */
  function permissiveConfirmExtras(
    conversation: string,
    params: Record<string, unknown>
  ): { fields: ReturnType<typeof buildFields>; params: Record<string, unknown> } {
    const fields = buildFields(params.fields)
    const drafted = params.draft_id !== undefined && params.draft_id !== null
    const detail = drafted ? draftDetail(reviewDrafts, conversation, params.draft_id, Date.now()) : undefined

    return {
      fields,
      params: {
        ...(fields ? { fields } : {}),
        ...(detail === undefined ? {} : { detail })
      }
    }
  }

  const interactive = new InteractiveGate<WebSocket>({
    drafts: reviewDrafts,
    uploaded: path => state.uploadedFiles.get(path),
    peers: () => [...sockets],
    send: (socket, frame) => send(socket, frame),
    publish: (type, sessionId, payload) => publish(type, sessionId, payload),
    later: (fn, ms) => {
      const timer = setTimeout(() => {
        timers.delete(timer)
        fn()
      }, ms)

      timers.add(timer)
      timer.unref?.()

      return () => {
        clearTimeout(timer)
        timers.delete(timer)
      }
    },
    nextRequestId: () => `srq-${++serverRequestSequence}`,
    now: () => Date.now(),
    register: (id, entry) => {
      state.openServerRequests.set(id, {
        session_id: entry.sessionId,
        method: entry.method,
        params: entry.params,
        viewer: entry.viewer
      })
    },
    forget: id => {
      state.openServerRequests.delete(id)
    },
    recordAnswer: ({ id, method, result, error }) => {
      state.serverRequestAnswers.push({ id, method, ...(error ? { error } : { result }) })
    }
  })

  /**
   * Raise an interactive request on a profile's chat; the params default to the contract's example. A
   * `review.diff` named by `params.diff` is read by the gateway's own parser (`parseDiff`): the hunks, their
   * ids and anchors, `kind`, `path` and `old_path` are the parser's, and a diff it refuses is `refused`.
   */
  function raiseInteractive(options: {
    profile?: string
    method: InteractiveMethod
    params?: Record<string, unknown>
    user?: string | null
  }): RaiseInteractiveResult {
    const profile = options.profile ?? 'researcher'
    const session = [...state.sessions.values()].find(entry => entry.profile === profile)

    if (!session) {
      return { kind: 'no_session', profile }
    }

    const defaults = defaultParams(options.method, Date.now())
    const { diff, path, ...given } = options.params ?? {}

    if (options.method === 'review.diff' && diff !== undefined) {
      let parsed

      try {
        parsed = parseDiff(diff, typeof path === 'string' ? path : null)
      } catch (error) {
        if (error instanceof DiffError) {
          return { kind: 'refused', error: 'diff_refused', detail: error.message }
        }

        throw error
      }

      const { old_path: _example, ...base } = defaults
      const oldPath = headOldPath(parsed.head)

      return interactive.raise({
        sessionId: session.id,
        conversation: session.storedId,
        method: options.method,
        head: parsed.head,
        params: {
          ...base,
          title: 'Review changes',
          summary: 'Review these changes hunk by hunk: only the hunks you approve are applied.',
          ...given,
          kind: parsed.head.kind,
          path: headPath(parsed.head),
          ...(oldPath === null ? {} : { old_path: oldPath }),
          hunks: parsed.hunks
        },
        ...(options.user === null ? { noActingUser: true } : {})
      })
    }

    const params: Record<string, unknown> = { ...defaults, ...options.params }

    // A calendar item is what the gateway's builder makes of what the agent passed: cleaned, bounded, consistent.
    if (options.method === 'device.calendar' && options.params && 'item' in options.params) {
      try {
        params.item = calendarItemOf(options.params.item)
      } catch (error) {
        if (error instanceof CalendarItemRefused) {
          return { kind: 'refused', error: 'item_refused', detail: error.message }
        }

        throw error
      }
    }

    return interactive.raise({
      sessionId: session.id,
      conversation: session.storedId,
      method: options.method,
      params,
      ...(options.user === null ? { noActingUser: true } : {})
    })
  }

  /** `POST /__fake/request-limits`, and the handle's `interactiveLimits`. */
  function interactiveLimits(change: { enabled?: boolean; reset?: boolean }): { enabled: boolean } {
    if (change.enabled !== undefined) {
      interactive.limited = change.enabled
    }

    if (change.reset) {
      interactive.limits.reset()
    }

    return { enabled: interactive.limited }
  }

  interactive.limited = options.interactiveLimits === true

  /**
   * Make this gateway know the level `passkey`, or change how it is set up. The first call creates the
   * store (a new gateway identity); later ones only change the operator's settings, which is what editing
   * `confirm.passkey` in `config.yaml` is.
   */
  function enablePasskey(options: PasskeyOptions = {}): PasskeyGateway {
    if (passkey) {
      passkey.settings = applySettings(passkey.settings, options, () => ownUrl)

      return passkey
    }

    const created = new PasskeyGateway(
      applySettings(null, options, () => ownUrl),
      () => ownUrl,
      {
        // `passkey.changed` goes to every live connection signed in as that user, and to nobody else.
        announce: (userId, payload) => {
          let delivered = 0

          for (const socket of sockets) {
            const identity = socketIdentities.get(socket)

            if (identity && userKey(identity) === userId) {
              send(socket, {
                jsonrpc: '2.0',
                method: 'event',
                params: { type: 'passkey.changed', session_id: '', payload }
              })
              delivered += 1
            }
          }

          return delivered
        }
      }
    )

    passkey = created
    confirmGate = new ConfirmGate(created, confirmHost)

    return created
  }

  /**
   * Make this gateway serve MCP, or change how it is set up. The first call creates the registry (empty);
   * later ones only change the operator's settings, which is what editing `dashboard.mcp` is.
   */
  function enableMcp(mcpOptions: McpOptions = {}): McpGateway {
    if (mcp) {
      mcp.configure(mcpOptions)

      return mcp
    }

    mcp = new McpGateway(mcpOptions, {
      ownUrl: () => ownUrl,
      acceptedOrigins: () => [
        new URL(ownUrl).origin,
        ...(publicHost ? [`http://${publicHost}`, `https://${publicHost}`] : [])
      ],
      // `mcp.changed` goes to every live connection signed in as that person, and to nobody else.
      announce: (userId, payload) => {
        let delivered = 0

        for (const socket of sockets) {
          const identity = socketIdentities.get(socket)

          if (identity && userKey(identity) === userId) {
            send(socket, {
              jsonrpc: '2.0',
              method: 'event',
              params: { type: 'mcp.changed', session_id: '', payload }
            })
            delivered += 1
          }
        }

        return delivered
      }
    })

    return mcp
  }

  /** `self_enrol` of a control body (`{enabled?, accept_missing_auth_time?, cooling_off_s?}`) as the options. */
  function selfEnrolOptions(value: unknown): NonNullable<PasskeyOptions['selfEnrol']> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new SettingsError('self_enrol must be an object')
    }

    const raw = value as Record<string, unknown>

    return {
      ...(raw.enabled === undefined ? {} : { enabled: raw.enabled as boolean }),
      ...(raw.accept_missing_auth_time === undefined
        ? {}
        : { acceptMissingAuthTime: raw.accept_missing_auth_time as boolean }),
      ...(raw.cooling_off_s === undefined ? {} : { coolingOffS: raw.cooling_off_s as number })
    }
  }

  /**
   * The script a `POST /__fake/passkey/reauth` body asks for, `null` to clear it, or the message of a 400:
   * `{fail?, auth_time?, user?, provider?, sticky?}`.
   */
  function scriptOf(body: Record<string, unknown>): SignInScript | null | string {
    const keys = Object.keys(body)

    if (body.clear === true || keys.length === 0) {
      return null
    }

    const script: SignInScript = { sticky: body.sticky === true }

    if (body.fail !== undefined) {
      if (typeof body.fail !== 'string' || !(GRANT_FAILURES as readonly string[]).includes(body.fail)) {
        return `fail is one of ${GRANT_FAILURES.join(', ')}`
      }

      script.fail = body.fail as GrantFailure
    }

    if ('auth_time' in body) {
      const time = body.auth_time

      if (time !== null && (typeof time !== 'number' || !Number.isInteger(time) || time < 0)) {
        return 'auth_time is a whole number of Unix seconds, or null for a provider that does not say'
      }

      script.authTime = time as number | null
    }

    if (body.user !== undefined) {
      const user = resolveUser(body.user)

      if (typeof user !== 'string') {
        return 'user is <provider>:<id>, an account’s user id or its username'
      }

      script.user = user
    }

    if (body.provider !== undefined) {
      if (typeof body.provider !== 'string' || !body.provider) {
        return 'provider is a provider name'
      }

      script.provider = body.provider
    }

    return script
  }

  function scriptView(script: SignInScript | null): Record<string, unknown> | null {
    return script
      ? {
          ...(script.fail ? { fail: script.fail } : {}),
          ...(script.authTime === undefined ? {} : { auth_time: script.authTime }),
          ...(script.user ? { user: script.user } : {}),
          ...(script.provider ? { provider: script.provider } : {}),
          sticky: script.sticky
        }
      : null
  }

  /** The user an operator call names: `<provider>:<id>`, an account's user id, or its username. */
  function resolveUser(value: unknown): string | null | undefined {
    if (value === null) {
      return null
    }

    if (typeof value !== 'string' || !value) {
      return undefined
    }

    const account = accounts.find(row => row.userId === value || row.username === value)

    return account ? userKey(identityOfAccount(account)) : value
  }

  /** `confirm` through the gate, for a caller that wants the outcome (the TypeScript handle, `requestServerSide`). */
  function confirmThroughGate(sessionId: string, params: Record<string, unknown>): Promise<unknown> {
    const session = resolveSession(sessionId)

    if (!session || !confirmGate) {
      return Promise.reject(new Error(`Unknown session: ${sessionId}`))
    }

    let text

    try {
      text = buildText(confirmTextInput(session.storedId, params))
    } catch (error) {
      return Promise.reject(error)
    }

    const raised = confirmGate.raise({
      sessionId: session.id,
      conversation: session.storedId,
      text,
      ...('user' in params ? { user: resolveUser(params.user) ?? null } : {}),
      ...(params.turn_isolation === true ? { turnIsolation: true } : {}),
      ...(typeof params.timeout_seconds === 'number' ? { timeoutSeconds: params.timeout_seconds } : {})
    })

    return raised.kind === 'open'
      ? raised.done
      : Promise.resolve({ outcome: 'unavailable', method: null, verified: false, reason: raised.reason })
  }

  /** What `/__fake/state` says about the passkey level: public facts only, never a key, a code or a signature. */
  function passkeyView(): Record<string, unknown> | undefined {
    if (!passkey || !confirmGate) {
      return undefined
    }

    const ctx = passkey.context()
    const credentials = passkey.store.credentials(undefined, true)
    const idOfRow = (row: number) => {
      const found = credentials.find(c => c.row === row)

      return found ? b64u(found.credentialId) : ''
    }

    return {
      ...passkey.capability(true),
      base_urls: [...passkey.settings.baseUrls],
      accepted_base_urls: [...ctx.acceptedBaseUrls],
      allow_private_base_urls: passkey.settings.allowPrivateBaseUrls,
      native_rps: passkey.settings.nativeRps,
      user_invites: passkey.settings.userInvites,
      self_enrol: {
        enabled: passkey.settings.selfEnrol.enabled,
        accept_missing_auth_time: passkey.settings.selfEnrol.acceptMissingAuthTime,
        cooling_off_s: passkey.settings.selfEnrol.coolingOffS
      },
      provider_reauth: passkey.settings.providerReauth,
      reauth_script: scriptView(passkey.signInScript),
      grants: passkey.store.grants().map(g => ({
        id: g.id,
        user_id: g.userId,
        provider: g.provider,
        client: g.client,
        state: g.state,
        failure: g.failure,
        auth_time: g.authTime,
        auth_time_assumed: g.authTimeAssumed,
        created_at: g.createdAt,
        expires_at: g.expiresAt,
        completed_at: g.completedAt,
        spent_at: g.spentAt,
        credential_id: g.credentialRow === null ? null : idOfRow(g.credentialRow)
      })),
      credentials: credentials.map(c => ({
        id: b64u(c.credentialId),
        user_id: c.userId,
        rp_id: c.rpId,
        name: c.name,
        active: c.revokedAt === null,
        sign_count: c.signCount,
        backup_eligible: c.backupEligible,
        backed_up: c.backedUp,
        created_via: c.createdVia,
        created_at: c.createdAt,
        last_used_at: c.lastUsedAt,
        revoked_at: c.revokedAt,
        revoked_by: c.revokedBy,
        usable_from: c.usableFrom
      })),
      open_codes: passkey.store.openCodes(),
      receipts: passkey.store.receipts().map(r => ({
        id: r.id,
        at: r.at,
        purpose: r.purpose,
        user_id: r.userId,
        credential_id: idOfRow(r.credentialRow),
        rp_id: r.rpId,
        base_url: r.baseUrl,
        session_id: r.sessionId,
        request_id: r.requestId,
        text_digest: b64u(r.textDigest)
      })),
      refusals: passkey.refusals().map(note => ({
        at: note.at,
        surface: note.surface,
        reason: note.reason,
        user_id: note.userId,
        request_id: note.requestId
      })),
      ...confirmGate.view()
    }
  }

  /** `server_requests.Request.snapshot()`: what a resume re-delivers. */
  function openRequestsFor(
    sessionId: string,
    caller?: WebSocket
  ): { id: string; method: string; params: Record<string, unknown> }[] {
    const runtimeId = resolveRuntimeId(sessionId)

    return (
      [...state.openServerRequests.entries()]
        .filter(([, entry]) => entry.session_id === runtimeId)
        // A gated request is listed only to a connection that could answer it.
        .filter(([, entry]) => !entry.viewer || (caller !== undefined && entry.viewer(caller)))
        .map(([id, entry]) => ({ id, method: entry.method, params: { session_id: runtimeId, ...entry.params } }))
    )
  }

  await new Promise<void>(resolve => {
    httpServer.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve)
  })

  const address = httpServer.address() as AddressInfo
  const host = options.host ?? '127.0.0.1'
  const url = `http://${host}:${address.port}`

  ownUrl = url

  if (options.passkey) {
    enablePasskey(options.passkey === true ? {} : options.passkey)
  }

  if (options.mcp) {
    enableMcp(options.mcp === true ? {} : options.mcp)
  }

  return {
    port: address.port,
    url,
    wsUrl: `ws://${host}:${address.port}${WS_PATH}`,
    state,
    emit(type, emitOptions = {}) {
      publish(type, emitOptions.sessionId, emitOptions.payload)
    },
    requestApproval(params) {
      return requestServerSide('approval', params)
    },
    requestServerSide,
    closeSockets(code, reason = '') {
      for (const socket of sockets) {
        socket.close(code, reason)
      }
    },
    dropSockets() {
      for (const socket of sockets) {
        // No close frame: the client observes 1006.
        socket.terminate()
      }
    },
    setPushRegistrations(registrations, seen = {}) {
      setPushSection(registrations, seen)
    },
    deliverCron(cronOptions = {}) {
      const profile = cronOptions.profile ?? 'researcher'
      const session = sessionForProfile(profile)

      if (!session) {
        throw new Error(`No Bot Chat for profile ${profile}`)
      }

      const job = cronOptions.job ?? 'Morning digest'
      const report = cronOptions.report ?? 'Nothing needs your attention.'

      injectForeignTurn(session, {
        user: `${CRON_BOT_CHAT_HEADER(job)}\n\n${report}`,
        assistant: cronOptions.reply ?? 'Read it — all clear.',
        stream: true,
        ...(cronOptions.failed ? { status: 'error', error: 'the cron run did not complete' } : {})
      })
    },
    deliverBotDm(dmOptions = {}) {
      const profile = dmOptions.profile ?? 'researcher'
      const session = sessionForProfile(profile)

      if (!session) {
        throw new Error(`No Bot Chat for profile ${profile}`)
      }

      const from = dmOptions.from ?? 'Writer'
      const handle = dmOptions.handle ?? 'writer'

      injectForeignTurn(session, {
        user: `Message from 🤖 ${from} (@${handle}): ${dmOptions.body ?? 'the draft is ready.'}`,
        assistant: dmOptions.reply ?? 'Noted — I will fold that in.',
        stream: true
      })
    },
    passkey: () => passkey,
    enablePasskey,
    mcp: () => mcp,
    enableMcp,
    raiseConfirm(confirmOptions) {
      const profile = confirmOptions.profile ?? 'researcher'
      const session = sessionForProfile(profile)

      if (!session) {
        throw new Error(`No Bot Chat for profile ${profile}`)
      }

      if (!confirmGate) {
        throw new Error('This gateway does not know the passkey level: start it with `passkey` or enable it first.')
      }

      return confirmGate.raise({
        sessionId: session.id,
        conversation: session.storedId,
        text: buildText(
          confirmTextInput(session.storedId, {
            title: confirmOptions.title,
            summary: confirmOptions.summary,
            detail: confirmOptions.detail,
            level: confirmOptions.level,
            fields: confirmOptions.fields,
            draft_id: confirmOptions.draftId
          })
        ),
        ...('user' in confirmOptions ? { user: confirmOptions.user ?? null } : {}),
        ...(confirmOptions.timeoutSeconds === undefined ? {} : { timeoutSeconds: confirmOptions.timeoutSeconds }),
        ...(confirmOptions.turnIsolation ? { turnIsolation: true } : {})
      })
    },
    raiseInteractive,
    interactiveLimits,
    raiseApprovalOn(approvalOptions = {}) {
      const profile = approvalOptions.profile ?? 'researcher'
      const session = sessionForProfile(profile)

      if (!session) {
        throw new Error(`No Bot Chat for profile ${profile}`)
      }

      return queueApproval(session, approvalOptions.command ?? 'rm -rf ./build', approvalOptions.queueOnly === true)
    },
    async close() {
      for (const timer of timers) {
        clearTimeout(timer)
      }

      timers.clear()

      for (const socket of sockets) {
        socket.terminate()
      }

      sockets.clear()
      await new Promise<void>(resolve => audioWss.close(() => resolve()))
      await new Promise<void>(resolve => wss.close(() => resolve()))
      await new Promise<void>(resolve => httpServer.close(() => resolve()))
    }
  }
}
