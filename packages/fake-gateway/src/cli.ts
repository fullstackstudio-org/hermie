#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

import { type FakeAuthMode, type Scenario, startFakeGateway } from './server'

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
    'no-push-relay': { type: 'boolean', default: false },
    'no-native-revoke': { type: 'boolean', default: false },
    'plugin-assets': { type: 'string' },
    'no-web-client': { type: 'boolean', default: false },
    'no-web-push-key': { type: 'boolean', default: false },
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
      '  --no-push-relay         drop the `push.relay` capability, staging a notifier that',
      '                          cannot deliver to a relay registration',
      '  --no-native-revoke      drop `native_revoke` from auth_flows and stop serving',
      '                          /auth/native/revoke, staging a gateway older than the route',
      '  --plugin-assets <dir>   serve <dir> as the plugin’s dashboard files at',
      '                          /dashboard-plugins/hermie/<path> (so <dir>/app/index.html is a built',
      '                          web client), with the dashboard route’s own rules: a suffix',
      '                          allow-list, 404 for a directory, no-store, and the sign-in gate',
      '                          (302 to /login?next=…) under --auth cookie',
      '  --no-web-client         drop `web.client`, the `web` block and `modules.web` from the',
      '                          plugin advert, staging a plugin older than the bundled client',
      '  --no-web-push-key       drop `push.webpush.key` and `webPush` from the advert, staging a',
      '                          plugin that keeps its Web Push key to itself',
      '',
      'Prompts steer the built-in scenario: "approve" raises an approval request,',
      '"delegate" fans out subagent events, anything else streams a reply with a tool call.',
      '',
      'Control endpoints (not part of the gateway contract):',
      '  POST /__fake/inject  {profile, user, assistant, author?, session_id?}  inject a turn',
      '                       somebody else ran; author {id, name?} stages the HERM-83 gateway',
      '                       stamp (display_metadata.author) for testing sender attribution;',
      '                       session_id (stored or runtime id) targets one exact conversation',
      "                       instead of the profile's canonical Bot Chat — a sub-chat, once one exists",
      '  POST /__fake/request {profile, method, params}   raise a server→client request,',
      '                                                   e.g. method "clarify", "secret", "sudo",',
      '                                                   "vault.code", "confirm" (a confirm needs a',
      '                                                   client that offered params.level in',
      '                                                   client.capabilities; 409 otherwise)',
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
      '  POST /__fake/expire-sessions         end every cookie session (--auth cookie): the next',
      '                                       request with one of those cookies is an expired session'
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
  ...(values['no-push-relay'] ? { pushRelay: false as const } : {}),
  ...(values['no-native-revoke'] ? { nativeRevoke: false as const } : {}),
  ...(values['plugin-assets'] ? { pluginAssets: values['plugin-assets'] } : {}),
  ...(values['no-web-client'] ? { webClient: false as const } : {}),
  ...(values['no-web-push-key'] ? { webPushKey: false as const } : {})
})

console.log(`fake gateway listening on ${gateway.url} (auth: ${auth})`)
console.log(`  status     ${gateway.url}/api/status`)
console.log(`  websocket  ${gateway.wsUrl}`)
if (values['plugin-assets']) {
  console.log(`  client     ${gateway.url}/dashboard-plugins/hermie/app/index.html`)
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
