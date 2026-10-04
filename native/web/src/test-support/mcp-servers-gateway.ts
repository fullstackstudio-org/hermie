/**
 * The gateway's MCP server methods in memory, for the MCP servers page's tests: the config list with the cached
 * status beside it, the probe (a successful call whichever way it goes), the PKCE flow (`oauth.start`, `poll`,
 * `cancel`), the catalogue, `add` and `remove`, and `reload.mcp` with its confirmation. In the shapes
 * `packages/fake-gateway` serves.
 */
import { aManageTransport } from './manage-transport'

export interface Server {
  name: string
  transport: 'stdio' | 'http'
  url?: string
  command?: string
  args?: string[]
  env?: string[]
  auth?: 'oauth' | 'bearer' | null
  tokens?: boolean
  enabled?: boolean
  /** `null`: the connection fails. */
  tools: { name: string; description: string }[] | null
  error?: string
}

export const FILES: Server = {
  name: 'files',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', 'server-filesystem'],
  tools: [
    { name: 'read_file', description: 'Read a file.' },
    { name: 'write_file', description: 'Write a file.' }
  ]
}

export const CALENDAR: Server = {
  name: 'calendar',
  transport: 'http',
  url: 'https://calendar.example.test/mcp',
  auth: 'oauth',
  tokens: false,
  tools: [{ name: 'list_events', description: 'List events.' }]
}

export const WEATHER: Server = {
  name: 'weather',
  transport: 'stdio',
  command: 'weather-mcp',
  env: ['WEATHER_API_KEY'],
  tools: null,
  error: 'spawn weather-mcp ENOENT'
}

export function anMcpServersGateway(
  options: {
    servers?: Server[]
    /** `reload.mcp` asks first, as a gateway that has not been told "always" does. */
    reloadAsks?: boolean
    /** `oauth.poll` answers `pending` this many times before it settles. */
    pending?: number
    oauthEnds?: 'approved' | 'error'
    noStatus?: boolean
    noCatalogue?: boolean
  } = {}
) {
  const servers: Server[] = (options.servers ?? [FILES, CALENDAR, WEATHER]).map(server => ({ ...server }))
  let reloadAsks = options.reloadAsks ?? true
  let pending = options.pending ?? 1
  const flows = new Map<string, string>()
  let refuse: { method: string; message: string } | null = null

  const summary = (server: Server) => ({
    name: server.name,
    transport: server.transport,
    url: server.url ?? null,
    command: server.command ?? null,
    args: server.args ?? [],
    env: server.env ?? [],
    auth: server.auth ?? null,
    oauth_tokens_present: server.auth === 'oauth' ? (server.tokens ?? false) : null,
    enabled: server.enabled !== false,
    tools: server.tools ? server.tools.length : null
  })

  const find = (name: unknown): Server => {
    const server = servers.find(entry => entry.name === name)

    if (!server) {
      throw Object.assign(new Error(`server '${String(name)}' not found`), { code: 4064 })
    }

    return server
  }

  const guard = (method: string): void => {
    if (refuse?.method === method) {
      throw new Error(refuse.message)
    }
  }

  const transport = aManageTransport(
    {},
    {
      'mcp.servers.list': () => ({ servers: servers.map(summary) }),
      'mcp.servers.status': () => {
        if (options.noStatus) {
          throw new Error('unknown method mcp.servers.status')
        }

        return {
          servers: servers.map(server => ({
            name: server.name,
            transport: server.transport,
            tools: server.tools?.length ?? 0,
            connected: server.tools !== null,
            disabled: server.enabled === false,
            status: server.enabled === false ? 'disabled' : server.tools === null ? 'failed' : 'connected'
          })),
          checked_at: 1
        }
      },
      'mcp.servers.test': params => {
        guard('mcp.servers.test')

        const server = find(params.name)
        const oauth = server.auth === 'oauth'

        if (server.tools === null) {
          return {
            ok: false,
            error: server.error ?? 'failed',
            tools: [],
            oauth_needed: oauth,
            oauth_tokens_present: null
          }
        }

        if (oauth && !server.tokens) {
          return {
            ok: false,
            error: 'OAuth authentication required — no token found.',
            tools: [],
            oauth_needed: true,
            oauth_tokens_present: false
          }
        }

        return { ok: true, tools: server.tools, oauth_needed: oauth, oauth_tokens_present: oauth ? true : null }
      },
      'mcp.servers.oauth.start': params => {
        guard('mcp.servers.oauth.start')

        const server = find(params.name)
        const id = `flow-${flows.size + 1}`

        flows.set(id, server.name)

        return {
          ok: true,
          session_id: id,
          auth_url: `https://calendar.example.test/authorize?state=${id}`,
          flow: 'pkce'
        }
      },
      'mcp.servers.oauth.poll': params => {
        const id = String(params.session_id)
        const name = flows.get(id)

        if (!name) {
          throw Object.assign(new Error(`no OAuth flow '${id}'`), { code: 4064 })
        }

        if (pending > 0) {
          pending -= 1

          return { ok: true, status: 'pending', session_id: id }
        }

        if (options.oauthEnds === 'error') {
          return { ok: true, status: 'error', session_id: id, error_message: 'the sign-in was denied' }
        }

        const server = find(name)

        server.tokens = true

        return { ok: true, status: 'approved', session_id: id, tools: server.tools ?? [] }
      },
      'mcp.servers.oauth.cancel': params => {
        flows.delete(String(params.session_id))

        return { ok: true, status: 'cancelled' }
      },
      'mcp.catalog': () => {
        if (options.noCatalogue) {
          throw Object.assign(new Error('unknown method mcp.catalog'), { code: 4001 })
        }

        return {
          servers: [
            { name: 'time', description: 'The clock.', requires: [], transport: 'stdio' },
            { name: 'github', description: 'Issues.', requires: ['GITHUB_TOKEN'], transport: 'http' },
            { name: 'files', description: 'Files.', requires: [], transport: 'stdio' }
          ].map(entry => ({ ...entry, installed: servers.some(server => server.name === entry.name), enabled: true }))
        }
      },
      'mcp.servers.add': params => {
        guard('mcp.servers.add')

        const name = String(params.name)

        if (servers.some(server => server.name === name)) {
          throw Object.assign(new Error(`server '${name}' already exists`), { code: 4090 })
        }

        const config = (params.config ?? {}) as { url?: string; command?: string; args?: string[] }
        const added: Server = {
          name,
          transport: config.url || params.preset === 'github' ? 'http' : 'stdio',
          ...(config.url ? { url: config.url } : {}),
          ...(config.command ? { command: config.command, args: config.args ?? [] } : {}),
          auth: params.bearer_token ? 'bearer' : null,
          tools: [{ name: 'ping', description: 'Answers.' }]
        }

        servers.push(added)

        return { ok: true, name, server: summary(added) }
      },
      'mcp.servers.remove': params => {
        guard('mcp.servers.remove')

        const index = servers.findIndex(server => server.name === params.name)

        if (index < 0) {
          throw Object.assign(new Error(`server '${String(params.name)}' not found`), { code: 4064 })
        }

        servers.splice(index, 1)

        return { ok: true, removed: true }
      },
      'reload.mcp': params => {
        guard('reload.mcp')

        if (params.confirm !== true && params.always !== true && reloadAsks) {
          return { status: 'confirm_required', message: 'Reloading invalidates the prompt cache.' }
        }

        if (params.always === true) {
          reloadAsks = false
        }

        return { status: 'reloaded' }
      }
    }
  )

  return {
    ...transport,
    servers,
    refuse: (method: string, message: string) => {
      refuse = { method, message }
    }
  }
}
