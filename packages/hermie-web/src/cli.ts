#!/usr/bin/env node
/**
 * The command line. Flags beat environment variables beat defaults; everything
 * it can be told is in `options.ts`, and this file only turns `--flags` into
 * that record, prints what it decided, and stops cleanly on a signal.
 */
import { parseArgs } from 'node:util'

import { encodeLocalSecret, hashLocalSecret } from './admin/access'
import { HELP } from './help'
import { describeHost, resolveOptions } from './options'
import { login } from './push/login'
import { rollback } from './update'
import { startHermieWeb } from './server'

/** All of stdin, as text — what `hash-secret` reads the secret from. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []

  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks).toString('utf8')
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    options: {
      gateway: { type: 'string' },
      port: { type: 'string' },
      host: { type: 'string' },
      'public-url': { type: 'string' },
      'web-public-url': { type: 'string' },
      'pass-host': { type: 'boolean', default: false },
      static: { type: 'string' },
      'login-return': { type: 'string' },
      'install-root': { type: 'string' },
      'no-self-update': { type: 'boolean', default: false },
      rollback: { type: 'boolean', default: false },
      push: { type: 'boolean', default: false },
      'gateway-token': { type: 'string' },
      'state-dir': { type: 'string' },
      'cache-max-mb': { type: 'string' },
      'vapid-subject': { type: 'string' },
      'push-server-requests': { type: 'boolean', default: false },
      'push-relays': { type: 'string' },
      'push-ignore-plugin': { type: 'boolean', default: false },
      'allow-insecure-oidc': { type: 'boolean', default: false },
      'no-oidc': { type: 'boolean', default: false },
      admins: { type: 'string' },
      provider: { type: 'string' },
      'redirect-port': { type: 'string' },
      help: { type: 'boolean', default: false }
    },
    allowPositionals: true
  })

  if (values.help) {
    console.warn(HELP)

    return
  }

  /*
    `hermie-web hash-secret`, for `HERMIE_LOCAL_ADMIN_PASSWORD_HASH`.

    Reads the whole of stdin as the secret — a single trailing newline is
    stripped, because that is what `echo` and every editor's "save" add and
    not a character the secret itself is likely to end on — and prints
    `admin/access.ts`'s `encodeLocalSecret` line and nothing else, so it can
    be piped straight into a manifest or a `kubectl create secret`. There is
    no flag for a plaintext password anywhere in this file, on purpose: see
    `HERMIE_LOCAL_ADMIN_PASSWORD_HASH`'s own note.

    Handled BEFORE `resolveOptions` below: this subcommand needs none of the
    gateway/port/state-dir machinery that call validates, and running it
    first means a bad HERMIE_GATEWAY_URL or the like in the calling
    environment cannot stop `hash-secret` from working when all somebody
    wants is a hash to paste into a manifest.
  */
  if (positionals[0] === 'hash-secret') {
    const secret = (await readStdin()).replace(/\r?\n$/, '')

    if (!secret) {
      throw new Error('hash-secret read an empty secret from stdin.')
    }

    console.log(encodeLocalSecret(hashLocalSecret(secret)))

    return
  }

  const options = resolveOptions({
    gatewayUrl: values.gateway,
    port: values.port,
    host: values.host,
    publicUrl: values['public-url'],
    webPublicUrl: values['web-public-url'],
    ...(values['pass-host'] ? { passHost: true } : {}),
    staticDir: values.static,
    loginReturn: values['login-return'],
    installRoot: values['install-root'],
    gatewayToken: values['gateway-token'],
    stateDir: values['state-dir'],
    cacheMaxMb: values['cache-max-mb'],
    vapidSubject: values['vapid-subject'],
    ...(values.push ? { push: true } : {}),
    ...(values['push-server-requests'] ? { pushServerRequests: true } : {}),
    ...(values['push-relays'] !== undefined ? { pushRelays: values['push-relays'] } : {}),
    ...(values['push-ignore-plugin'] ? { pushIgnorePlugin: true } : {}),
    ...(values['allow-insecure-oidc'] ? { allowInsecureOidc: true } : {}),
    ...(values['no-self-update'] ? { selfUpdate: false } : {}),
    ...(values['no-oidc'] ? { oidc: false } : {}),
    ...(values.admins !== undefined ? { admins: values.admins.split(',') } : {})
  })

  // A subcommand, not a flag: it is interactive, it exits when it is done, and
  // it is the one thing here that never starts a server.
  if (positionals[0] === 'login') {
    const port = values['redirect-port'] ? Number.parseInt(values['redirect-port'], 10) : undefined

    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
      throw new Error(`--redirect-port must be a number between 1 and 65535 (got ${values['redirect-port']}).`)
    }

    await login({
      gatewayUrl: options.gatewayUrl,
      stateDir: options.stateDir,
      provider: values.provider,
      ...(port === undefined ? {} : { port })
    })

    return
  }

  if (values.rollback) {
    const version = await rollback(options.installRoot)
    console.warn(`hermie-web: rolled back to ${version}. Restart the service to run it.`)

    return
  }

  const server = await startHermieWeb({
    gatewayUrl: options.gatewayUrl,
    port: options.port,
    host: options.host,
    publicUrl: options.publicUrl,
    webPublicUrl: options.webPublicUrl,
    passHost: options.passHost,
    staticDir: options.staticDir,
    loginReturn: options.loginReturn,
    installRoot: options.installRoot,
    selfUpdate: options.selfUpdate,
    push: options.push,
    gatewayToken: options.gatewayToken,
    stateDir: options.stateDir,
    cacheMaxMb: options.cacheMaxMb,
    vapidSubject: options.vapidSubject,
    pushServerRequests: options.pushServerRequests,
    pushRelays: options.pushRelays,
    pushIgnorePlugin: options.pushIgnorePlugin,
    allowInsecureOidc: options.allowInsecureOidc,
    oidc: options.oidc,
    admins: options.admins,
    localAdminPasswordHash: options.localAdminPasswordHash
  })

  console.warn(`hermie-web ${options.version} on http://${describeHost(options.host)}:${server.port}`)

  // ADR-0025: a process nobody has given a gateway to serves the operator setup
  // page instead of the app, and says so here rather than printing a default
  // address as though it were a decision.
  if (!server.options.gatewayConfigured) {
    console.warn(
      '  gateway    NOT SET — open /setup to choose one, or restart with --gateway <url>' +
        ' (env HERMIE_GATEWAY_URL). Push stays off until it is.'
    )
  }

  console.warn(`  gateway    ${server.options.gatewayUrl}${server.options.gatewayConfigured ? '' : ' (default)'}`)
  console.warn(
    options.passHost
      ? `  public url ${options.webPublicUrl} (sent as Host; the browser’s Origin passes through — --pass-host)`
      : `  public url ${options.publicUrl} (sent as Host, and as this service’s own Origin)`
  )
  console.warn(`  static     ${options.staticDir}`)
  console.warn(
    options.loginReturn
      ? `  login ret  ${options.loginReturn} (the app’s next= on /auth/login)`
      : '  login ret  none (the app sends no next=; the gateway lands on /)'
  )
  console.warn(
    options.cacheMaxMb > 0
      ? `  cache      ${String(options.cacheMaxMb)} MB in ${options.stateDir}`
      : '  cache      off (--cache-max-mb 0)'
  )

  if (options.push) {
    console.warn(`  push       on, state in ${options.stateDir}`)
    console.warn(
      options.pushServerRequests
        ? '             server requests routed here (--push-server-requests)'
        : '             open questions read from resume snapshots and approval.pending'
    )
    console.warn(
      options.pushRelays.length
        ? `             relay ${options.pushRelays.join(', ')} (--push-relays)`
        : '             relay off (--push-relays is empty)'
    )

    if (options.pushIgnorePlugin) {
      console.warn('             delivering everything, whatever the gateway plugin says (--push-ignore-plugin)')
    }
  }

  const stop = () => {
    void server.close().then(() => process.exit(0))
  }

  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

main().catch((error: unknown) => {
  console.error(`hermie-web: ${String(error)}`)
  process.exit(1)
})
