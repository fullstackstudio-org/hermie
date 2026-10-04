/**
 * The bot profile model against a gateway that keeps a profile the way the real one does: skills as the
 * DISABLED set, toolsets as an optional pin, MCP servers as the ENABLED list. What it proves is what the page
 * relies on: the description waits for Save and is checked against `applied`; a switch paints first and
 * writes the whole list; two quick switches are two states in order and one write at a time; a refused write
 * puts the switch back and, when it is a denial, makes the model read-only; a read that was already stale
 * does not undo a write; the last toolset cannot be switched off; the gateway's reload question reaches the
 * page.
 */
import { describe, expect, it, vi } from 'vitest'

import { gateway } from '../../test-support/fake-profile-gateway'
import { BotProfileModel } from './model'

const denied = (message = 'Read-only account.') => Object.assign(new Error(message), { code: 4030 })

function modelOn(fake: ReturnType<typeof gateway>, over: { onChanged?: () => void; session?: string } = {}) {
  return new BotProfileModel({
    gateway: { request: fake.request as never },
    profile: 'writer',
    runtimeSessionId: () => over.session,
    ...(over.onChanged ? { onChanged: over.onChanged } : {})
  })
}

const flush = async (): Promise<void> => {
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve()
  }
}

describe('reading', () => {
  it('reads the profile into details and the description draft', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    expect(model.store.getState().phase).toBe('idle')
    await model.load()

    const state = model.store.getState()

    expect(state.phase).toBe('loaded')
    expect(state.details?.skills.map(skill => skill.name)).toEqual(['pdf', 'docx', 'xlsx'])
    expect(state.details?.toolsetsPinned).toBe(false)
    expect(state.descriptionDraft).toBe('Writes.')
    expect(fake.calls[0]).toEqual({ method: 'profiles.describe', params: { name: 'writer' } })
  })

  it('shares one read between callers that ask at once', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await Promise.all([model.load(), model.load()])

    expect(fake.calls.filter(call => call.method === 'profiles.describe')).toHaveLength(1)
  })

  it('says why a read failed, and goes read-only when the account may not even look', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    fake.fail('profiles.describe', Object.assign(new Error('Unknown method'), { code: -32601 }))
    await model.load()
    expect(model.store.getState()).toMatchObject({ phase: 'failed', loadFailure: { kind: 'unsupported' } })

    fake.fail('profiles.describe', denied())
    await model.load()
    expect(model.store.getState()).toMatchObject({ phase: 'failed', refused: true, loadFailure: { kind: 'forbidden' } })

    await model.load()
    expect(model.store.getState().phase).toBe('loaded')
  })

  it('keeps what it has when a later read fails', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.fail('profiles.describe', new Error('gateway not connected'))
    await model.load()

    expect(model.store.getState().phase).toBe('loaded')
    expect(model.store.getState().details).not.toBeNull()
  })

  it('canWrite only with a connection, no refusal and a profile read', async () => {
    const model = modelOn(gateway())

    expect(model.canWrite(true)).toBe(false)
    await model.load()
    expect(model.canWrite(true)).toBe(true)
    expect(model.canWrite(false)).toBe(false)
  })
})

describe('the description', () => {
  it('waits for Save, writes it trimmed, and tells the list', async () => {
    const fake = gateway()
    const onChanged = vi.fn()
    const model = modelOn(fake, { onChanged })

    await model.load()
    model.setDescriptionDraft('  Writes well.  ')
    expect(model.descriptionIsDirty).toBe(true)
    expect(fake.configures()).toEqual([])

    await model.saveDescription()

    expect(fake.configures()).toEqual([{ name: 'writer', description: 'Writes well.' }])
    expect(model.store.getState().details?.description).toBe('Writes well.')
    expect(model.store.getState().descriptionDraft).toBe('Writes well.')
    expect(model.descriptionIsDirty).toBe(false)
    expect(onChanged).toHaveBeenCalledTimes(1)
  })

  it('reverts a draft to what the gateway holds', async () => {
    const model = modelOn(gateway())

    await model.load()
    model.setDescriptionDraft('Something else')
    model.revertDescription()

    expect(model.store.getState().descriptionDraft).toBe('Writes.')
  })

  it('reports a section the gateway did not apply, and keeps the draft', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.request.mockImplementationOnce(async () => ({ ok: true, applied: { description: false } }))
    model.setDescriptionDraft('New')
    await model.saveDescription()

    expect(model.store.getState().failures.description?.kind).toBe('not_applied')
    expect(model.store.getState().descriptionDraft).toBe('New')
    expect(model.store.getState().details?.description).toBe('Writes.')
  })

  it('goes read-only on a denial and says it under the field, in the gateway’s words', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.fail('profiles.configure', denied('Read-only account.'))
    model.setDescriptionDraft('New')
    await model.saveDescription()

    const state = model.store.getState()

    expect(state.refused).toBe(true)
    expect(state.failures.description).toMatchObject({ kind: 'forbidden', detail: 'Read-only account.' })
    expect(model.canWrite(true)).toBe(false)
  })

  it('does not follow a read over a draft being typed, and follows it when the draft is untouched', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.profile.description = 'Changed elsewhere.'
    await model.load()
    expect(model.store.getState().descriptionDraft).toBe('Changed elsewhere.')

    model.setDescriptionDraft('Half typed')
    fake.profile.description = 'Changed again.'
    await model.load()
    expect(model.store.getState().descriptionDraft).toBe('Half typed')
    expect(model.store.getState().details?.description).toBe('Changed again.')
  })
})

describe('the picture', () => {
  it('writes it, and tells the list', async () => {
    const fake = gateway()
    const onChanged = vi.fn()
    const model = modelOn(fake, { onChanged })

    await model.load()

    expect(await model.setAvatar('AAAA')).toBe(true)
    expect(fake.calls.at(-1)).toEqual({
      method: 'profiles.set_asset',
      params: { name: 'writer', asset: 'avatar', data: 'AAAA' }
    })
    expect(await model.clearAvatar()).toBe(true)
    expect(fake.calls.at(-1)).toEqual({
      method: 'profiles.set_asset',
      params: { name: 'writer', asset: 'avatar', clear: true }
    })
    expect(onChanged).toHaveBeenCalledTimes(2)
  })

  it('says a refusal under the picture and resolves false', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    fake.fail('profiles.set_asset', denied())

    expect(await model.setAvatar('AAAA')).toBe(false)
    expect(model.store.getState().failures.avatar?.kind).toBe('forbidden')
    expect(model.store.getState().busy.avatar).toBeUndefined()
  })

  it('ignores a second picture while the first is on its way', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    fake.hold('profiles.set_asset')

    const first = model.setAvatar('AAAA')

    expect(await model.setAvatar('BBBB')).toBe(false)
    fake.release('profiles.set_asset')
    expect(await first).toBe(true)
    expect(fake.calls.filter(call => call.method === 'profiles.set_asset')).toHaveLength(1)
  })
})

describe('switches', () => {
  it('writes a skill as the whole DISABLED list, from what is on screen', async () => {
    const fake = gateway({ disabledSkills: ['xlsx'] })
    const model = modelOn(fake)

    await model.load()
    await model.setSkill('docx', false)

    expect(fake.configures()).toEqual([{ name: 'writer', disabled_skills: ['docx', 'xlsx'] }])
    expect(model.store.getState().details?.skills.map(skill => skill.enabled)).toEqual([true, false, false])
  })

  it('writes an MCP server as the whole ENABLED list, and asks the gateway about reloading', async () => {
    const fake = gateway()
    const model = modelOn(fake, { session: 'rt-1' })

    await model.load()
    await model.setMcpServer('github', false)

    expect(fake.configures()).toEqual([{ name: 'writer', enabled_mcp_servers: ['local'] }])
    expect(fake.calls.at(-1)).toEqual({ method: 'reload.mcp', params: { session_id: 'rt-1' } })
    expect(model.store.getState().mcpReload).toEqual({ message: 'Reply `/reload-mcp now`' })
  })

  it('says it was reloaded when the gateway does not ask', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    fake.reloadAsks(false)
    await model.load()
    await model.setMcpServer('github', false)

    expect(model.store.getState().notice).toBe('mcp_reloaded')
    expect(model.store.getState().mcpReload).toBeNull()
  })

  it('answers the gateway’s question: reload now, or always, or later', async () => {
    const fake = gateway()
    const model = modelOn(fake, { session: 'rt-1' })

    await model.load()
    await model.setMcpServer('github', false)
    await model.reloadMcp(true)

    expect(fake.calls.at(-1)).toEqual({
      method: 'reload.mcp',
      params: { confirm: true, always: true, session_id: 'rt-1' }
    })
    expect(model.store.getState()).toMatchObject({ mcpReload: null, notice: 'mcp_reloaded' })

    fake.reloadAsks(true)
    await model.setMcpServer('local', false)
    expect(model.store.getState().mcpReload).not.toBeNull()
    model.declineMcpReload()
    expect(model.store.getState().mcpReload).toBeNull()
  })

  it('writes the toolsets that are on, which pins them, and shows them pinned', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    // Unpinned: the gateway's defaults are files and web.
    expect(model.store.getState().details?.toolsets.map(toolset => toolset.enabled)).toEqual([true, true, false])
    await model.setToolset('terminal', true)

    expect(fake.configures()).toEqual([{ name: 'writer', enabled_toolsets: ['files', 'web', 'terminal'] }])
    expect(model.store.getState().details?.toolsetsPinned).toBe(true)
  })

  it('does not switch off the last toolset: nothing is sent, and it says why', async () => {
    const fake = gateway({ pinned: ['files'] })
    const model = modelOn(fake)

    await model.load()
    expect(model.canDisableToolset('files')).toBe(false)
    await model.setToolset('files', false)

    expect(fake.configures()).toEqual([])
    expect(model.store.getState().failures.toolsets?.kind).toBe('last_toolset')
    expect(model.store.getState().details?.toolsets[0]?.enabled).toBe(true)
  })

  it('puts the toolsets back to the gateway’s defaults with an empty list, and reads what those are', async () => {
    const fake = gateway({ pinned: ['terminal'] })
    const model = modelOn(fake)

    await model.load()
    expect(model.store.getState().details?.toolsetsPinned).toBe(true)
    await model.useDefaultToolsets()

    expect(fake.configures()).toEqual([{ name: 'writer', enabled_toolsets: [] }])

    const state = model.store.getState()

    expect(state.toolsetsLocked).toBe(false)
    expect(state.details?.toolsetsPinned).toBe(false)
    // Not every toolset: the defaults, read back.
    expect(state.details?.toolsets.map(toolset => toolset.enabled)).toEqual([true, true, false])
  })

  it('does nothing for a switch that is already as asked, or a name it does not know', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    await model.setSkill('pdf', true)
    await model.setSkill('nothing', false)
    await model.setMcpServer('github', true)

    expect(fake.configures()).toEqual([])
  })

  it('puts a switch back to what the gateway confirmed when the write is refused, and says so', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.fail('profiles.configure', new Error('disk full'))
    await model.setSkill('pdf', false)

    expect(model.store.getState().details?.skills[0]?.enabled).toBe(true)
    expect(model.store.getState().failures.skills).toMatchObject({ kind: 'refused', detail: 'disk full' })
    expect(model.store.getState().refused).toBe(false)
    expect(model.store.getState().busy.skills).toBeUndefined()
  })

  it('goes read-only when a switch is refused as not this account’s to make', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.fail('profiles.configure', denied())
    await model.setMcpServer('github', false)

    expect(model.store.getState().refused).toBe(true)
    expect(model.store.getState().details?.mcpServers[0]?.enabled).toBe(true)
  })

  it('coalesces switches made while a write is in flight into one more write of the latest state, in order', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.hold('profiles.configure')

    const first = model.setSkill('pdf', false)

    await flush()
    // Two more while the first waits on the gateway.
    const second = model.setSkill('docx', false)
    const third = model.setSkill('pdf', true)

    await flush()
    fake.release('profiles.configure')
    await Promise.all([first, second, third])

    // The first write held the state as it was when it left (pdf off); the second carries the rest, once.
    expect(fake.configures()).toEqual([
      { name: 'writer', disabled_skills: ['pdf'] },
      { name: 'writer', disabled_skills: ['docx'] }
    ])
    expect(model.store.getState().details?.skills.map(skill => skill.enabled)).toEqual([true, false, true])
    expect(model.store.getState().busy.skills).toBeUndefined()
  })

  it('sends one profiles.configure at a time, whatever the sections', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()

    let inFlight = 0
    let most = 0
    const original = fake.request.getMockImplementation()!

    fake.request.mockImplementation(async (method: string, params: Record<string, unknown> = {}) => {
      if (method === 'profiles.configure') {
        inFlight += 1
        most = Math.max(most, inFlight)
        await flush()
      }

      try {
        return await original(method, params)
      } finally {
        if (method === 'profiles.configure') {
          inFlight -= 1
        }
      }
    })

    model.setDescriptionDraft('New')
    await Promise.all([model.setSkill('pdf', false), model.setToolset('web', false), model.saveDescription()])

    expect(fake.configures()).toHaveLength(3)
    expect(most).toBe(1)
  })

  it('does not let a read that was already stale undo a write that landed after it was sent', async () => {
    const fake = gateway()
    const model = modelOn(fake)

    await model.load()
    fake.hold('profiles.describe')

    const stale = model.load()

    await flush()
    // The read left before this write; its answer will describe the profile from before it.
    await model.setSkill('pdf', false)
    fake.release('profiles.describe')
    await stale

    expect(model.store.getState().details?.skills[0]?.enabled).toBe(false)
  })
})
