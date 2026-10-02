/**
 * The MCP page's four calls, and the three ways they disagree.
 *
 * Nearly every case here exists because the obvious implementation is wrong in
 * a way that reads as working: a failing probe is a SUCCESSFUL RPC, an
 * unauthorised server looks healthy in the cheap status view, and `reload.mcp`
 * refuses by answering. A controller that checked for thrown errors would pass
 * a suite that only tested the happy path and would then report every broken
 * server as fine.
 */
import { FakeChatGateway } from './support/fake-chat-gateway'

import { McpController, mergeServers, OAUTH_POLL_INTERVAL_MS } from '../src/features/mcp/mcp-controller'

const summary = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'files',
  transport: 'stdio',
  url: null,
  command: 'npx',
  args: ['-y', 'server-filesystem'],
  env: [],
  auth: null,
  oauth_tokens_present: null,
  enabled: true,
  tools: 2,
  ...overrides
})

const build = (gateway: FakeChatGateway, opened: string[] = []): McpController =>
  new McpController({
    gateway,
    openUrl: url => {
      opened.push(url)
    },
    wait: async () => undefined,
    now: () => 0
  })

describe('mergeServers', () => {
  it('joins the config list to the cached runtime rows by name', () => {
    const merged = mergeServers(
      [summary(), summary({ name: 'calendar', transport: 'http', url: 'https://x.test/mcp', command: null })] as never,
      [{ name: 'files', transport: 'stdio', tools: 2, connected: true, disabled: false, status: 'connected' }] as never
    )

    expect(merged[0]).toMatchObject({ name: 'files', runtime: 'connected', toolCount: 2 })
    expect(merged[1]).toMatchObject({ name: 'calendar', address: 'https://x.test/mcp' })
  })

  /**
   * A configured server that has never been started has no runtime row. Reading
   * that as `failed` would put a red dot on every lazily-started server on a
   * gateway that had just booted.
   */
  it('calls a server with no runtime row unknown, never failed', () => {
    expect(mergeServers([summary()] as never, [])[0]?.runtime).toBe('unknown')
  })

  it('builds a stdio address from the command and its arguments', () => {
    expect(mergeServers([summary()] as never, [])[0]?.address).toBe('npx -y server-filesystem')
  })
})

describe('McpController.load', () => {
  it('paints the list even when the cheap status view is unavailable', async () => {
    const gateway = new FakeChatGateway()
      .reply('mcp.servers.list', { servers: [summary()] })
      .reply('mcp.servers.status', () => {
        throw new Error('unknown method')
      })

    const servers = await build(gateway).load()

    expect(servers).toHaveLength(1)
    expect(servers[0]?.runtime).toBe('unknown')
  })

  it('scopes both calls to a profile when one is given', async () => {
    const gateway = new FakeChatGateway()
      .reply('mcp.servers.list', { servers: [] })
      .reply('mcp.servers.status', { servers: [], checked_at: 0 })

    await build(gateway).load('writer')

    expect(gateway.lastCall('mcp.servers.list')).toEqual({ profile: 'writer' })
    expect(gateway.lastCall('mcp.servers.status')).toEqual({ profile: 'writer' })
  })
})

describe('McpController.test', () => {
  it('reports a failing probe as a failure although the RPC succeeded', async () => {
    const gateway = new FakeChatGateway().reply('mcp.servers.test', {
      ok: false,
      error: 'spawn ENOENT',
      tools: [],
      oauth_needed: false
    })

    expect(await build(gateway).test('weather')).toMatchObject({ ok: false, needsAuth: false, error: 'spawn ENOENT' })
  })

  /**
   * `oauth_needed` is true on an OAuth server whether or not it is authorised —
   * it describes the server, not the problem. So "needs auth" is the PAIR:
   * OAuth wanted, and no token. Reading the flag alone would offer an authorise
   * button on a server that is already signed in.
   */
  it('separates “this server uses OAuth” from “this server needs authorising”', async () => {
    const needs = new FakeChatGateway().reply('mcp.servers.test', {
      ok: false,
      error: 'OAuth authentication required — no token found.',
      tools: [],
      oauth_needed: true,
      oauth_tokens_present: false
    })

    expect((await build(needs).test('calendar')).needsAuth).toBe(true)

    const signedIn = new FakeChatGateway().reply('mcp.servers.test', {
      ok: true,
      tools: [{ name: 'list_events', description: 'List events.' }],
      oauth_needed: true,
      oauth_tokens_present: true
    })

    expect(await build(signedIn).test('calendar')).toMatchObject({ ok: true, needsAuth: false })
  })

  it('always has something to say when a probe fails silently', async () => {
    const gateway = new FakeChatGateway().reply('mcp.servers.test', { ok: false, tools: [], oauth_needed: false })

    expect(await build(gateway).test('weather')).toMatchObject({ error: expect.any(String) })
  })
})

describe('McpController.authorise', () => {
  const started = { ok: true, session_id: 'flow-1', auth_url: 'https://x.test/authorize?state=flow-1', flow: 'pkce' }

  it('opens the gateway’s URL and polls until the flow is approved', async () => {
    const opened: string[] = []
    let polls = 0
    const gateway = new FakeChatGateway()
      .reply('mcp.servers.oauth.start', started)
      .reply('mcp.servers.oauth.poll', () => {
        polls += 1

        return polls < 3 ? { ok: true, status: 'pending' } : { ok: true, status: 'approved', tools: [] }
      })

    const result = await build(gateway, opened).authorise('calendar')

    expect(opened).toEqual(['https://x.test/authorize?state=flow-1'])
    expect(polls).toBe(3)
    expect(result).toMatchObject({ ok: true, needsAuth: false })
  })

  /**
   * The loopback redirect is the desktop's trick, and it needs a listener in
   * Electron's main process to work. This app has none, so sending the
   * parameter would hand the gateway an address nobody is listening on and the
   * flow would hang at the redirect.
   */
  it('never claims a loopback it cannot host', async () => {
    const gateway = new FakeChatGateway()
      .reply('mcp.servers.oauth.start', started)
      .reply('mcp.servers.oauth.poll', { ok: true, status: 'approved', tools: [] })

    await build(gateway).authorise('calendar')

    expect(gateway.lastCall('mcp.servers.oauth.start')).not.toHaveProperty('client_redirect_uri')
  })

  it('cancels the flow on the gateway when it is abandoned', async () => {
    const gateway = new FakeChatGateway()
      .reply('mcp.servers.oauth.start', started)
      .reply('mcp.servers.oauth.poll', { ok: true, status: 'error', error_message: 'access_denied' })
      .reply('mcp.servers.oauth.cancel', { ok: true })

    await expect(build(gateway).authorise('calendar')).rejects.toThrow(/access_denied/)
    expect(gateway.lastCall('mcp.servers.oauth.cancel')).toMatchObject({ name: 'calendar', session_id: 'flow-1' })
  })

  it('gives up rather than polling forever, and cancels when it does', async () => {
    const gateway = new FakeChatGateway()
      .reply('mcp.servers.oauth.start', started)
      .reply('mcp.servers.oauth.poll', { ok: true, status: 'pending' })
      .reply('mcp.servers.oauth.cancel', { ok: true })

    let clock = 0
    const controller = new McpController({
      gateway,
      openUrl: () => undefined,
      wait: async () => {
        clock += OAUTH_POLL_INTERVAL_MS
      },
      now: () => clock
    })

    await expect(controller.authorise('calendar')).rejects.toThrow(/Timed out/)
    expect(gateway.methodOrder()).toContain('mcp.servers.oauth.cancel')
  })

  it('refuses a flow the gateway started without an address', async () => {
    const gateway = new FakeChatGateway().reply('mcp.servers.oauth.start', { ok: true, session_id: 'f', flow: 'pkce' })

    await expect(build(gateway).authorise('calendar')).rejects.toThrow(/where to send you/)
  })
})

describe('McpController.reload', () => {
  /**
   * The refusal that is not an error. Upstream answers a 200 carrying
   * `confirm_required`, so a controller that only watched for a throw would
   * report a reload that never happened.
   */
  it('reports the gateway’s question instead of claiming it reloaded', async () => {
    const gateway = new FakeChatGateway().reply('reload.mcp', {
      status: 'confirm_required',
      message: '⚠️  /reload-mcp invalidates the prompt cache'
    })

    expect(await build(gateway).reload()).toMatchObject({
      status: 'confirm_required',
      message: expect.stringContaining('prompt cache')
    })
  })

  it('sends confirm only when it has one, so the gateway can still ask', async () => {
    const gateway = new FakeChatGateway().reply('reload.mcp', { status: 'reloaded' })
    const controller = build(gateway)

    await controller.reload()
    expect(gateway.lastCall('reload.mcp')).toEqual({})

    await controller.reload({ confirm: true, sessionId: 'session-1' })
    expect(gateway.lastCall('reload.mcp')).toEqual({ confirm: true, session_id: 'session-1' })
  })

  /**
   * `always` clears `approvals.mcp_reload_confirm` in the GATEWAY's config, so
   * it is shared with the CLI and the desktop app. Remembering it locally
   * instead would keep asking on a gateway that had already been told not to.
   */
  it('passes `always` to the gateway rather than remembering it here', async () => {
    const gateway = new FakeChatGateway().reply('reload.mcp', { status: 'reloaded' })

    await build(gateway).reload({ always: true })

    expect(gateway.lastCall('reload.mcp')).toEqual({ always: true })
  })
})
