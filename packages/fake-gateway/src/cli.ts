#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { type FakeAuthMode, type McpOptions, type PasskeyOptions, type Scenario, startFakeGateway } from './server'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '9119' },
    auth: { type: 'string', default: 'none' },
    token: { type: 'string' },
    'close-code': { type: 'string' },
    'public-host': { type: 'string' },
    scenario: { type: 'string' },
    'stream-delay': { type: 'string' },
    'history-rows': { type: 'string' },
    'no-plugin': { type: 'boolean', default: false },
    'profile-display-name': { type: 'string' },
    'no-turn-claim': { type: 'boolean', default: false },
    'no-memory-edit': { type: 'boolean', default: false },
    'no-connectors': { type: 'boolean', default: false },
    'no-kanban': { type: 'boolean', default: false },
    'no-push-relay': { type: 'boolean', default: false },
    'no-native-revoke': { type: 'boolean', default: false },
    idp: { type: 'string', default: 'single' },
    'plugin-assets': { type: 'string' },
    'profile-home': { type: 'string', multiple: true },
    'no-web-client': { type: 'boolean', default: false },
    'no-web-push-key': { type: 'boolean', default: false },
    passkey: { type: 'boolean', default: false },
    'passkey-base-url': { type: 'string', multiple: true },
    'passkey-rp': { type: 'string', multiple: true },
    'passkey-allow-private': { type: 'boolean', default: false },
    'no-passkey-invites': { type: 'boolean', default: false },
    'no-passkey-self-enrol': { type: 'boolean', default: false },
    'passkey-cooling-off': { type: 'string' },
    'passkey-no-reauth': { type: 'boolean', default: false },
    'passkey-accept-missing-auth-time': { type: 'boolean', default: false },
    mcp: { type: 'boolean', default: false },
    'mcp-label': { type: 'string' },
    host: { type: 'string', default: '127.0.0.1' },
    help: { type: 'boolean', default: false }
  }
})

if (values.help) {
  console.log(
    [
      'fake-gateway — a stand-in for `hermes serve`',
      '',
      '  --port <n>              listen port (default 9119)',
      '  --host <addr>           bind address (default 127.0.0.1)',
      '  --auth none|token|native|cookie  authentication mode (default none)',
      '  --token <value>         session token for --auth token',
      '  --public-host <host>    enforce the Host/Origin guard against this host',
      '  --close-code <n>        close code used when a WS upgrade fails auth (default 4401)',
      '  --scenario <file.json>  scripted prompt replies',
      '  --stream-delay <ms>     delay between streamed frames (default 2, which is instant)',
      '  --history-rows <n>      extra back-history in front of every Bot Chat, in rows',
      '                          (mixed prose, code and tool calls; for measuring a long list)',
      '  --no-plugin             omit the `hermie-plugin` advert from ui_meta, staging a',
      '                          gateway with no Hermie plugin installed',
      '  --profile-display-name on|forbidden|absent  what the plugin’s display-name route does',
      '                          (default on). `absent` also drops the capability, staging a',
      '                          plugin older than the route; `forbidden` answers 403',
      '  --no-turn-claim         drop the `context.turn_claim` capability and answer 404 on its',
      '                          route, staging a plugin older than turn claims',
      '  --no-memory-edit        drop `memory.edit` from the plugin advert and refuse the memory',
      '                          edit route with 403: memory can be read and not written',
      '  --no-connectors         connectors are off: connectors.list answers available:false',
      '                          and connectors.connect refuses with 4031',
      '  --no-kanban             a gateway without the Kanban plugin: its routes answer 404',
      '  --no-push-relay         drop the `push.relay` capability, staging a notifier that',
      '                          cannot deliver to a relay registration',
      '  --no-native-revoke      drop `native_revoke` from auth_flows and stop serving',
      '                          /auth/native/revoke, staging a gateway older than the route',
      '  --idp single|staged     who signs a native sign-in in (default single: one approve',
      '                          page). staged: the real chain, gateway PKCE cookie -> an',
      '                          identity provider with a password form (tester / hunter2)',
      '                          and a one-time code (246810) -> /auth/callback -> loopback',
      '  --plugin-assets <dir>   serve <dir> as the plugin’s dashboard files at',
      '                          /dashboard-plugins/hermie/<path> (so <dir>/app/index.html is a built',
      '                          web client), with the dashboard route’s own rules: a suffix',
      '                          allow-list, 404 for a directory, no-store, and the sign-in gate',
      '                          (302 to /login?next=…) under --auth cookie',
      '  --profile-home <p=dir>  a profile’s home on this machine, for GET /api/files/images/{name}?profile=<p>',
      '                          (repeatable): <dir>/images/ holds the pictures that profile’s chats attached,',
      '                          served by the real route’s rules (one name with an image suffix, a regular',
      '                          file directly in images/, no link, 25 MB, 404 for everything else)',
      '  --no-web-client         drop `web.client`, the `web` block and `modules.web` from the',
      '                          plugin advert, staging a plugin older than the bundled client',
      '  --no-web-push-key       drop `push.webpush.key` and `webPush` from the advert, staging a',
      '                          plugin that keeps its Web Push key to itself',
      '  --passkey               make the gateway know the confirm level `passkey`: the capability',
      '                          block, the seven /api/auth/passkeys routes and a gated `confirm`.',
      '                          Needs --auth cookie or native: nobody is signed in otherwise. The',
      '                          base URL is the fake’s own address, which is private, so the',
      '                          operator’s opt-in is on',
      '  --passkey-base-url <u>  list a base URL for the level (repeatable; implies --passkey). With',
      '                          it the opt-in for private base URLs is off unless asked for',
      '  --passkey-rp <id=o,..>  a native RP and the clientDataJSON origins allowed for it',
      '                          (repeatable; default confirm.hermie.dev=https://confirm.hermie.dev)',
      '  --passkey-allow-private accept private base URLs (http, loopback, LAN) for the level',
      '  --no-passkey-invites    a person cannot mint their own enrolment code (user_invites off)',
      '  --no-passkey-self-enrol a person cannot add a passkey by signing in again (self_enrol off)',
      '  --passkey-cooling-off <s>  a self-enrolled passkey is listed but unusable for s seconds',
      '  --passkey-no-reauth     the sign-in provider cannot authenticate again (provider_no_reauth)',
      '  --passkey-accept-missing-auth-time  a re-sign-in without an auth_time counts as fresh (assumed)',
      '  --mcp                   serve the MCP page of the app’s Settings: GET /api/auth/mcp and',
      '                          POST /api/auth/mcp/grants/{id}/revoke (mcp.changed follows a revoke),',
      '                          and advertise per_message_author_via. Needs --auth cookie or native.',
      '                          Without it the routes are unknown (404). See contract/gateway/mcp.md',
      '  --mcp-label <name>      the name in the `claude mcp add` command (default hermie-fake)',
      '',
      'Prompts steer the built-in scenario: "approve" raises an approval request,',
      '"delegate" fans out subagent events, anything else streams a reply with a tool call.',
      '',
      'Control endpoints (not part of the gateway contract):',
      '  POST /__fake/inject  {profile, user, assistant, author?, session_id?}  inject a turn',
      '                       somebody else ran; author {id, name?, via?: {kind, client}} stages',
      '                       the HERM-83 gateway stamp (display_metadata.author; via = an agent',
      '                       sent it for that person) for testing sender attribution;',
      '                       replayed_by {id, name?, via?} stages the retry presser;',
      '                       session_id (stored or runtime id) targets one exact conversation',
      "                       instead of the profile's canonical Bot Chat — a sub-chat, once one exists",
      '  POST /__fake/request {profile, method, params}   raise a server→client request,',
      '                                                   e.g. method "clarify", "secret", "sudo",',
      '                                                   "vault.code", "confirm" (a confirm needs a',
      '                                                   client that offered params.level in',
      '                                                   client.capabilities; 409 otherwise)',
      '                                                   An interactive request ("input.form",',
      '                                                   "input.file", "review.draft", "review.diff",',
      '                                                   "input.signature", "device.location",',
      '                                                   "device.contact", "device.calendar",',
      '                                                   "device.scan") needs a client',
      '                                                   that advertised it (params.requests; 409',
      '                                                   no_capable_client otherwise); params default',
      '                                                   to contract/requests/examples.json',
      '  GET  /__fake/request/<id>            what became of an interactive request: {open, answer?,',
      '                                       refusals, outcome?}; POST .../expire ends it now',
      '                                       (request.cancel timeout)',
      "  POST /__fake/request-limits {enabled?, reset?}  the gateway's limits on interactive requests",
      '                                       (one open, 12 per ten minutes, 6 device.*): off by default',
      '  GET  /__fake/files                   what the upload route received: path, size, sha256',
      '  GET  /__fake/files/content?path=<p>  the raw bytes received at that path (404 when none)',
      '  POST /__fake/withdraw-requests {reason?}  withdraw every open server→client request',
      '                                       (request.cancel to the sockets)',
      '  GET  /__fake/state                   counters and logs: connections, open sockets,',
      '                                       tickets, refreshes, replays, the method log and',
      '                                       the answers given to server requests, and',
      '                                       the sessions with a turn still streaming',
      '  POST /__fake/drop-sockets {code?, reason?}  close every live socket; without a code',
      '                                       abruptly (the client sees 1006)',
      '  POST /__fake/reject-upgrades {count}  fail the next count upgrades with --close-code',
      '  POST /__fake/truncate-next-replay    the next session.events.since answers truncated: true',
      '  POST /__fake/session-owned           {profile?, session_id?, details?, owned?} a chat another window has open: prompt.submit answers 4090 SESSION_NOT_OWNED',
      '  POST /__fake/expire-sessions         end every cookie session (--auth cookie): the next',
      '                                       request with one of those cookies is an expired session',
      '',
      'Passkey level (control, once the gateway knows it; see packages/fake-gateway/README.md):',
      '  POST /__fake/request {method: "confirm", params: {level: "passkey"|"plain", title?, summary,',
      '                        detail?}, user?, timeout_seconds?, turn_isolation?}  raise a gated',
      '                        confirm; 409 {outcome, reason} when nothing was sent. `user` is',
      '                        <provider>:<id>, an account’s user id or username, or null for a turn',
      '                        nobody signed in submitted',
      '  POST /__fake/passkey/enable {enabled?, base_urls?, rps?, allow_private?, user_invites?,',
      '                               self_enrol?: {enabled?, accept_missing_auth_time?, cooling_off_s?},',
      '                               provider_reauth?}',
      '                                       know the level, or change its operator settings',
      '  POST /__fake/passkey/code {user?, ttl?}    mint an operator enrolment code',
      '  POST /__fake/passkey/revoke {credential_id | user + all, announce?}  the operator’s revoke',
      '  POST /__fake/passkey/expire {request_id?, pending?, codes?, grants?, window?}  time passing: time a',
      '                                       confirm out, end registrations / codes / re-authentication grants /',
      '                                       the no-downgrade window',
      '  POST /__fake/passkey/reauth {fail?, auth_time?, user?, provider?, sticky?}  what the next simulated',
      '                                       re-authentication reports; fail is provider_mismatch, user_mismatch,',
      '                                       auth_time_missing or auth_not_fresh; {} goes back to a fresh sign-in',
      '  POST /__fake/passkey/changed {user?, change?, credential?}  emit passkey.changed',
      '  GET  /__fake/state                   gains `passkey`: credentials, receipts, refusals, open',
      '                                       requests, outcomes and the no-downgrade windows',
      '',
      'MCP page (control, with --mcp; see packages/fake-gateway/README.md):',
      '  GET  /__fake/mcp/grants              every grant, revoked ones too, with user_id, revoked_at, revoked_by',
      '  POST /__fake/mcp/grants {user?, client_name?, client_id?, scopes?, created_at?, created_ip?,',
      '                          created_user_agent?, last_used_at?, last_used_ip?, expires_at?, announce?}',
      '                                       seed a grant, as a consent would; mcp.changed (granted) follows',
      '                                       unless announce is false. 409 without --mcp'
    ].join('\n')
  )
  process.exit(0)
}

const auth = values.auth as FakeAuthMode

if (!['none', 'token', 'native', 'cookie'].includes(auth)) {
  console.error(`--auth must be none, token, native or cookie (got ${values.auth}).`)
  process.exit(1)
}

const displayName = values['profile-display-name'] as 'on' | 'forbidden' | 'absent' | undefined

if (displayName && !['on', 'forbidden', 'absent'].includes(displayName)) {
  console.error(`--profile-display-name must be on, forbidden or absent (got ${displayName}).`)
  process.exit(1)
}

let scenario: Scenario | undefined

if (values.scenario) {
  scenario = JSON.parse(readFileSync(values.scenario, 'utf8')) as Scenario
}

const profileHomes: Record<string, string> = {}

for (const entry of values['profile-home'] ?? []) {
  const at = entry.indexOf('=')

  if (at < 1 || at === entry.length - 1) {
    console.error(`--profile-home is <profile>=<directory> (got ${entry}).`)
    process.exit(1)
  }

  profileHomes[entry.slice(0, at)] = entry.slice(at + 1)
}

const passkeyUrls = values['passkey-base-url'] ?? []
const passkeyRps = values['passkey-rp'] ?? []
const coolingOff = values['passkey-cooling-off']

if (coolingOff !== undefined && !/^\d+$/u.test(coolingOff)) {
  console.error('--passkey-cooling-off is a whole number of seconds.')
  process.exit(1)
}

const selfEnrol = {
  ...(values['no-passkey-self-enrol'] ? { enabled: false } : {}),
  ...(values['passkey-accept-missing-auth-time'] ? { acceptMissingAuthTime: true } : {}),
  ...(coolingOff === undefined ? {} : { coolingOffS: Number(coolingOff) })
}
const passkey: PasskeyOptions | false =
  values.passkey ||
  passkeyUrls.length ||
  passkeyRps.length ||
  values['passkey-allow-private'] ||
  Object.keys(selfEnrol).length ||
  values['passkey-no-reauth']
    ? {
        ...(passkeyUrls.length ? { baseUrls: passkeyUrls } : {}),
        ...(passkeyRps.length
          ? {
              nativeRps: Object.fromEntries(
                passkeyRps.map(entry => {
                  const [rpId = '', origins = ''] = entry.split('=')

                  return [rpId, origins.split(',').filter(Boolean)]
                })
              )
            }
          : {}),
        ...(values['passkey-allow-private'] ? { allowPrivateBaseUrls: true } : {}),
        ...(values['no-passkey-invites'] ? { userInvites: false } : {}),
        ...(Object.keys(selfEnrol).length ? { selfEnrol } : {}),
        ...(values['passkey-no-reauth'] ? { providerReauth: false } : {})
      }
    : false

if (!['single', 'staged'].includes(values.idp ?? 'single')) {
  console.error('--idp is single or staged.')
  process.exit(1)
}

if (values.idp === 'staged' && auth !== 'native') {
  console.error('--idp staged needs --auth native: it stages the native sign-in.')
  process.exit(1)
}

if (passkey && !['cookie', 'native'].includes(auth)) {
  console.error('--passkey needs --auth cookie or native: with none or token nobody is signed in.')
  process.exit(1)
}

const mcp: McpOptions | false =
  values.mcp || values['mcp-label'] ? { ...(values['mcp-label'] ? { label: values['mcp-label'] } : {}) } : false

if (mcp && !['cookie', 'native'].includes(auth)) {
  console.error('--mcp needs --auth cookie or native: with none or token nobody is signed in.')
  process.exit(1)
}

const gateway = await startFakeGateway({
  port: Number.parseInt(values.port ?? '9119', 10),
  host: values.host ?? '127.0.0.1',
  auth,
  ...(values.token ? { token: values.token } : {}),
  ...(values['close-code'] ? { closeCode: Number.parseInt(values['close-code'], 10) } : {}),
  ...(values['public-host'] ? { publicHost: values['public-host'] } : {}),
  ...(values['stream-delay'] ? { streamDelayMs: Number.parseInt(values['stream-delay'], 10) } : {}),
  ...(values['history-rows'] ? { historyRows: Number.parseInt(values['history-rows'], 10) } : {}),
  ...(scenario ? { scenario } : {}),
  ...(values['no-plugin'] ? { plugin: false as const } : {}),
  ...(displayName ? { profileDisplayName: displayName } : {}),
  ...(values['no-turn-claim'] ? { turnClaim: false as const } : {}),
  ...(values['no-memory-edit'] ? { memoryEdit: false as const } : {}),
  ...(values['no-connectors'] ? { connectors: false as const } : {}),
  ...(values['no-kanban'] ? { kanban: false as const } : {}),
  ...(values['no-push-relay'] ? { pushRelay: false as const } : {}),
  ...(values['no-native-revoke'] ? { nativeRevoke: false as const } : {}),
  ...(values.idp === 'staged' ? { idp: 'staged' as const } : {}),
  ...(values['plugin-assets'] ? { pluginAssets: values['plugin-assets'] } : {}),
  ...(Object.keys(profileHomes).length ? { profileHomes } : {}),
  ...(values['no-web-client'] ? { webClient: false as const } : {}),
  ...(values['no-web-push-key'] ? { webPushKey: false as const } : {}),
  ...(passkey ? { passkey } : {}),
  ...(mcp ? { mcp } : {})
})

console.log(`fake gateway listening on ${gateway.url} (auth: ${auth})`)
console.log(`  status     ${gateway.url}/api/status`)
console.log(`  websocket  ${gateway.wsUrl}`)
if (values['plugin-assets']) {
  console.log(`  client     ${gateway.url}/dashboard-plugins/hermie/app/index.html`)
}

if (passkey) {
  const view = gateway.passkey()

  console.log(`  passkey    on; base URLs ${view?.settings.baseUrls.join(', ') || '(none)'}`)
}

if (mcp) {
  console.log(`  mcp        on; ${gateway.mcp()?.settings.endpointUrl} (seed: POST ${gateway.url}/__fake/mcp/grants)`)
}

console.log(`  inject     curl -XPOST ${gateway.url}/__fake/inject -d '{"profile":"researcher"}'`)

if (auth === 'token') {
  console.log(`  token      ${gateway.state.token}`)
}

if (auth === 'cookie') {
  console.log('  sign in    tester / hunter2 (POST /auth/password-login)')
}

const shutdown = () => {
  void gateway.close().then(() => process.exit(0))
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
