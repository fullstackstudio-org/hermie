import { randomBytes } from 'node:crypto'

/**
 * The MCP side of the fake gateway: the grants a person has handed to MCP clients (Claude Code and the
 * like), and what the app's Settings page reads and revokes. The real thing is the fork's
 * `hermes_cli/dashboard_auth/mcp/` (`mcp.db`); this keeps the same facts in memory and none of the OAuth
 * machinery, since no client under test speaks MCP. The shapes are `contract/gateway/mcp.md`.
 */

/** One grant, as the gateway's registry holds it. Times are Unix seconds. */
export interface McpGrant {
  id: string
  /** `<provider>:<user id>`, the author-stamp id of the person who consented. */
  userId: string
  /** The name the client registered itself under. Untrusted text. */
  clientName: string
  clientId: string
  scopes: string[]
  createdAt: number
  createdIp: string | null
  createdUserAgent: string | null
  lastUsedAt: number | null
  lastUsedIp: string | null
  expiresAt: number
  revokedAt: number | null
  /** `user` (from the app), `operator` (`hermes dashboard mcp revoke`), or null while the grant stands. */
  revokedBy: 'user' | 'operator' | null
}

/** What seeding a grant may name. Everything but `userId` and `clientName` has a default. */
export interface McpGrantInput {
  userId: string
  clientName: string
  id?: string
  clientId?: string
  scopes?: string[]
  createdAt?: number
  createdIp?: string | null
  createdUserAgent?: string | null
  lastUsedAt?: number | null
  lastUsedIp?: string | null
  expiresAt?: number
}

/** What a caller (`startFakeGateway({ mcp })`) may set. All optional. */
export interface McpOptions {
  /** `false` stages a gateway that knows the feature and has it switched off: its routes answer as unknown. Default true. */
  enabled?: boolean
  /** The endpoint a client connects to. Default `<the fake's own address>/mcp`. */
  endpointUrl?: string
  /** The name in the `claude mcp add` command. Default `hermie-fake`. */
  label?: string
}

/** A grant stays valid for 90 days, then the person consents again (the plan's `grant_max_age`). */
export const GRANT_MAX_AGE_SEC = 90 * 24 * 60 * 60

/** The characters a grant id may hold: it rides in a URL path and in a log line. */
export const GRANT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u

export class McpStore {
  private readonly grants: McpGrant[] = []

  constructor(private readonly clock: () => number = Date.now) {}

  now(): number {
    return Math.floor(this.clock() / 1000)
  }

  /** Add a grant, as a consent would. */
  seed(input: McpGrantInput): McpGrant {
    const createdAt = input.createdAt ?? this.now()
    const id = input.id ?? `mcg_${randomBytes(9).toString('base64url')}`

    if (this.grants.some(grant => grant.id === id)) {
      throw new Error(`There is a grant ${id} already`)
    }

    const grant: McpGrant = {
      id,
      userId: input.userId,
      clientName: input.clientName,
      clientId: input.clientId ?? `mcc_${randomBytes(9).toString('base64url')}`,
      scopes: [...(input.scopes ?? ['mcp'])],
      createdAt,
      createdIp: input.createdIp === undefined ? '203.0.113.7' : input.createdIp,
      createdUserAgent: input.createdUserAgent === undefined ? 'claude-code/2.1' : input.createdUserAgent,
      lastUsedAt: input.lastUsedAt ?? null,
      lastUsedIp: input.lastUsedIp ?? null,
      expiresAt: input.expiresAt ?? createdAt + GRANT_MAX_AGE_SEC,
      revokedAt: null,
      revokedBy: null
    }

    this.grants.push(grant)

    return grant
  }

  /** Every grant, revoked and expired ones included, oldest first. The operator's view. */
  all(): McpGrant[] {
    return [...this.grants]
  }

  /**
   * The grants a person sees: theirs, not revoked, not expired, newest first (ties by id). Another
   * person's grants are never in it.
   */
  active(userId: string): McpGrant[] {
    const now = this.now()

    return this.grants
      .filter(grant => grant.userId === userId && grant.revokedAt === null && grant.expiresAt > now)
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  }

  /**
   * Revoke a grant that is one of `userId`'s active ones. `null` for any other id (unknown, somebody
   * else's, already revoked, expired): the route cannot tell those apart, and neither can a caller.
   */
  revoke(id: string, userId: string, by: 'user' | 'operator'): McpGrant | null {
    const found = this.active(userId).find(grant => grant.id === id)

    if (!found) {
      return null
    }

    found.revokedAt = this.now()
    found.revokedBy = by

    return found
  }
}

/** The settings behind `McpOptions`, with the defaults filled in. */
export interface McpSettings {
  enabled: boolean
  endpointUrl: string
  label: string
}

/** What a gateway hands the MCP part: where it listens, whom a frame reaches, which browser origins it trusts. */
export interface McpHost {
  /** The address the fake listens on. Read late: it is only known once the server is up. */
  ownUrl: () => string
  /** The origins a browser write may come from: the fake's own, and the public host when one is enforced. */
  acceptedOrigins: () => string[]
  /** Deliver `mcp.changed` to every live connection of `userId`; how many it reached. */
  announce: (userId: string, payload: Record<string, unknown>) => number
  clock?: () => number
}

/** The MCP feature of the fake gateway: its settings, its grants, and the frame that follows a change. */
export class McpGateway {
  readonly store: McpStore
  private options: McpOptions

  constructor(
    options: McpOptions,
    private readonly host: McpHost
  ) {
    this.options = { ...options }
    this.store = new McpStore(host.clock)
  }

  /** Change the operator's settings, as editing `dashboard.mcp` in `config.yaml` is. */
  configure(options: McpOptions): void {
    this.options = { ...this.options, ...options }
  }

  get settings(): McpSettings {
    return {
      enabled: this.options.enabled !== false,
      endpointUrl: this.options.endpointUrl ?? `${this.host.ownUrl()}/mcp`,
      label: this.options.label ?? 'hermie-fake'
    }
  }

  acceptedOrigins(): string[] {
    return this.host.acceptedOrigins()
  }

  /** `mcp.changed {change, grant: {id, client_name}, at}` to the person's live connections. */
  announce(change: 'granted' | 'revoked', grant: McpGrant): number {
    return this.host.announce(grant.userId, {
      change,
      grant: { id: grant.id, client_name: grant.clientName },
      at: this.store.now()
    })
  }
}
