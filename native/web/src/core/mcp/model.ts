/**
 * The MCP model: reads what the gateway says about its MCP endpoint and the
 * clients connected to it, revokes one, and keeps the page's copy fresh
 * (`contract/gateway/mcp.md`, sections 4 and 6).
 *
 * It is idle until the page is open. `watch()` is what the page calls on mount: it
 * reads at once and, until it is let go, reads again on `mcp.changed` and when the
 * tab comes back to the foreground (a revoke on the operator's side may send no
 * frame at all). Nothing is requested while no page is watching, so a gateway
 * without MCP is never asked about it by a person who does not open the page.
 *
 * `mcp.changed` is a hint to reload, not the state: the page re-reads
 * `GET /api/auth/mcp`. A change this page made itself (its own revoke) is no news
 * and says nothing; a change somebody else made is kept in the store, so the page
 * can say it.
 *
 * Only the newest read is applied, so a slow answer can never put an older list
 * over a newer one.
 */
import type { ChatGateway } from '../link'
import type { VisibilityWatcher } from '../../platform/visibility'
import { type McpProblem, type McpState, mcpStore } from '../../state/mcp'
import type { StoreApi } from 'zustand/vanilla'
import { type McpClient, McpRouteError } from './client'

/** The slice of the connection the model uses. */
export type McpGateway = Pick<ChatGateway, 'onAny'>

export interface McpModelOptions {
  gateway: McpGateway
  client: McpClient
  /** The gateway as this page addresses it (its host): what a refusal for an unlisted address names. */
  host?: string
  /** Where the tab's visibility is heard; without one the page is never told it came back. */
  visibility?: Pick<VisibilityWatcher, 'subscribe'>
  store?: StoreApi<McpState>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Why a failed call is what the page shows. */
export function problemOf(error: unknown): McpProblem {
  if (error instanceof McpRouteError) {
    if (error.kind === 'not_offered') {
      return { kind: 'not_offered' }
    }

    if (error.kind === 'no_identity') {
      return { kind: 'sign_in' }
    }
  }

  return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
}

export class McpModel {
  readonly store: StoreApi<McpState>
  /** The host this page reaches the gateway at. */
  readonly host: string

  private readonly options: McpModelOptions
  /** Grants this page is revoking: their `mcp.changed` is no news. */
  private readonly expectedRevocations = new Set<string>()
  private unsubscribes: (() => void)[] = []
  private watchers = 0
  private reads = 0
  private nextChange = 0
  private started = false
  private stopped = false

  constructor(options: McpModelOptions) {
    this.options = options
    this.store = options.store ?? mcpStore
    this.host = options.host ?? ''
  }

  /** Listen to the connection's events. */
  start(): void {
    if (this.started || this.stopped) {
      return
    }

    this.started = true
    this.store.getState().reset()
    this.unsubscribes.push(
      this.options.gateway.onAny(event => {
        if (event.type === ('mcp.changed' as typeof event.type)) {
          this.changed(isRecord(event.payload) ? event.payload : {})
        }
      }),
      ...(this.options.visibility
        ? [
            this.options.visibility.subscribe(visibility => {
              if (visibility === 'visible' && this.watchers > 0) {
                void this.refresh()
              }
            })
          ]
        : [])
    )
  }

  /** Stop listening and forget what was read. Idempotent. */
  stop(): void {
    if (this.stopped) {
      return
    }

    this.stopped = true

    for (const stop of this.unsubscribes.splice(0)) {
      stop()
    }

    this.watchers = 0
    this.reads += 1
    this.store.getState().reset()
  }

  /**
   * The page is open: read now, and keep it fresh until the returned function is called.
   * More than one page may watch (a remount); the model follows while any does.
   */
  watch(): () => void {
    this.watchers += 1
    void this.refresh()

    let released = false

    return () => {
      if (!released) {
        released = true
        this.watchers = Math.max(0, this.watchers - 1)
      }
    }
  }

  /** Read `GET /api/auth/mcp`. Never throws; the store says why a read failed. */
  async refresh(): Promise<void> {
    if (this.stopped) {
      return
    }

    const read = (this.reads += 1)

    this.store.setState({ loading: true })

    try {
      const status = await this.options.client.status()

      if (read === this.reads && !this.stopped) {
        this.store.setState({ status, problem: null, loading: false, loaded: true })
      }
    } catch (error) {
      if (read === this.reads && !this.stopped) {
        const problem = problemOf(error)

        // A gateway that says it has no MCP, or no person to ask for, shows nothing from an earlier read.
        // A blip keeps the list that was read: a transport error is not news about the grants.
        this.store.setState({
          ...(problem.kind === 'failed' ? {} : { status: null }),
          problem,
          loading: false,
          loaded: true
        })
      }
    }
  }

  /**
   * Revoke one client's grant: every token of it stops working at once. `gone` is the gateway saying there is
   * none by that id (already revoked, expired, not this person's), which is the state the person asked for.
   * Either way the list is read again. A refusal or a failure to reach the gateway throws a `McpRouteError`.
   */
  async revoke(id: string): Promise<'revoked' | 'gone'> {
    this.expectedRevocations.add(id)

    let result: 'revoked' | 'gone'

    try {
      result = await this.options.client.revoke(id)
    } catch (error) {
      this.expectedRevocations.delete(id)

      throw error
    }

    await this.refresh()

    return result
  }

  /** `mcp.changed`: a client was allowed or revoked somewhere. */
  private changed(payload: Record<string, unknown>): void {
    if (this.stopped || this.watchers === 0) {
      return
    }

    const grant = isRecord(payload.grant) ? payload.grant : {}
    const id = typeof grant.id === 'string' ? grant.id : ''
    const own = payload.change === 'revoked' && this.expectedRevocations.delete(id)

    if (!own) {
      this.store.setState({
        change: {
          id: (this.nextChange += 1),
          change: typeof payload.change === 'string' ? payload.change : '',
          clientName: typeof grant.client_name === 'string' ? grant.client_name : ''
        }
      })
    }

    void this.refresh()
  }
}
