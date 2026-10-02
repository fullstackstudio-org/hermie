/**
 * Per-bot capabilities: three sections, three polarities, one call.
 *
 * Everything asserted here is a place where the obvious implementation writes
 * the opposite of what was asked. The skills list is inverted, the MCP list is
 * not, and an empty toolset list means "follow the gateway's defaults" rather
 * than "nothing is on" — which is the one that can quietly take a bot's tools
 * away.
 */
import { FakeChatGateway } from './support/fake-chat-gateway'

import {
  capabilitiesFrom,
  CapabilitiesController,
  configureParamsFor,
  type Capabilities
} from '../src/features/profiles/capabilities-controller'

const described = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'writer',
  description: '',
  soul: '',
  model: { provider: 'example-provider', default: 'example-model' },
  skills: [
    { name: 'pdf', enabled: false },
    { name: 'docx', enabled: true }
  ],
  toolsets: [
    { name: 'files', label: 'Files', description: 'Read and write.', tool_count: 6, enabled: true },
    { name: 'web', label: 'Web', description: 'Fetch pages.', tool_count: 3, enabled: false }
  ],
  toolsets_pinned: true,
  mcp_servers: [
    { name: 'files', enabled: true, transport: 'stdio' },
    { name: 'weather', enabled: false, transport: 'stdio' }
  ],
  ...overrides
})

const state = (overrides: Partial<Capabilities> = {}): Capabilities => ({
  ...capabilitiesFrom(described() as never),
  ...overrides
})

describe('capabilitiesFrom', () => {
  it('reads the three groups the sheet draws', () => {
    const capabilities = capabilitiesFrom(described() as never)

    expect(capabilities.skills).toEqual([
      { name: 'pdf', enabled: false },
      { name: 'docx', enabled: true }
    ])
    expect(capabilities.toolsets[0]).toMatchObject({ name: 'files', label: 'Files', toolCount: 6, enabled: true })
    expect(capabilities.mcpServers[1]).toMatchObject({ name: 'weather', enabled: false, transport: 'stdio' })
  })

  /**
   * Upstream marks `enabled` optional on every one of these rows, and an absent
   * flag means on. Reading `Boolean(entry.enabled)` would draw a page of
   * switches all off against a gateway that simply left the field out.
   */
  it('treats a missing enabled flag as on, never as off', () => {
    const capabilities = capabilitiesFrom(
      described({ skills: [{ name: 'pdf' }], mcp_servers: [{ name: 'files' }], toolsets: [{ name: 'web' }] }) as never
    )

    expect(capabilities.skills[0]?.enabled).toBe(true)
    expect(capabilities.mcpServers[0]?.enabled).toBe(true)
    expect(capabilities.toolsets[0]?.enabled).toBe(true)
  })

  it('falls back to the toolset’s name when it has no label', () => {
    expect(capabilitiesFrom(described({ toolsets: [{ name: 'web' }] }) as never).toolsets[0]?.label).toBe('web')
  })

  it('reports whether a pin exists, which is not whether anything is enabled', () => {
    expect(capabilitiesFrom(described({ toolsets_pinned: false }) as never).toolsetsPinned).toBe(false)
  })
})

describe('configureParamsFor', () => {
  it('sends only the section that changed', () => {
    const params = configureParamsFor('writer', state(), { skills: true })

    expect(Object.keys(params).sort()).toEqual(['disabled_skills', 'name'])
  })

  it('inverts the skills list, because the gateway stores the disabled set', () => {
    expect(configureParamsFor('writer', state(), { skills: true }).disabled_skills).toEqual(['pdf'])
  })

  it('does NOT invert the MCP list, in the very same call', () => {
    expect(configureParamsFor('writer', state(), { mcp: true }).enabled_mcp_servers).toEqual(['files'])
  })

  it('names the enabled toolsets while some are off', () => {
    expect(configureParamsFor('writer', state(), { toolsets: true }).enabled_toolsets).toEqual(['files'])
  })

  /**
   * The hazard this file exists for. `_save_toolset_pin` POPS the key on an
   * empty list, so `[]` means "follow the gateway's defaults". Sending the full
   * list when everything is on would pin a snapshot that then stops following
   * them — and the bot would silently miss any toolset added later.
   */
  it('unpins by sending an empty list when every toolset is on', () => {
    const everythingOn = state({
      toolsets: state().toolsets.map(row => ({ ...row, enabled: true }))
    })

    expect(configureParamsFor('writer', everythingOn, { toolsets: true }).enabled_toolsets).toEqual([])
  })

  it('sends an empty skills list when nothing is disabled, which clears the set', () => {
    const everythingOn = state({ skills: state().skills.map(row => ({ ...row, enabled: true })) })

    expect(configureParamsFor('writer', everythingOn, { skills: true }).disabled_skills).toEqual([])
  })
})

describe('CapabilitiesController', () => {
  it('loads one bot’s configuration by name', async () => {
    const gateway = new FakeChatGateway().reply('profiles.describe', described())

    const capabilities = await new CapabilitiesController(gateway).load('writer')

    expect(gateway.lastCall('profiles.describe')).toEqual({ name: 'writer' })
    expect(capabilities.skills).toHaveLength(2)
  })

  it('writes one section and leaves the other two unmentioned', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: true, applied: { mcp_servers: true } })

    await new CapabilitiesController(gateway).save('writer', state(), 'mcp')

    const params = gateway.lastCall('profiles.configure') ?? {}

    expect(params).toHaveProperty('enabled_mcp_servers')
    expect(params).not.toHaveProperty('disabled_skills')
    expect(params).not.toHaveProperty('enabled_toolsets')
  })

  /**
   * `applied` uses upstream's own word for the section, which is not the
   * parameter's: the MCP one is reported as `mcp_servers`. A controller that
   * looked for `mcp` would read `undefined`, call it a success, and never
   * notice a refusal.
   */
  it('reads the MCP section back under the name upstream reports it by', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: false, applied: { mcp_servers: false } })

    await expect(new CapabilitiesController(gateway).save('writer', state(), 'mcp')).rejects.toThrow(/did not apply/)
  })

  it('accepts a section the gateway did not report on, rather than inventing a failure', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: true, applied: {} })

    await expect(new CapabilitiesController(gateway).save('writer', state(), 'skills')).resolves.toBeUndefined()
  })

  /**
   * `tools.configure` takes a `session_id` and edits whichever bot is talking,
   * not the one whose sheet is open. It must never appear on this path.
   */
  it('never reaches for the session-scoped toolset call', async () => {
    const gateway = new FakeChatGateway().reply('profiles.configure', { ok: true, applied: { toolsets: true } })

    await new CapabilitiesController(gateway).save('writer', state(), 'toolsets')

    expect(gateway.methodOrder()).not.toContain('tools.configure')
  })
})
