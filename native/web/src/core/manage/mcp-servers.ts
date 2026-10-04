/**
 * The MCP servers a bot's gateway has configured, and the calls the page makes on them (the Expo app's
 * `features/mcp/mcp-controller.ts`, which this follows, plus adding and removing a server).
 *
 * Not the gateway's own MCP endpoint that Hermie's agents connect to (`core/mcp`, Settings › MCP): these are the
 * servers a bot reaches its tools through. Five calls with five different ideas of what "is this server working"
 * means, and the page is only honest if it keeps them apart:
 *
 *  - `mcp.servers.list` is the CONFIG: what is defined and whether it is switched on. It knows nothing about
 *    whether it works.
 *  - `mcp.servers.status` is CACHED runtime state. It never connects, probes or starts auth, so a server that
 *    needs authorising looks exactly like one that is fine.
 *  - `mcp.servers.test` is the only call that finds out, by connecting. It is also the only one that can say
 *    `oauth_needed`, which is why "needs authorising" is a probe result and never a list badge. A cold `npx`
 *    server takes seconds, so no probe is run on the reader's behalf: it is a button.
 *  - `mcp.servers.oauth.*` walks a PKCE flow: start, the reader opens the address, poll until it settles.
 *  - `reload.mcp` applies configuration changes to chats that are already running, and may refuse BY ANSWERING
 *    (`confirm_required`): every live chat re-sends its full input on its next message, which the reader pays
 *    for, so the page asks.
 *
 * What the gateway does not send, the page does not show: an env key's VALUE, a token. Every string in an answer
 * is the gateway's or the server's text and is drawn as characters.
 */
import type { McpCatalogEntry, McpServerRuntimeRow, McpServerSummary } from '@hermes/shared/gateway-contract'

import { reloadAnswer, reloadMcpParams, type ReloadAnswer } from '../bot-profile/params'
import type { ManageTransport } from './transport'

/** How often `oauth.poll` is asked, as the desktop's own driver does. */
export const OAUTH_POLL_INTERVAL_MS = 1_000

/** A flow is given six minutes before it is given up, as the desktop does. */
export const OAUTH_TIMEOUT_MS = 360_000

export type McpRuntimeState = 'connected' | 'disabled' | 'connecting' | 'failed' | 'lazy' | 'configured' | 'unknown'

const RUNTIME_STATES: readonly string[] = ['connected', 'disabled', 'connecting', 'failed', 'lazy', 'configured']

/** What the page draws for one server: the config row joined with the cached runtime row. */
export interface McpServerView {
  name: string
  transport: string
  /** `url` for an http server, the command line for a stdio one. */
  address: string
  /** Env KEY NAMES the server expects. Never values: the gateway does not send them. */
  env: readonly string[]
  auth: string | null
  /** Whether a token is on disk, for an OAuth server; `null` when that does not apply. */
  tokenPresent: boolean | null
  enabled: boolean
  /** From `status`: cached, cheap, and blind to authorisation. */
  runtime: McpRuntimeState
  toolCount: number | null
}

/** A probe's outcome, flattened into the three things the page says. */
export interface McpProbe {
  ok: boolean
  /** Wanted and not satisfied: `oauth_needed` is also true on a server that IS authorised. */
  needsAuth: boolean
  error: string | null
  tools: readonly { name: string; description: string }[]
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

const addressOf = (server: McpServerSummary): string =>
  text(server.url) || [server.command, ...(Array.isArray(server.args) ? server.args : [])].filter(Boolean).join(' ')

/**
 * Join the config list with the cached runtime rows, by name. A server defined but never started has no runtime
 * row at all (`unknown`), and reading that as "failed" would put a red mark on every lazily-started server of a
 * freshly booted gateway.
 */
export function mergeServers(
  servers: readonly McpServerSummary[],
  runtime: readonly McpServerRuntimeRow[]
): McpServerView[] {
  return servers
    .filter(server => text(server.name) !== '')
    .map(server => {
      const row = runtime.find(entry => entry.name === server.name)
      const status = row?.status as string | undefined

      return {
        name: server.name,
        transport: text(server.transport) || 'stdio',
        address: addressOf(server),
        env: Array.isArray(server.env) ? server.env.filter((key): key is string => typeof key === 'string') : [],
        auth: text(server.auth) || null,
        tokenPresent: typeof server.oauth_tokens_present === 'boolean' ? server.oauth_tokens_present : null,
        enabled: server.enabled !== false,
        runtime: status && RUNTIME_STATES.includes(status) ? (status as McpRuntimeState) : 'unknown',
        toolCount: typeof row?.tools === 'number' ? row.tools : null
      }
    })
}

/** What the add form sends: a preset of the catalogue, or a server of the reader's own description. */
export type NewServer =
  | { kind: 'preset'; name: string; preset: string }
  | {
      kind: 'custom'
      name: string
      /** `url` makes an http server; otherwise `command` starts a stdio one. */
      url?: string
      command?: string
      args?: readonly string[]
      /** Written to the profile's `.env` by the gateway; only the key's name comes back. */
      bearerToken?: string
    }

export interface CatalogueEntry {
  name: string
  description: string
  installed: boolean
  /** The env keys it needs. */
  requires: string[]
  transport: string
}

export const catalogueOf = (entries: readonly McpCatalogEntry[] | undefined): CatalogueEntry[] =>
  (Array.isArray(entries) ? entries : [])
    .filter(entry => text(entry.name) !== '')
    .map(entry => ({
      name: entry.name,
      description: text(entry.description),
      installed: entry.installed === true,
      requires: Array.isArray(entry.requires) ? entry.requires.filter((key: unknown) => typeof key === 'string') : [],
      transport: text(entry.transport)
    }))

/**
 * An address the page will hand to the reader to open: `http` and `https` only. What the gateway sends is not
 * trusted to be a web address, and a `javascript:` or `data:` URL in a link is a script.
 */
export function openableUrl(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }

  try {
    const url = new URL(value)

    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/** The flow under way: where the reader goes, and the way to end it. */
export interface OauthFlow {
  authUrl: string
  /** Resolves when the flow settles; rejects with the gateway's reason, or on a timeout or a cancel. */
  done: Promise<McpProbe>
  /** Tell the gateway the flow is over (it holds a verifier and a listener) and stop polling. */
  cancel: () => void
}

export class OauthCancelled extends Error {
  constructor() {
    super('cancelled')
    this.name = 'OauthCancelled'
  }
}

export interface McpServersClient {
  load(profile: string): Promise<McpServerView[]>
  catalogue(profile: string): Promise<CatalogueEntry[]>
  test(name: string, profile: string): Promise<McpProbe>
  /** Start a PKCE flow; the page shows `authUrl` for the reader to open and waits on `done`. */
  authorise(name: string, profile: string): Promise<OauthFlow>
  add(profile: string, server: NewServer): Promise<void>
  remove(profile: string, name: string): Promise<boolean>
  reload(options?: { confirm?: boolean; always?: boolean }): Promise<ReloadAnswer>
}

export interface McpServersClientOptions {
  /** For a test; real code leaves them alone. */
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export function createMcpServersClient(
  gateway: ManageTransport['gateway'],
  options: McpServersClientOptions = {}
): McpServersClient {
  const wait = options.wait ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const now = options.now ?? Date.now

  return {
    async load(profile) {
      const listed = await gateway.request('mcp.servers.list', { profile })
      // `status` may fail on its own (an older gateway may not have it): losing the marks is survivable, losing
      // the list is not.
      const runtime = await gateway
        .request('mcp.servers.status', { profile })
        .then(result => (Array.isArray(result.servers) ? result.servers : []))
        .catch(() => [] as McpServerRuntimeRow[])

      return mergeServers(Array.isArray(listed.servers) ? listed.servers : [], runtime)
    },

    async catalogue(profile) {
      return catalogueOf((await gateway.request('mcp.catalog', { profile })).servers)
    },

    async test(name, profile) {
      // The answer is a SUCCESSFUL call whichever way the probe goes: `ok` is what says, not the absence of an
      // error frame.
      const result = await gateway.request('mcp.servers.test', { name, profile })

      return {
        ok: result.ok === true,
        needsAuth: result.oauth_needed === true && result.oauth_tokens_present !== true,
        error: result.ok === true ? null : text(result.error) || null,
        tools: (Array.isArray(result.tools) ? result.tools : []).map(tool => ({
          name: text(tool.name),
          description: text(tool.description)
        }))
      }
    },

    async authorise(name, profile) {
      // `client_redirect_uri` is NOT sent: it is for a client that can host a loopback listener, which a page
      // cannot, and sending it without one behind it would break the flow.
      const started = await gateway.request('mcp.servers.oauth.start', { name, profile })
      const authUrl = openableUrl(started.auth_url)

      if (!authUrl || !started.session_id) {
        throw new Error('The gateway started an authorisation but did not say where to send you.')
      }

      let cancelled = false
      const flow = { name, session_id: started.session_id, profile }
      const finish = (): Promise<unknown> => gateway.request('mcp.servers.oauth.cancel', flow).catch(() => undefined)

      const done = (async (): Promise<McpProbe> => {
        const deadline = now() + OAUTH_TIMEOUT_MS

        try {
          for (;;) {
            if (cancelled) {
              throw new OauthCancelled()
            }

            const polled = await gateway.request('mcp.servers.oauth.poll', flow)

            if (cancelled) {
              throw new OauthCancelled()
            }

            if (polled.status === 'approved') {
              return {
                ok: true,
                needsAuth: false,
                error: null,
                tools: (polled.tools ?? []).map(tool => ({
                  name: text(tool.name),
                  description: text(tool.description)
                }))
              }
            }

            if (polled.status === 'error') {
              throw new Error(text(polled.error_message) || 'Authorisation was refused.')
            }

            if (now() >= deadline) {
              throw new Error('Timed out waiting for the authorisation to finish.')
            }

            await wait(OAUTH_POLL_INTERVAL_MS)
          }
        } catch (failure) {
          // Always tell the gateway the flow is over: an abandoned one holds a verifier and a listener, and the
          // reader who gave up is the one who will try again in a minute.
          if (!(failure instanceof OauthCancelled)) {
            await finish()
          }

          throw failure
        }
      })()

      return {
        authUrl,
        done,
        cancel: () => {
          cancelled = true
          void finish()
        }
      }
    },

    async add(profile, server) {
      await gateway.request('mcp.servers.add', {
        profile,
        name: server.name,
        ...(server.kind === 'preset'
          ? { preset: server.preset }
          : {
              config: {
                ...(server.url
                  ? { url: server.url }
                  : { command: server.command ?? '', args: [...(server.args ?? [])] })
              },
              ...(server.bearerToken ? { bearer_token: server.bearerToken } : {})
            })
      })
    },

    async remove(profile, name) {
      return (await gateway.request('mcp.servers.remove', { profile, name })).removed === true
    },

    async reload(reloadOptions = {}) {
      return reloadAnswer(await gateway.request('reload.mcp', reloadMcpParams(reloadOptions)))
    }
  }
}
