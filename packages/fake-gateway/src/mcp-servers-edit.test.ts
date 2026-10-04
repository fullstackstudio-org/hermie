/**
 * The methods that change the gateway's MCP configuration (`mcp.catalog`, `mcp.servers.add`, `mcp.servers.remove`)
 * through the fake's own socket, and what the three views of the config (`list`, `status`, `test`) say after them:
 * the config is the one source, so an added server is in all of them and a removed one in none.
 */
import { describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'

import { startFakeGateway } from './server'

type Call = (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>

async function withGateway<T>(run: (call: Call) => Promise<T>): Promise<T> {
  const gateway = await startFakeGateway({ port: 0 })

  try {
    const socket = new WebSocket(gateway.wsUrl, ['hermes-gateway-v1'])

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve())
      socket.once('error', reject)
    })

    try {
      let id = 0

      return await run(
        (method, params = {}) =>
          new Promise((resolve, reject) => {
            const frameId = `rpc-${(id += 1)}`
            const onMessage = (data: unknown) => {
              const frame = JSON.parse(String(data)) as {
                id?: string
                result?: Record<string, unknown>
                error?: { code?: number; message?: string }
              }

              if (frame.id !== frameId) {
                return
              }

              socket.off('message', onMessage)

              if (frame.error) {
                reject(Object.assign(new Error(frame.error.message ?? 'rpc error'), { code: frame.error.code }))

                return
              }

              resolve(frame.result ?? {})
            }

            socket.on('message', onMessage)
            socket.send(JSON.stringify({ jsonrpc: '2.0', id: frameId, method, params }))
          })
      )
    } finally {
      socket.close()
    }
  } finally {
    await gateway.close()
  }
}

const names = (answer: Record<string, unknown>): string[] =>
  (answer.servers as { name: string }[]).map(server => server.name)

describe('mcp.catalog', () => {
  it('lists the presets with what each needs, and which are already configured', async () => {
    await withGateway(async call => {
      const catalogue = (await call('mcp.catalog', { profile: 'researcher' })) as {
        servers: { name: string; installed: boolean; requires: string[]; transport: string }[]
      }

      expect(catalogue.servers.find(entry => entry.name === 'github')).toMatchObject({
        installed: false,
        requires: ['GITHUB_TOKEN'],
        transport: 'http'
      })
      // `files` is configured on the fake gateway already.
      expect(catalogue.servers.find(entry => entry.name === 'files')?.installed).toBe(true)
    })
  })
})

describe('mcp.servers.add', () => {
  it('adds a server from a preset, and the list, the status and the probe all know it', async () => {
    await withGateway(async call => {
      const added = (await call('mcp.servers.add', { profile: 'researcher', name: 'time', preset: 'time' })) as {
        ok: boolean
        name: string
        server: Record<string, unknown>
      }

      expect(added).toMatchObject({ ok: true, name: 'time', server: { transport: 'stdio', enabled: true } })
      expect(names(await call('mcp.servers.list'))).toContain('time')
      expect(names(await call('mcp.servers.status'))).toContain('time')
      expect(await call('mcp.servers.test', { name: 'time' })).toMatchObject({ ok: true })
      expect((await call('mcp.catalog')) as unknown).toMatchObject({
        servers: expect.arrayContaining([expect.objectContaining({ name: 'time', installed: true })])
      })
    })
  })

  it('adds a server of its own from an address or a command, and names the env key of a bearer token without its value', async () => {
    await withGateway(async call => {
      const hosted = (await call('mcp.servers.add', {
        name: 'hosted',
        config: { url: 'https://hosted.example.test/mcp' },
        bearer_token: 'secret-value'
      })) as { server: { transport: string; url: string; env: string[]; auth: string } }

      expect(hosted.server).toMatchObject({
        transport: 'http',
        url: 'https://hosted.example.test/mcp',
        auth: 'bearer',
        env: ['HOSTED_TOKEN']
      })
      expect(JSON.stringify(await call('mcp.servers.list'))).not.toContain('secret-value')

      const local = (await call('mcp.servers.add', {
        name: 'local',
        config: { command: 'npx', args: ['-y', 'x'] }
      })) as {
        server: { transport: string; command: string; args: string[] }
      }

      expect(local.server).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] })
    })
  })

  it('refuses a name already configured, an unusable name, an unknown preset and a server with no address', async () => {
    await withGateway(async call => {
      await expect(call('mcp.servers.add', { name: 'files', preset: 'files' })).rejects.toMatchObject({ code: 4001 })
      await expect(call('mcp.servers.add', { name: 'a b', config: { url: 'https://x.test' } })).rejects.toMatchObject({
        code: 4001
      })
      await expect(call('mcp.servers.add', { name: 'x', preset: 'nope' })).rejects.toMatchObject({ code: 4064 })
      await expect(call('mcp.servers.add', { name: 'x', config: {} })).rejects.toMatchObject({ code: 4001 })
      expect(names(await call('mcp.servers.list'))).not.toContain('x')
    })
  })

  it('adds a server whose command cannot start, so a page has a failing one to draw', async () => {
    await withGateway(async call => {
      await call('mcp.servers.add', { name: 'broken', config: { command: 'missing-server' } })

      expect(await call('mcp.servers.test', { name: 'broken' })).toMatchObject({
        ok: false,
        error: 'spawn missing-server ENOENT'
      })
    })
  })
})

describe('mcp.servers.remove', () => {
  it('takes a server out of every view, and says nothing was removed for one that is not there', async () => {
    await withGateway(async call => {
      expect(await call('mcp.servers.remove', { name: 'weather' })).toEqual({ ok: true, removed: true })
      expect(names(await call('mcp.servers.list'))).not.toContain('weather')
      expect(names(await call('mcp.servers.status'))).not.toContain('weather')
      await expect(call('mcp.servers.test', { name: 'weather' })).rejects.toMatchObject({ code: 4064 })
      expect(await call('mcp.servers.remove', { name: 'weather' })).toEqual({ ok: true, removed: false })
    })
  })
})
