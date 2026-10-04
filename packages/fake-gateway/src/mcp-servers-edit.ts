/**
 * The three `mcp.*` methods that change the gateway's MCP configuration, which `server.ts` delegates to:
 * `mcp.catalog` (the presets a profile can add), `mcp.servers.add` and `mcp.servers.remove`.
 *
 * The shapes are `McpCatalogResult`, `McpServersAddResult` and `McpServersRemoveResult` of the vendored contract.
 * `add` takes a catalog `preset` and/or an explicit `config` (`url`, or `command` with `args`, and `env`); a
 * `bearer_token` is written to the profile's `.env` and never sent back, so the server's summary only names the
 * env key. A name that is already configured is refused, as the config file would not take two of one name; an
 * unusable name is refused before anything is written. `remove` of a name that is not there answers
 * `removed: false` rather than failing, which is what a client that removed it elsewhere first should see.
 *
 * Kept apart from `server.ts` so that the fake's one very large file does not grow with every method the web
 * pages need; the state it works on is the fake's own list of configured servers.
 */
import type { FakeMcpServer } from './server'

/** A refusal with a JSON-RPC code, built by the caller so this file holds no class of the server's. */
export type FaultFactory = (code: number, message: string) => Error

/** The catalogue of presets. `requires` names the env keys the preset needs and the page asks for. */
export const FAKE_MCP_CATALOG: readonly {
  name: string
  description: string
  requires: string[]
  transport: 'http' | 'stdio'
}[] = [
  { name: 'time', description: 'The clock and time zones.', requires: [], transport: 'stdio' },
  { name: 'github', description: 'Issues and pull requests.', requires: ['GITHUB_TOKEN'], transport: 'http' },
  { name: 'files', description: 'Read and write files on the host.', requires: [], transport: 'stdio' }
]

/** `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`: the names a config key can be, which the gateway checks before it writes. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

/** What `mcp.servers.list` says about a server: its config without a secret. */
export function summariseServer(server: FakeMcpServer): Record<string, unknown> {
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

/** The methods this file answers. */
export const MCP_EDIT_METHODS = ['mcp.catalog', 'mcp.servers.add', 'mcp.servers.remove'] as const

export type McpEditMethod = (typeof MCP_EDIT_METHODS)[number]

export function handleMcpEdit(
  servers: FakeMcpServer[],
  method: McpEditMethod,
  params: Record<string, unknown>,
  fault: FaultFactory
): Record<string, unknown> {
  if (method === 'mcp.catalog') {
    return {
      servers: FAKE_MCP_CATALOG.map(entry => ({
        ...entry,
        requires: [...entry.requires],
        installed: servers.some(server => server.name === entry.name),
        enabled: servers.some(server => server.name === entry.name && server.enabled)
      }))
    }
  }

  const name = text(params.name)

  if (method === 'mcp.servers.remove') {
    const index = servers.findIndex(server => server.name === name)

    if (index >= 0) {
      servers.splice(index, 1)
    }

    return { ok: true, removed: index >= 0 }
  }

  if (!NAME.test(name)) {
    throw fault(4001, `'${name}' is not a usable server name`)
  }

  if (servers.some(server => server.name === name)) {
    throw fault(4001, `server '${name}' is already configured`)
  }

  const preset = text(params.preset)
  const entry = preset ? FAKE_MCP_CATALOG.find(candidate => candidate.name === preset) : undefined

  if (preset && !entry) {
    throw fault(4064, `no catalog entry '${preset}'`)
  }

  const config =
    typeof params.config === 'object' && params.config !== null && !Array.isArray(params.config)
      ? (params.config as Record<string, unknown>)
      : {}
  const url = text(config.url)
  const command = text(config.command)

  if (!entry && !url && !command) {
    throw fault(4001, 'a server needs a url or a command')
  }

  const bearer = text(params.bearer_token)
  const asHttp = url !== '' || (entry?.transport === 'http' && command === '')
  const server: FakeMcpServer = {
    name,
    transport: asHttp ? 'http' : 'stdio',
    ...(url ? { url } : entry?.transport === 'http' ? { url: `https://${entry.name}.example.test/mcp` } : {}),
    ...(command ? { command } : entry?.transport === 'stdio' ? { command: 'npx' } : {}),
    args: Array.isArray(config.args) ? config.args.map(String) : [],
    env: [
      ...(Array.isArray(config.env) ? config.env.map(String) : Object.keys((config.env as object | undefined) ?? {})),
      ...(entry?.requires ?? []),
      ...(bearer ? [`${name.toUpperCase().replace(/-/gu, '_')}_TOKEN`] : [])
    ],
    auth: bearer ? 'bearer' : null,
    oauthTokensPresent: false,
    enabled: true,
    // A command named `missing…` is the one that cannot start, so a page has a failing add to draw.
    tools: command.startsWith('missing') ? null : [{ name: 'ping', description: 'Answers when the server is up.' }],
    ...(command.startsWith('missing') ? { probeError: `spawn ${command} ENOENT` } : {})
  }

  servers.push(server)

  return { ok: true, name, server: summariseServer(server) }
}
