/**
 * The staging knobs and the calls the native capability pages (Memory, Skills, MCP servers,
 * Connectors, Boards) rely on: each answers the shape the gateway's own handler does
 * (`tui_gateway/methods_tools.py`, `methods_connectors.py` and the plugins' routers), and each
 * refusal is the one the real handler gives.
 */
import { afterEach, describe, expect, it } from 'vitest'

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
