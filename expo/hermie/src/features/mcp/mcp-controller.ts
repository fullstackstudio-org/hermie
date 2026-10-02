/**
 * The MCP servers page's round trips.
 *
 * Four gateway calls with four different ideas of what "is this server working"
 * means, and the page is only honest if it keeps them apart:
 *
 *  - `mcp.servers.list` is the CONFIG. It says what is defined and whether it
 *    is switched on. It knows nothing about whether it works.
 *  - `mcp.servers.status` is CACHED runtime state. Upstream's docstring is
 *    explicit that it never connects, probes or starts auth — so a server that
 *    needs authorising looks exactly like one that is fine.
 *  - `mcp.servers.test` is the only call that finds out, by connecting. It is
 *    also the only one that can say `oauth_needed`, which is why "needs auth"
 *    is a probe result here and never a list badge.
 *  - `reload.mcp` applies config changes to live chats, and may refuse by
 *    ANSWERING — see {@link McpController.reload}.
 *
 * A probe is never run on the reader's behalf. `test` connects, and a cold
 * `npx` server takes seconds; probing three of them on every visit would make
 * the page feel broken. So the list paints from `list` + `status`, and a probe
 * is a button.
 */
import type {
  McpOauthStartResult,
  McpServerRuntimeRow,
  McpServerSummary,
  McpServersTestResult,
  ReloadMcpResult
} from '@hermes/shared/gateway-contract'

import type { ChatGateway } from '../../gateway/link'

/** How often `oauth.poll` is asked, matching the desktop's own driver. */
export const OAUTH_POLL_INTERVAL_MS = 1_000

/** The desktop gives a flow six minutes before it gives up; so does this. */
export const OAUTH_TIMEOUT_MS = 360_000

/**
 * What the page draws for one server: the config row, the cached runtime row,
 * and whatever the last probe found.
 */
export interface McpServerView {
  name: string
  transport: string
  /** `url` for http servers, the command line for stdio ones. */
  address: string
  /** Env KEY NAMES the server needs. Never values — the gateway does not send them. */
  env: readonly string[]
  auth: string | null
  enabled: boolean
  /** From `status`: cached, cheap, and blind to authorisation. */
  runtime: McpRuntimeState
  toolCount: number
}

export type McpRuntimeState = 'connected' | 'disabled' | 'connecting' | 'failed' | 'lazy' | 'configured' | 'unknown'

/**
 * A probe's outcome, flattened into the three things the page says.
 *
 * `ok: false` with `needsAuth: true` is its own state rather than a failure
 * with a hint, because it is the only one with a button attached.
 */
export interface McpProbe {
  ok: boolean
  needsAuth: boolean
  error: string | null
  tools: readonly { name: string; description: string }[]
}

const addressOf = (server: McpServerSummary): string =>
  server.url ?? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')

/**
 * Join the config list with the cached runtime rows.
 *
 * Exported for its own test: the join is by NAME and a server present in one
 * and not the other is real. A server defined but never started has no runtime
 * row at all (`unknown`), and reading that as "failed" would put a red dot on
 * every lazily-started server on a freshly booted gateway.
 */
export const mergeServers = (
  servers: readonly McpServerSummary[],
  runtime: readonly McpServerRuntimeRow[]
): McpServerView[] =>
  servers.map(server => {
    const row = runtime.find(entry => entry.name === server.name)

    return {
      name: server.name,
      transport: server.transport,
      address: addressOf(server),
      env: server.env ?? [],
      auth: server.auth ?? null,
      enabled: server.enabled,
      runtime: (row?.status as McpRuntimeState | undefined) ?? 'unknown',
      toolCount: row?.tools ?? 0
    }
  })

export interface McpControllerOptions {
  gateway: ChatGateway
  /** Hands `auth_url` to the system browser. Injected so a test can watch it. */
  openUrl: (url: string) => void | Promise<void>
  /** Overridable for tests; real code leaves it alone. */
  wait?: (ms: number) => Promise<void>
  now?: () => number
}

export class McpController {
  private readonly wait: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly options: McpControllerOptions) {
    this.wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.now = options.now ?? Date.now
  }

  /**
   * The list, as one paint.
   *
   * `status` is allowed to fail on its own: upstream only includes runtime rows
   * when the scoped profile is the launch profile or a multiplexer is active,
   * and an older gateway may not have the method at all. Losing the dots is
   * survivable; losing the list is not.
   */
  async load(profile?: string | null): Promise<McpServerView[]> {
    const scope = profile ? { profile } : {}
    const servers = await this.options.gateway.request('mcp.servers.list', scope)
    const runtime = await this.options.gateway
      .request('mcp.servers.status', scope)
      .then(result => result.servers ?? [])
      .catch(() => [] as McpServerRuntimeRow[])

    return mergeServers(servers.servers ?? [], runtime)
  }

  /**
   * Probe one server.
   *
   * The result is a SUCCESSFUL RPC whichever way it goes, so everything here
   * reads `result.ok` rather than relying on a throw. A client that trusted the
   * absence of an error frame would report every broken server as working.
   */
  async test(name: string, profile?: string | null): Promise<McpProbe> {
    const result: McpServersTestResult = await this.options.gateway.request('mcp.servers.test', {
      name,
      ...(profile ? { profile } : {})
    })

    return {
      ok: result.ok,
      // `oauth_needed` is also true on a server that IS authorised, so the
      // needs-auth state is the pair: wanted, and not satisfied.
      needsAuth: Boolean(result.oauth_needed) && result.oauth_tokens_present !== true,
      error: result.ok ? null : (result.error ?? 'The probe failed without saying why.'),
      tools: result.tools ?? []
    }
  }

  /**
   * Walk a PKCE flow: start, open the URL, poll until it settles.
   *
   * `client_redirect_uri` is deliberately NOT sent. It exists so a client that
   * can host a loopback listener takes the redirect itself — which is what the
   * desktop does from Electron's main process. This app has no loopback to
   * offer, so the gateway keeps its own and the flow works the ordinary way.
   * Sending the parameter without a listener behind it would break the flow.
   */
  async authorise(name: string, profile?: string | null): Promise<McpProbe> {
    const scope = profile ? { profile } : {}
    const started: McpOauthStartResult = await this.options.gateway.request('mcp.servers.oauth.start', {
      name,
      ...scope
    })

    if (!started.auth_url || !started.session_id) {
      throw new Error('The gateway started an authorisation but did not say where to send you.')
    }

    await this.options.openUrl(started.auth_url)

    const deadline = this.now() + OAUTH_TIMEOUT_MS

    try {
      for (;;) {
        const polled = await this.options.gateway.request('mcp.servers.oauth.poll', {
          name,
          session_id: started.session_id,
          ...scope
        })

        if (polled.status === 'approved') {
          return { ok: true, needsAuth: false, error: null, tools: polled.tools ?? [] }
        }

        if (polled.status === 'error') {
          throw new Error(polled.error_message ?? 'Authorisation was refused.')
        }

        if (this.now() >= deadline) {
          throw new Error('Timed out waiting for the authorisation to finish.')
        }

        await this.wait(OAUTH_POLL_INTERVAL_MS)
      }
    } catch (error) {
      /*
        Always tell the gateway the flow is over. An abandoned PKCE flow holds a
        verifier and a listener on the gateway side, and the reader who gave up
        is exactly the one who will try again in a minute.
      */
      await this.options.gateway
        .request('mcp.servers.oauth.cancel', { name, session_id: started.session_id, ...scope })
        .catch(() => undefined)

      throw error
    }
  }

  /**
   * Ask the gateway to reload its MCP servers.
   *
   * This is the call that can refuse by succeeding. Without `confirm` the
   * gateway may answer `{status: 'confirm_required', message}` with no error
   * frame at all, and the caller is expected to ask and come back. The desktop
   * app sidesteps the whole thing by always sending `confirm: true`; Hermie
   * asks, because the thing being confirmed — every live chat re-sending its
   * full input on its next message — is something the reader is paying for.
   *
   * `always` proceeds and clears the approval in the GATEWAY's config, so it is
   * shared with the CLI and the desktop. It is not a local preference and must
   * not be remembered as one.
   */
  async reload(
    options: { confirm?: boolean; always?: boolean; sessionId?: string | null } = {}
  ): Promise<{ status: 'confirm_required'; message: string } | { status: 'reloaded' }> {
    const result: ReloadMcpResult = await this.options.gateway.request('reload.mcp', {
      ...(options.confirm ? { confirm: true } : {}),
      ...(options.always ? { always: true } : {}),
      ...(options.sessionId ? { session_id: options.sessionId } : {})
    })

    if (result.status === 'confirm_required') {
      return {
        status: 'confirm_required',
        message: result.message ?? 'Reloading MCP servers will invalidate the prompt cache.'
      }
    }

    return { status: 'reloaded' }
  }
}
