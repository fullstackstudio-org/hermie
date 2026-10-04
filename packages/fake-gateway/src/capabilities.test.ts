/**
 * The staging knobs and the calls the native capability pages (Memory, Skills, MCP servers,
 * Connectors, Boards) rely on: each answers the shape the gateway's own handler does
 * (`tui_gateway/methods_tools.py`, `methods_connectors.py` and the plugins' routers), and each
 * refusal is the one the real handler gives.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { type FakeGateway, startFakeGateway } from './server'

let gateway: FakeGateway | null = null

afterEach(async () => {
  await gateway?.close()
  gateway = null
})

const start = async (options: Parameters<typeof startFakeGateway>[0] = { port: 0 }): Promise<FakeGateway> => {
  gateway = await startFakeGateway({ port: 0, ...options })

  return gateway
}

interface Frame {
  id?: string
  result?: Record<string, unknown>
  error?: { code?: number; message?: string }
}

/** A socket to the gateway and a `call` that answers the frame its id names. */
const connect = async (
  live: FakeGateway
): Promise<{ call: (method: string, params?: Record<string, unknown>) => Promise<Frame>; close: () => void }> => {
  const socket = new WebSocket(live.wsUrl, ['hermes-gateway-v1'])

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  let id = 0

  const call = (method: string, params: Record<string, unknown> = {}): Promise<Frame> =>
    new Promise(resolve => {
      const frameId = `rpc-${(id += 1)}`
      const onMessage = (data: unknown) => {
        for (const line of String(data).split('\n').filter(Boolean)) {
          const frame = JSON.parse(line) as Frame

          if (frame.id === frameId) {
            socket.off('message', onMessage)
            resolve(frame)
          }
        }
      }

      socket.on('message', onMessage)
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
    })

  return { call, close: () => socket.close() }
}

const route = '/api/plugins/hermie/memory'

describe('memory.edit — a gateway where memory can be read and not written', () => {
  it('lists and searches as before', async () => {
    const live = await start({ memoryEdit: false })
    const body = (await fetch(`${live.url}${route}/list?profile=researcher`).then(response => response.json())) as {
      targets: unknown[]
    }

    expect(body.targets).toHaveLength(2)
  })

  it('refuses a write with the plugin’s own sentence', async () => {
    const live = await start({ memoryEdit: false })
    const response = await fetch(`${live.url}${route}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'researcher', target: 'memory', op: 'add', content: 'x' })
    })
    const body = (await response.json()) as { detail: string }

    expect(response.status).toBe(403)
    expect(body.detail).toContain('Memory editing is switched off')
  })

  it('does not advertise memory.edit while still advertising memory.browse', async () => {
    const live = await start({ memoryEdit: false })
    const profiles = await fetch(`${live.url}/api/profiles`).then(response => response.text())

    expect(profiles).toContain('memory.browse')
    expect(profiles).not.toContain('memory.edit')
  })

  it('writes when the capability is there, which is the default', async () => {
    const live = await start()
    const response = await fetch(`${live.url}${route}/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: 'writer', target: 'user', op: 'add', content: 'Likes tea.' })
    })

    expect(response.status).toBe(200)
    expect(((await response.json()) as { success: boolean }).success).toBe(true)
  })
})

describe('mcp.catalog and mcp.servers.add / set_api_key / remove', () => {
  const servers = async (call: Awaited<ReturnType<typeof connect>>['call']): Promise<Record<string, unknown>[]> =>
    ((await call('mcp.servers.list')).result as { servers: Record<string, unknown>[] }).servers

  it('lists the curated presets with what is installed and what each needs', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const catalog = ((await call('mcp.catalog')).result as { servers: Record<string, unknown>[] }).servers

    expect(catalog.map(entry => entry.name)).toEqual(['github', 'fetch', 'linear'])
    expect(catalog[0]).toMatchObject({
      installed: false,
      enabled: false,
      requires: ['GITHUB_TOKEN'],
      transport: 'stdio'
    })

    close()
  })

  it('adds a server from a preset and shows it as installed', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const added = (await call('mcp.servers.add', { name: 'github', preset: 'github' })).result as {
      ok: boolean
      server: Record<string, unknown>
    }

    expect(added.ok).toBe(true)
    expect(added.server).toMatchObject({ name: 'github', transport: 'stdio', command: 'npx', env: ['GITHUB_TOKEN'] })
    expect((await servers(call)).map(row => row.name)).toContain('github')

    const catalog = ((await call('mcp.catalog')).result as { servers: Record<string, unknown>[] }).servers

    expect(catalog.find(entry => entry.name === 'github')).toMatchObject({ installed: true, enabled: true })

    close()
  })

  it('adds a custom http server, with its bearer token kept out of every answer', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const frame = await call('mcp.servers.add', {
      name: 'notes',
      config: { url: 'https://notes.example.test/mcp' },
      bearer_token: 'sekret-token'
    })

    expect(JSON.stringify(frame)).not.toContain('sekret-token')
    expect(frame.result?.server).toMatchObject({ name: 'notes', transport: 'http', auth: 'bearer' })
    expect(live.state.mcpSecrets.get('notes')?.value).toBe('sekret-token')
    expect(JSON.stringify(await servers(call))).not.toContain('sekret-token')

    close()
  })

  it('refuses a name that is already configured with 4090', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const frame = await call('mcp.servers.add', { name: 'files', config: { command: 'npx' } })

    expect(frame.error).toMatchObject({ code: 4090, message: "server 'files' already exists" })

    close()
  })

  it('refuses a config with neither url nor command, an unknown preset and a shell pipeline', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    expect((await call('mcp.servers.add', { name: 'x', config: {} })).error?.code).toBe(4063)
    expect((await call('mcp.servers.add', { name: 'x', preset: 'nope' })).error?.code).toBe(4063)
    expect(
      (await call('mcp.servers.add', { name: 'x', config: { command: 'sh', args: ['-c', 'a; b'] } })).error?.code
    ).toBe(4001)

    close()
  })

  it('probes a freshly added server, and one whose command is missing fails to connect', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    await call('mcp.servers.add', { name: 'ok', config: { command: 'npx' } })
    await call('mcp.servers.add', { name: 'gone', config: { command: 'missing-server' } })

    expect((await call('mcp.servers.test', { name: 'ok' })).result).toMatchObject({ ok: true })
    expect((await call('mcp.servers.test', { name: 'gone' })).result).toMatchObject({
      ok: false,
      error: 'spawn missing-server ENOENT'
    })

    close()
  })

  it('writes an api key to the env and keeps only the reference on the server', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const stdio = await call('mcp.servers.set_api_key', { name: 'weather', value: 'abc123' })

    expect(stdio.result).toMatchObject({ ok: true, name: 'weather', env_var: 'MCP_WEATHER_API_KEY' })
    expect(JSON.stringify(stdio)).not.toContain('abc123')
    expect(live.state.mcpSecrets.get('weather')).toEqual({ envVar: 'MCP_WEATHER_API_KEY', value: 'abc123' })

    const http = await call('mcp.servers.set_api_key', { name: 'calendar', value: 'Bearer tok', env_var: 'CAL_KEY' })

    expect(http.result).toMatchObject({ env_var: 'CAL_KEY', server: { auth: 'bearer' } })
    expect(live.state.mcpSecrets.get('calendar')?.value).toBe('tok')

    close()
  })

  it('refuses a blank key with 4063 and an unknown server with 4064', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    expect((await call('mcp.servers.set_api_key', { name: 'weather', value: '  ' })).error?.code).toBe(4063)
    expect((await call('mcp.servers.set_api_key', { name: 'weather', value: 'Bearer' })).error?.code).toBe(4063)
    expect((await call('mcp.servers.set_api_key', { name: 'ghost', value: 'x' })).error?.code).toBe(4064)

    close()
  })

  it('removes a server, and a second remove is 4064', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    expect((await call('mcp.servers.remove', { name: 'weather' })).result).toEqual({ ok: true, removed: true })
    expect((await servers(call)).map(row => row.name)).not.toContain('weather')
    expect((await call('mcp.servers.remove', { name: 'weather' })).error?.code).toBe(4064)

    close()
  })

  it('keeps one configuration behind every view: an added server is in list, status, test and catalog, a removed one in none', async () => {
    const live = await start()
    const { call, close } = await connect(live)
    const names = async (method: string): Promise<string[]> =>
      (((await call(method)).result as { servers: { name: string }[] }).servers ?? []).map(row => row.name)

    await call('mcp.servers.add', { name: 'fetch', preset: 'fetch' })

    expect(await names('mcp.servers.list')).toContain('fetch')
    expect(await names('mcp.servers.status')).toContain('fetch')
    expect((await call('mcp.servers.test', { name: 'fetch' })).result).toMatchObject({ ok: true })

    await call('mcp.servers.remove', { name: 'fetch' })

    expect(await names('mcp.servers.list')).not.toContain('fetch')
    expect(await names('mcp.servers.status')).not.toContain('fetch')
    expect((await call('mcp.servers.test', { name: 'fetch' })).error?.code).toBe(4064)

    close()
  })
})

describe('connectors.* for the account', () => {
  const account = { type: 'account' }

  it('lists the account’s connectors the way a chat’s are listed', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const frame = await call('connectors.list', { owner: account, profile: 'researcher' })
    const result = frame.result as { available: boolean; connectors: Record<string, unknown>[] }

    expect(result.available).toBe(true)
    expect(result.connectors.map(row => row.connector)).toEqual(['gmail', 'notion', 'slack'])

    close()
  })

  it('refuses a top-level session_id and a missing owner with 4000', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    expect((await call('connectors.list', { session_id: 'rt-1' })).error?.code).toBe(4000)
    expect((await call('connectors.list', { owner: { type: 'nobody' } })).error?.code).toBe(4000)

    close()
  })

  it('answers available: false as a success when connectors are off, and refuses a connect with 4031', async () => {
    const live = await start({ connectors: false })
    const { call, close } = await connect(live)

    expect((await call('connectors.list', { owner: account })).result).toEqual({ available: false, connectors: [] })
    expect((await call('connectors.connect', { owner: account, connectors: ['notion'] })).error?.code).toBe(4031)

    close()
  })

  it('walks an account connect: a link on the target, then settled once the watcher has read it', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const started = (await call('connectors.connect', { owner: account, connectors: ['notion'] })).result as {
      op_id: string
      targets: { name: string; state: string; connect_url?: string }[]
    }

    expect(started.targets[0]).toMatchObject({ name: 'notion', state: 'initiated' })
    expect(started.targets[0]?.connect_url).toMatch(/^https:\/\/vendor\.test\/authorize\/notion/u)

    const first = (await call('connectors.operation.status', { owner: account, op_id: started.op_id })).result as {
      targets: { state: string }[]
    }
    const second = (await call('connectors.operation.status', { owner: account, op_id: started.op_id })).result as {
      settled: boolean
      targets: { state: string }[]
    }

    expect(first.targets[0]?.state).toBe('initiated')
    expect(second.targets[0]?.state).toBe('connected')
    expect(second.settled).toBe(true)

    // A settled operation is no longer open, which is what a finished flow answers.
    expect((await call('connectors.operation.status', { owner: account, op_id: started.op_id })).error?.code).toBe(4004)

    close()
  })

  it('does not let a session reach an operation the account opened', async () => {
    const live = await start()
    const { call, close } = await connect(live)

    const started = (await call('connectors.connect', { owner: account, connectors: ['notion'] })).result as {
      op_id: string
    }

    expect(
      (
        await call('connectors.operation.status', {
          owner: { type: 'session', session_id: 'rt-1' },
          op_id: started.op_id
        })
      ).error?.code
    ).toBe(4004)

    close()
  })
})

describe('the Kanban plugin', () => {
  const kanban = '/api/plugins/kanban'

  it('is there by default, with the boards on disk', async () => {
    const live = await start()
    const response = await fetch(`${live.url}${kanban}/boards`)
    const body = (await response.json()) as { boards: { slug: string }[] }

    expect(response.status).toBe(200)
    expect(body.boards.map(board => board.slug)).toEqual(['default', 'sprint'])
  })

  it('is not mounted on a gateway staged without it: every route answers 404', async () => {
    const live = await start({ kanban: false })

    for (const path of ['/boards', '/board?board=default', '/tasks/t_aa11bb22?board=default']) {
      const response = await fetch(`${live.url}${kanban}${path}`)
      const body = (await response.json()) as { detail?: string }

      expect(response.status).toBe(404)
      expect(body.detail).toBe('Not Found')
    }
  })
})
